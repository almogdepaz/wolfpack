import { createSessionOrganizationRoutes } from "./session-organization-routes.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { createLogger, errMsg } from "../log.js";
import {
  MAX_INITIAL_PROMPT_LENGTH,
} from "../validation.js";
import {
  SESSION_PROMPT_MAX_REQUEST_BODY_BYTES,
  SESSION_PROMPT_OUTCOME,
  SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS,
  SESSION_PROMPT_SELECTOR_MAX_CHARS,
  unicodeCodePointLength,
} from "../session-prompt-contract.js";
import {
  SESSION_SEND_DEFAULT_OBSERVE_MS,
  SESSION_SEND_DELIVERY,
  SESSION_SEND_FAILURE_REASON,
  SESSION_SEND_MAX_OBSERVE_MS,
  SESSION_SEND_OUTCOME,
  sessionSendOk,
} from "../session-send-contract.js";
import {
  isBoundedSessionStatusIdentity,
  SESSION_STATUS_ERROR,
  SESSION_STATUS_ERROR_MESSAGE,
  SESSION_TASK_RELAY_UNAVAILABLE,
  SESSION_TERMINAL_STATUS,
} from "../session-status-contract.js";
import type {
  SessionInspectionResult,
  SessionStatusErrorCode,
  SessionTaskRelayUnavailable,
  SessionTerminalLiveness,
} from "../session-status-contract.js";
import { defaultServerContext, type ServerContext } from "./context.js";
import type { SessionBackend } from "./backend-contract.js";
import {
  hasOptionalType,
  json,
  parseObjectBody,
} from "./http.js";
import { listParentNotifications, PARENT_INBOX_BOOT_ID } from "./parent-inbox.js";
import { isChildSettled, noteChildInputDelivered } from "./child-events.js";
import { ChildWaitBusyError, waitForChildren, type ChildWaitChild } from "./child-wait.js";
import { CHILD_WAIT_LIMITS, CHILD_WAIT_MODES, type ChildEventPayload, type ChildWaitMode } from "../child-event-contract.js";
import { getAgentRuntimeStateStore } from "./agent-status.js";
import { AGENT_STATUS_STATE } from "../agent-status-contract.js";
import { CHILD_CLEANUP, type ChildCleanupReport } from "../session-cascade-contract.js";
import { resolveSessionSelector } from "./session-selector.js";
import type { SessionSelectorResult } from "./session-selector.js";
import type { PublicSessionIdentity } from "./session-identity.js";
import { getTaskRelayProfile } from "../task-relay/gateway.ts";
import { isLiveTaskRelayRegistration } from "../task-relay/registration.ts";
import type { TaskRelayRegistration } from "../task-relay/registration.ts";
import type { RouteHandler } from "./route-handler.js";
import {
  SESSION_SNAPSHOT_MAX_RESPONSE_BYTES,
  SessionSnapshotBusyError,
  SessionSnapshotService,
} from "./session-snapshot.js";

const log = createLogger("routes");

const SESSION_WAIT_DEFAULT_TIMEOUT_MS = 30_000;
const SESSION_WAIT_MAX_TIMEOUT_MS = 600_000;
const SESSION_WAIT_BUFFER_MAX_CHARS = 128 * 1024;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function resolveActiveSession(
  res: ServerResponse,
  selector: string,
  backend: SessionBackend = defaultServerContext.backend,
): Promise<Extract<SessionSelectorResult, { readonly ok: true }> | null> {
  try {
    const names = await backend.list();
    const identities = await backend.listIdentities?.();
    if (!identities) {
      json(res, { error: "session identity unavailable" }, 503);
      return null;
    }
    const resolved = resolveSessionSelector(selector, names, identities);
    if (!resolved.ok) {
      json(
        res,
        {
          error: resolved.code === "AMBIGUOUS" ? "ambiguous session selector" : "session not found",
          code: resolved.code === "AMBIGUOUS" ? "AMBIGUOUS_SELECTOR" : "SESSION_NOT_FOUND",
        },
        resolved.code === "AMBIGUOUS" ? 409 : 404,
      );
      return null;
    }
    return resolved;
  } catch (error: unknown) {
    log.warn("session selector resolution failed", { error: errMsg(error) });
    json(res, { error: "backend unavailable" }, 503);
    return null;
  }
}

