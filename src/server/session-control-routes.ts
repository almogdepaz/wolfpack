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
  isBoundedSessionStatusIdentity,
  SESSION_STATUS_ERROR,
  SESSION_STATUS_ERROR_MESSAGE,
  SESSION_TERMINAL_STATUS,
} from "../session-status-contract.js";
import type {
  SessionInspectionResult,
  SessionStatusErrorCode,
  SessionTerminalLiveness,
} from "../session-status-contract.js";
import {
  getBackend,
  getRouter,
} from "./backend.js";
import {
  hasOptionalType,
  json,
  parseObjectBody,
} from "./http.js";
import { resolveSessionSelector } from "./session-selector.js";
import type { SessionSelectorResult } from "./session-selector.js";
import type { PublicSessionIdentity } from "./session-identity.js";
import { getTaskRelayGateway } from "../task-relay/gateway.ts";
import type { RelayEndpoint } from "../task-relay/domain.ts";
import type { RouteHandler } from "./project-settings-routes.js";

const log = createLogger("routes");

const SESSION_WAIT_DEFAULT_TIMEOUT_MS = 30_000;
const SESSION_WAIT_MAX_TIMEOUT_MS = 600_000;
const SESSION_WAIT_BUFFER_MAX_CHARS = 128 * 1024;

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

export async function resolveActiveSession(
  res: ServerResponse,
  selector: string,
): Promise<Extract<SessionSelectorResult, { readonly ok: true }> | null> {
  try {
    const backend = getBackend();
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

function sessionTerminalLiveness(name: string): SessionTerminalLiveness {
  const streaming = getRouter().getStreamingBackendForSession(name);
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

function sessionStatusPayload(name: string, identity: PublicSessionIdentity, taskEndpoint: RelayEndpoint | undefined, selector: string = name) {
  const terminal = sessionTerminalLiveness(name);
  return {
    ok: true as const,
    selector,
    session: name,
    sessionId: identity.wolfpackSessionId,
    state: "active" as const,
    project: basename(identity.projectPath),
    projectPath: identity.projectPath,
    projectDir: identity.projectPath,
    harness: identity.agentKind,
    terminal,
    ...(identity.parentSession && {
      parentSession: {
        session: identity.parentSession.wolfpackSessionName,
        sessionId: identity.parentSession.wolfpackSessionId,
      },
    }),
    ...(taskEndpoint && { taskEndpoint }),
  };
}

type SuccessfulSessionInspection = Extract<SessionInspectionResult, { readonly ok: true }>;

function inspectedSessionStatusPayload(selector: string, inspection: SuccessfulSessionInspection, taskEndpoint: RelayEndpoint | undefined) {
  const terminal: SessionTerminalLiveness = {
    exists: true,
    alive: inspection.alive,
    status: inspection.alive ? SESSION_TERMINAL_STATUS.READY : SESSION_TERMINAL_STATUS.DEAD,
  };
  return {
    ok: true as const,
    selector,
    session: inspection.session,
    sessionId: inspection.sessionId,
    state: "active" as const,
    project: basename(inspection.projectPath),
    projectPath: inspection.projectPath,
    projectDir: inspection.projectPath,
    harness: inspection.harness,
    terminal,
    ...(inspection.parentSession && { parentSession: inspection.parentSession }),
    ...(taskEndpoint && { taskEndpoint }),
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
  const streaming = getRouter().getStreamingBackendForSession(session);
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

export const sessionControlRoutes: Record<string, RouteHandler> = {
  "GET /api/session-control/list": async (_req, res) => {
    try {
      const backend = getBackend();
      const names = await backend.list();
      const identities = await backend.listIdentities?.();
      if (!identities || names.some(name => !identities[name])) {
        return json(res, { error: "session identity unavailable" }, 503);
      }
      const sessions = (await Promise.all(names.map(async (name) => {
        const identity = identities[name]!;
        return sessionStatusPayload(name, identity, await getTaskRelayGateway().endpointForSession(identity.wolfpackSessionId));
      }))).sort((left, right) => left.session.localeCompare(right.session));
      json(res, { sessions });
    } catch (error: unknown) {
      log.warn("session-control list failed", { error: errMsg(error) });
      json(res, { error: "backend unavailable" }, 503);
    }
  },

  "GET /api/session-control/status": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const selector = url.searchParams.get("session") ?? undefined;
    if (!selector) {
      return json(res, sessionStatusFailure(undefined, SESSION_STATUS_ERROR.INVALID_REQUEST), 400);
    }
    try {
      const backend = getBackend();
      const inspect = backend.inspectSession;
      if (!inspect) {
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
      const inspection = await inspect.call(backend, selector);
      if (!inspection.ok) {
        const ambiguous = inspection.code === "AMBIGUOUS";
        return json(
          res,
          sessionStatusFailure(
            selector,
            ambiguous ? SESSION_STATUS_ERROR.AMBIGUOUS : SESSION_STATUS_ERROR.NOT_FOUND,
            { exists: false, alive: false, status: SESSION_TERMINAL_STATUS.UNAVAILABLE },
          ),
          ambiguous ? 409 : 404,
        );
      }
      const status = inspectedSessionStatusPayload(selector, inspection, await getTaskRelayGateway().endpointForSession(inspection.sessionId));
      if (!inspection.alive) {
        return json(
          res,
          sessionStatusFailure(
            selector,
            SESSION_STATUS_ERROR.DEAD,
            status.terminal,
            { session: status.session, sessionId: status.sessionId },
          ),
          410,
        );
      }
      return json(res, status);
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
  },

  "GET /api/session-control/read": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const selector = url.searchParams.get("session");
    if (!selector) return json(res, { error: "missing session" }, 400);
    const resolved = await resolveActiveSession(res, selector);
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
    const resolved = await resolveActiveSession(res, selector);
    if (!resolved) return;
    try {
      await getBackend().send(resolved.name, body.text, body.noEnter === true);
      json(res, {
        ok: true,
        session: resolved.name,
        sessionId: resolved.identity.wolfpackSessionId,
      });
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
    const resolved = await resolveActiveSession(res, body.session);
    if (!resolved) return;
    const session = resolved.name;
    const sessionId = resolved.identity.wolfpackSessionId;
    const streaming = getRouter().getStreamingBackendForSession(session);
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
    const resolved = await resolveActiveSession(res, selector);
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