export function createSessionControlRoutes(ctx: ServerContext): Record<string, RouteHandler> {
const getBackend = () => ctx.backend;
const streamingBackend = () => ctx.supervisor ? ctx.supervisor.backend() : ctx.backend;
let sessionSnapshotService: SessionSnapshotService | null = null;

function snapshots(): SessionSnapshotService {
  sessionSnapshotService ??= new SessionSnapshotService((sessionId) =>
    getBackend().captureSessionSnapshotById(sessionId),
  );
  return sessionSnapshotService;
}

function snapshotErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

interface SessionPromptBody extends Record<string, unknown> {
  session: string;
  prompt: string;
  outputContains: string;
  noEnter?: boolean;
  timeoutMs?: number;
}

function isSessionPromptBody(body: Record<string, unknown>): body is SessionPromptBody {
  const allowedKeys = new Set([
    "session",
    "prompt",
    "outputContains",
    "noEnter",
    "timeoutMs",
  ]);
  if (
    !Object.keys(body).every(key => allowedKeys.has(key))
    || typeof body.session !== "string"
    || typeof body.prompt !== "string"
    || typeof body.outputContains !== "string"
    || !hasOptionalType(body, "noEnter", "boolean")
    || !hasOptionalType(body, "timeoutMs", "number")
  ) {
    return false;
  }
  const sessionLength = unicodeCodePointLength(body.session);
  const promptLength = unicodeCodePointLength(body.prompt);
  const outputContainsLength = unicodeCodePointLength(body.outputContains);
  return sessionLength > 0
    && sessionLength <= SESSION_PROMPT_SELECTOR_MAX_CHARS
    && promptLength > 0
    && promptLength <= MAX_INITIAL_PROMPT_LENGTH
    && outputContainsLength > 0
    && outputContainsLength <= SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS;
}

function parseTimeoutMs(value: unknown): number | null {
  if (value == null) return SESSION_WAIT_DEFAULT_TIMEOUT_MS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > SESSION_WAIT_MAX_TIMEOUT_MS) return null;
  return n;
}

function parseObserveMs(value: unknown): number | null {
  if (value === undefined) return SESSION_SEND_DEFAULT_OBSERVE_MS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > SESSION_SEND_MAX_OBSERVE_MS) {
    return null;
  }
  return value;
}

function sessionTerminalLiveness(name: string): SessionTerminalLiveness {
  const streaming = streamingBackend();
  if (!streaming) {
    return { exists: true, alive: false, status: SESSION_TERMINAL_STATUS.UNAVAILABLE };
  }
  const alive = streaming.isSessionAlive(name);
  return {
    exists: true,
    alive,
    status: alive ? SESSION_TERMINAL_STATUS.READY : SESSION_TERMINAL_STATUS.DEAD,
  };
}

// Registration is optional enrichment, never authority for terminal identity/liveness.
// Keep the worker's existing bounded admission and timeout/close behavior intact.
async function sessionRegistrations(sessionIds: readonly string[]): Promise<{
  registrations: ReadonlyMap<string, TaskRelayRegistration>;
  taskRelay?: SessionTaskRelayUnavailable;
}> {
  try {
    return { registrations: await ctx.taskRelayGateway.registrationsForSessions(sessionIds) };
  } catch (error: unknown) {
    log.warn("session task relay enrichment unavailable", { error: errMsg(error), recovery: SESSION_TASK_RELAY_UNAVAILABLE.recovery });
    return { registrations: new Map(), taskRelay: SESSION_TASK_RELAY_UNAVAILABLE };
  }
}

function sessionStatusPayload(name: string, identity: PublicSessionIdentity, taskTransport: TaskRelayRegistration | undefined, taskRelay?: SessionTaskRelayUnavailable, selector: string = name) {
  const terminal = sessionTerminalLiveness(name);
  return {
    ok: true as const,
    selector,
    session: name,
    sessionId: identity.wolfpackSessionId,
    organization: ctx.sessionOrganization.project(identity.wolfpackSessionId),
    state: "active" as const,
    project: basename(identity.projectPath),
    projectPath: identity.projectPath,
    projectDir: identity.projectPath,
    harness: identity.agentKind,
    terminal,
    ...(taskRelay && { taskRelay }),
    ...(identity.parentSession && {
      parentSession: {
        session: identity.parentSession.wolfpackSessionName,
        sessionId: identity.parentSession.wolfpackSessionId,
      },
    }),
    ...(terminal.alive && taskTransport && isLiveTaskRelayRegistration(taskTransport, getTaskRelayProfile()) && { taskEndpoint: taskTransport.endpoint, taskTransport }),
  };
}

type SuccessfulSessionInspection = Extract<SessionInspectionResult, { readonly ok: true }>;

function inspectedSessionStatusPayload(selector: string, inspection: SuccessfulSessionInspection, taskTransport: TaskRelayRegistration | undefined, taskRelay?: SessionTaskRelayUnavailable) {
  const terminal: SessionTerminalLiveness = {
    exists: true,
    alive: inspection.alive,
    status: inspection.alive ? SESSION_TERMINAL_STATUS.READY : SESSION_TERMINAL_STATUS.DEAD,
  };
  // Read-only: the last state the session observer reduced; status never runs an observation itself.
  const runtimeState = getAgentRuntimeStateStore().get(inspection.sessionId);
  return {
    ok: true as const,
    selector,
    session: inspection.session,
    sessionId: inspection.sessionId,
    organization: ctx.sessionOrganization.project(inspection.sessionId),
    state: "active" as const,
    project: basename(inspection.projectPath),
    projectPath: inspection.projectPath,
    projectDir: inspection.projectPath,
    harness: inspection.harness,
    terminal,
    ...(runtimeState && { runtimeState }),
    ...(taskRelay && { taskRelay }),
    ...(inspection.parentSession && { parentSession: inspection.parentSession }),
    ...(terminal.alive && taskTransport && isLiveTaskRelayRegistration(taskTransport, getTaskRelayProfile()) && { taskEndpoint: taskTransport.endpoint, taskTransport }),
  };
}

function sessionStatusFailure(
  selector: string | undefined,
  code: SessionStatusErrorCode,
  terminal?: SessionTerminalLiveness,
  identity?: { readonly session: string; readonly sessionId: string },
) {
  return {
    ok: false as const,
    ...(isBoundedSessionStatusIdentity(selector) && { selector }),
    ...(identity && { session: identity.session, sessionId: identity.sessionId }),
    ...(terminal && { terminal }),
    error: { code, message: SESSION_STATUS_ERROR_MESSAGE[code] },
  };
}

async function waitForSessionText(session: string, text: string, timeoutMs: number): Promise<"matched" | "timeout" | "unavailable"> {
  const streaming = streamingBackend();
  if (!streaming) {
    const existing = await getBackend().capturePane(session);
    return existing.includes(text) ? "matched" : "unavailable";
  }

  const decoder = new TextDecoder();
  const prefill = await streaming.getSessionPrefill(session);
  const initial = decoder.decode(prefill.data);
  if (initial.includes(text)) return "matched";
  if (prefill.seq === undefined) return "unavailable";

  return await new Promise((resolve) => {
    let done = false;
    let buffer = initial.slice(-SESSION_WAIT_BUFFER_MAX_CHARS);
    let unsubscribe: (() => void) | null = null;
    const finish = (result: "matched" | "timeout" | "unavailable") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { unsubscribe?.(); } catch { /* cleanup best effort */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    unsubscribe = streaming.onSessionData(session, (data) => {
      buffer += decoder.decode(data, { stream: true });
      if (buffer.length > SESSION_WAIT_BUFFER_MAX_CHARS) {
        buffer = buffer.slice(-SESSION_WAIT_BUFFER_MAX_CHARS);
      }
      if (buffer.includes(text)) finish("matched");
    }, {
      sinceSeq: prefill.seq,
      onSubscribeError: () => finish("unavailable"),
    });
    if (!unsubscribe) finish("unavailable");
  });
}

/**
 * Resolve a selector to a live session, or write the status failure envelope
 * (503 no inspection, 404/409 not found/ambiguous, 410 dead) and return null.
 * A backend error propagates to the caller.
 */
async function inspectLiveSession(res: ServerResponse, selector: string): Promise<SuccessfulSessionInspection | null> {
  const backend = getBackend();
  const inspect = backend.inspectSession;
  if (!inspect) {
    json(
      res,
      sessionStatusFailure(
        selector,
        SESSION_STATUS_ERROR.BACKEND_UNAVAILABLE,
        { exists: false, alive: false, status: SESSION_TERMINAL_STATUS.UNAVAILABLE },
      ),
      503,
    );
    return null;
  }
  const inspection = await inspect.call(backend, selector);
  if (!inspection.ok) {
    const ambiguous = inspection.code === "AMBIGUOUS";
    json(
      res,
      sessionStatusFailure(
        selector,
        ambiguous ? SESSION_STATUS_ERROR.AMBIGUOUS : SESSION_STATUS_ERROR.NOT_FOUND,
        { exists: false, alive: false, status: SESSION_TERMINAL_STATUS.UNAVAILABLE },
      ),
      ambiguous ? 409 : 404,
    );
    return null;
  }
  if (!inspection.alive) {
    json(
      res,
      sessionStatusFailure(
        selector,
        SESSION_STATUS_ERROR.DEAD,
        { exists: true, alive: false, status: SESSION_TERMINAL_STATUS.DEAD },
        { session: inspection.session, sessionId: inspection.sessionId },
      ),
      410,
    );
    return null;
  }
  return inspection;
}

/** The live children of a parent, sorted by name. Exited children are not listed. */
async function liveChildren(parentSessionId: string): Promise<Array<ChildWaitChild & { readonly cleanup: ChildCleanupReport }>> {
  const backend = getBackend();
  const names = await backend.list();
  const identities = await backend.listIdentities?.();
  if (!identities) throw new Error("session identity unavailable");
  return names.flatMap((name) => {
    const identity = identities[name];
    if (identity?.parentSession?.wolfpackSessionId !== parentSessionId || !sessionTerminalLiveness(name).alive) return [];
    return [{
      session: name,
      sessionId: identity.wolfpackSessionId,
      settled: isChildSettled(identity.wolfpackSessionId),
      cleanup: identity.parentSession.cleanup ?? CHILD_CLEANUP.NONE,
    }];
  }).sort((left, right) => left.session.localeCompare(right.session));
}

/** The newest child event of each child in the parent inbox. */
function lastChildEvents(parentSessionId: string): Map<string, ChildEventPayload> {
  const last = new Map<string, ChildEventPayload>();
  for (const entry of listParentNotifications(parentSessionId)) {
    if (entry.childEvent) last.set(entry.childEvent.childSessionId, entry.childEvent);
  }
  return last;
}

function parseChildWaitQuery(url: URL): { mode: ChildWaitMode; timeoutMs: number; since?: number; bootId?: string } | null {
  const mode = url.searchParams.get("children");
  const timeoutRaw = url.searchParams.get("timeoutMs");
  const sinceRaw = url.searchParams.get("since");
  const bootId = url.searchParams.get("bootId");
  if (!CHILD_WAIT_MODES.includes(mode as ChildWaitMode)) return null;
  const timeoutMs = timeoutRaw === null ? CHILD_WAIT_LIMITS.DEFAULT_TIMEOUT_MS : Number(timeoutRaw);
  if (timeoutRaw !== null && !/^\d+$/.test(timeoutRaw)) return null;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CHILD_WAIT_LIMITS.MAX_TIMEOUT_MS) return null;
  const since = sinceRaw === null ? undefined : Number(sinceRaw);
  if (sinceRaw !== null && (!/^\d+$/.test(sinceRaw) || !Number.isSafeInteger(since))) return null;
  if (bootId !== null && (bootId.length === 0 || bootId.length > 100)) return null;
  return { mode: mode as ChildWaitMode, timeoutMs, ...(since !== undefined && { since }), ...(bootId !== null && { bootId }) };
}

async function inspectSessionRoute(req: IncomingMessage, res: ServerResponse, inbox = false): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    const url = new URL(req.url ?? "/", "http://localhost");
    const selector = url.searchParams.get("session") ?? undefined;
    const sinceRaw = url.searchParams.get("since");
    const since = sinceRaw === null ? undefined : Number(sinceRaw);
    if (!selector || (inbox && sinceRaw !== null && (!/^\d+$/.test(sinceRaw) || !Number.isSafeInteger(since) || (since ?? 0) < 0))) {
      return json(res, sessionStatusFailure(undefined, SESSION_STATUS_ERROR.INVALID_REQUEST), 400);
    }
    try {
      const inspection = await inspectLiveSession(res, selector);
      if (!inspection) return;
      if (inbox) {
        return json(res, { session: inspection.session, sessionId: inspection.sessionId, bootId: PARENT_INBOX_BOOT_ID, notifications: listParentNotifications(inspection.sessionId, since) });
      }
      const relay = await sessionRegistrations([inspection.sessionId]);
      return json(res, inspectedSessionStatusPayload(selector, inspection, relay.registrations.get(inspection.sessionId), relay.taskRelay));
    } catch (error: unknown) {
      log.warn("session status inspection failed", { error: errMsg(error) });
      return json(
        res,
        sessionStatusFailure(
          selector,
          SESSION_STATUS_ERROR.BACKEND_UNAVAILABLE,
          { exists: false, alive: false, status: SESSION_TERMINAL_STATUS.UNAVAILABLE },
        ),
        503,
      );
    }
}

return {
  ...createSessionOrganizationRoutes(ctx),
  "GET /api/session-control/list": async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const backend = getBackend();
      const names = await backend.list();
      const identities = await backend.listIdentities?.();
      if (!identities || names.some(name => !identities[name])) {
        return json(res, { error: "session identity unavailable" }, 503);
      }
      if (names.length === 0) return json(res, { sessions: [] });
      const relay = await sessionRegistrations(names.map(name => identities[name]!.wolfpackSessionId));
      const sessions = names.map((name) => {
        const identity = identities[name]!;
        return sessionStatusPayload(name, identity, relay.registrations.get(identity.wolfpackSessionId), relay.taskRelay);
      }).sort((left, right) => left.session.localeCompare(right.session));
      json(res, { sessions });
    } catch (error: unknown) {
      log.warn("session-control list failed", { error: errMsg(error) });
      json(res, { error: "backend unavailable" }, 503);
    }
  },

  "GET /api/session-control/status": (req, res) => inspectSessionRoute(req, res),
  "GET /api/session-control/inbox": (req, res) => inspectSessionRoute(req, res, true),

  "GET /api/session-control/children": async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const selector = new URL(req.url ?? "/", "http://localhost").searchParams.get("session");
    if (!selector) return json(res, sessionStatusFailure(undefined, SESSION_STATUS_ERROR.INVALID_REQUEST), 400);
    try {
      const parent = await inspectLiveSession(res, selector);
      if (!parent) return;
      const lastEvents = lastChildEvents(parent.sessionId);
      const store = getAgentRuntimeStateStore();
      const children = (await liveChildren(parent.sessionId)).map((child) => {
        const runtimeState = store.get(child.sessionId);
        const lastEvent = lastEvents.get(child.sessionId);
        return {
          session: child.session,
          sessionId: child.sessionId,
          state: runtimeState?.state ?? AGENT_STATUS_STATE.UNKNOWN,
          ...(runtimeState && { authority: runtimeState.authority, stale: runtimeState.stale }),
          settled: child.settled,
          cleanup: child.cleanup,
          ...(lastEvent && { lastEvent }),
        };
      });
      return json(res, { ok: true, session: parent.session, sessionId: parent.sessionId, bootId: PARENT_INBOX_BOOT_ID, children });
    } catch (error: unknown) {
      log.warn("session children read failed", { error: errMsg(error) });
      return json(res, sessionStatusFailure(selector, SESSION_STATUS_ERROR.BACKEND_UNAVAILABLE), 503);
    }
  },

  "GET /api/session-control/children/wait": async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const url = new URL(req.url ?? "/", "http://localhost");
    const selector = url.searchParams.get("session");
    const query = parseChildWaitQuery(url);
    if (!selector) return json(res, sessionStatusFailure(undefined, SESSION_STATUS_ERROR.INVALID_REQUEST), 400);
    if (!query) {
      return json(res, {
        error: `children must be any or all; timeoutMs an integer from 1 to ${CHILD_WAIT_LIMITS.MAX_TIMEOUT_MS}; since a non-negative integer; bootId 1-100 characters`,
        code: SESSION_STATUS_ERROR.INVALID_REQUEST,
      }, 400);
    }
    // The client can go away during a long wait: stop waiting and write nothing.
    const closed = new AbortController();
    res.on("close", () => closed.abort());
    try {
      const parent = await inspectLiveSession(res, selector);
      if (!parent) return;
      const result = await waitForChildren({
        parentSessionId: parent.sessionId,
        ...query,
        listChildren: () => liveChildren(parent.sessionId),
        signal: closed.signal,
      });
      if (!result) return;
      return json(res, { ok: true, session: parent.session, sessionId: parent.sessionId, children: query.mode, ...result });
    } catch (error: unknown) {
      if (closed.signal.aborted) return;
      if (error instanceof ChildWaitBusyError) {
        res.setHeader("Retry-After", "5");
        return json(res, { error: error.message, code: "CHILD_WAIT_BUSY" }, 429);
      }
      log.warn("session children wait failed", { error: errMsg(error) });
      return json(res, sessionStatusFailure(selector, SESSION_STATUS_ERROR.BACKEND_UNAVAILABLE), 503);
    }
  },

  "GET /api/session-control/snapshot": async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
      return json(res, { error: "full sessionId UUID required" }, 400);
    }
    try {
      const snapshot = await snapshots().read(sessionId);
      if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > SESSION_SNAPSHOT_MAX_RESPONSE_BYTES) {
        return json(res, { error: "snapshot response unavailable" }, 503);
      }
      return json(res, snapshot);
    } catch (error: unknown) {
      if (error instanceof SessionSnapshotBusyError) {
        res.setHeader("Retry-After", "1");
        return json(res, { error: "snapshot busy" }, 503);
      }
      const code = snapshotErrorCode(error);
      if (code === "unknown_session") return json(res, { error: "session not found" }, 404);
      if (code === "session_not_alive") return json(res, { error: "session is not alive" }, 410);
      log.warn("session snapshot failed", { sessionId, error: errMsg(error) });
      return json(res, { error: "snapshot unavailable" }, 503);
    }
  },

  "GET /api/session-control/read": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const selector = url.searchParams.get("session");
    if (!selector) return json(res, { error: "missing session" }, 400);
    const resolved = await resolveActiveSession(res, selector, ctx.backend);
    if (!resolved) return;
    try {
      const output = await getBackend().capturePane(resolved.name);
      json(res, {
        session: resolved.name,
        sessionId: resolved.identity.wolfpackSessionId,
        output,
      });
    } catch (e: unknown) {
      log.warn("session-control read failed", { session: resolved.name, error: errMsg(e) });
      json(res, { error: "backend unavailable" }, 503);
    }
  },

  "POST /api/session-control/send": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    const selector = body.session;
    if (typeof selector !== "string" || !selector) return json(res, { error: "missing session" }, 400);
    if (typeof body.text !== "string") return json(res, { error: "missing text" }, 400);
    if (!hasOptionalType(body, "noEnter", "boolean")) return json(res, { error: "noEnter must be a boolean" }, 400);
    if (!hasOptionalType(body, "ensureSubmitted", "boolean")) {
      return json(res, { error: "ensureSubmitted must be a boolean" }, 400);
    }
    const observeMs = parseObserveMs(body.observeMs);
    if (observeMs === null) {
      return json(res, { error: `observeMs must be an integer from 1 to ${SESSION_SEND_MAX_OBSERVE_MS}` }, 400);
    }
    const resolved = await resolveActiveSession(res, selector, ctx.backend);
    if (!resolved) return;
    const session = resolved.name;
    const sessionId = resolved.identity.wolfpackSessionId;
    const noEnter = body.noEnter === true;
    // A task written with Enter arms the child's heuristic `busy → idle` done event.
    const armChild = () => noteChildInputDelivered(sessionId, session, resolved.identity.parentSession);
    try {
      const streaming = streamingBackend();
      if (!streaming) {
        // Nothing to observe through: deliver as before and say so.
        await getBackend().send(session, body.text, noEnter);
        if (!noEnter) armChild();
        return json(res, {
          ok: true,
          session,
          sessionId,
          delivery: SESSION_SEND_DELIVERY.UNVERIFIED,
          outcome: SESSION_SEND_OUTCOME.UNVERIFIED,
          observedMs: 0,
        });
      }
      const result = await streaming.sendAndObserveSubmission(sessionId, {
        text: body.text,
        noEnter,
        observeMs,
        ensureSubmitted: body.ensureSubmitted === true,
        sessionName: session,
        onSubmitWritten: armChild,
      });
      if (result.reason === SESSION_SEND_FAILURE_REASON.BACKEND_UNAVAILABLE) {
        // Same status a failed write always had; the body says nothing was written.
        return json(res, { ok: false, error: "backend unavailable", session, sessionId, ...result }, 503);
      }
      const ok = sessionSendOk(noEnter, result.outcome);
      json(res, { ok, session, sessionId, ...result });
    } catch (e: unknown) {
      log.warn("session-control send failed", { session: resolved.name, error: errMsg(e) });
      json(res, { error: "backend unavailable" }, 503);
    }
  },

  "POST /api/session-control/prompt": async (req, res) => {
    const body = await parseObjectBody(req, res, {
      maxBytes: SESSION_PROMPT_MAX_REQUEST_BODY_BYTES,
      respondOnTooLarge: true,
    });
    if (!body) return;
    if (!isSessionPromptBody(body)) {
      return json(res, { error: "invalid session prompt request" }, 400);
    }
    const timeoutMs = parseTimeoutMs(body.timeoutMs);
    if (timeoutMs === null) {
      return json(res, {
        error: `timeoutMs must be an integer from 1 to ${SESSION_WAIT_MAX_TIMEOUT_MS}`,
      }, 400);
    }
    const resolved = await resolveActiveSession(res, body.session, ctx.backend);
    if (!resolved) return;
    const session = resolved.name;
    const sessionId = resolved.identity.wolfpackSessionId;
    const streaming = streamingBackend();
    if (!streaming) {
      return json(res, {
        ok: false,
        session,
        sessionId,
        outcome: SESSION_PROMPT_OUTCOME.BACKEND_UNAVAILABLE,
        outputBoundarySeq: null,
      });
    }
    try {
      const result = await streaming.promptAndWaitForOutput(sessionId, {
        prompt: body.prompt,
        outputContains: body.outputContains,
        noEnter: body.noEnter === true,
        timeoutMs,
        sessionName: session,
      });
      json(res, {
        ok: result.outcome === SESSION_PROMPT_OUTCOME.MATCHED,
        session,
        sessionId,
        ...result,
      });
    } catch (error: unknown) {
      log.warn("session-control prompt failed", { session, sessionId, error: errMsg(error) });
      json(res, {
        ok: false,
        session,
        sessionId,
        outcome: SESSION_PROMPT_OUTCOME.BACKEND_UNAVAILABLE,
        outputBoundarySeq: null,
      });
    }
  },

  "POST /api/session-control/wait": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    const selector = body.session;
    if (typeof selector !== "string" || !selector) return json(res, { error: "missing session" }, 400);
    if (typeof body.text !== "string" || body.text.length === 0) {
      return json(res, { error: "missing text" }, 400);
    }
    if (!hasOptionalType(body, "timeoutMs", "number")) {
      return json(res, { error: "timeoutMs must be a number" }, 400);
    }
    const timeoutMs = parseTimeoutMs(body.timeoutMs);
    if (timeoutMs === null) {
      return json(res, { error: `timeoutMs must be an integer from 1 to ${SESSION_WAIT_MAX_TIMEOUT_MS}` }, 400);
    }
    const resolved = await resolveActiveSession(res, selector, ctx.backend);
    if (!resolved) return;
    try {
      const result = await waitForSessionText(resolved.name, body.text, timeoutMs);
      const session = resolved.name;
      const sessionId = resolved.identity.wolfpackSessionId;
      if (result === "matched") return json(res, { ok: true, session, sessionId, matched: true });
      if (result === "timeout") return json(res, { error: "timeout", session, sessionId, matched: false }, 408);
      return json(res, { error: "backend unavailable" }, 503);
    } catch (e: unknown) {
      log.warn("session-control wait failed", { session: resolved.name, error: errMsg(e) });
      json(res, { error: "backend unavailable" }, 503);
    }
  },
};
}
export const sessionControlRoutes = createSessionControlRoutes(defaultServerContext);
