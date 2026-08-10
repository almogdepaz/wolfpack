/**
 * HTTP route handlers.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { basename, join } from "node:path";
import { hostname, homedir } from "node:os";
import { execFile } from "node:child_process";
import { AGENT_KIND, isCreatableHarness } from "../agent-kind.js";
import { createLogger, errMsg } from "../log.js";
import { detectProviderReadiness } from "../provider-readiness.js";
import {
  CMD_REGEX,
  MAX_INITIAL_PROMPT_LENGTH,
  isValidProjectName,
  isValidSessionName,
  SAFE_FILENAME,
  clampCols,
  clampRows,
} from "../validation.js";

import { assets } from "../public-assets.js";
import { getAgentRuntimeStateStore } from "./agent-status.js";
import { getVapidPublicKey, addSubscription, removeSubscription, sendPush, validateSubscription, checkNotifyRateLimit, getSubscriptionCount, buildAgentNotificationPayload, type PushSubscription } from "./push.js";
import pkg from "../../package.json";
import { issueWebSocketTicket } from "./ws-ticket.js";
import {
  boundedMetrics,
  classifyRequestClient,
  operationalHealth,
  prometheusMetrics,
} from "./operability.js";

const log = createLogger("routes");
import { DEV_DIR } from "./dev-dir.js";
import { validateProjectDir as validateProjectDirPure } from "./validate-project-dir.js";
import { resolveExistingProjectSelection } from "./project-selection.js";
import type { ResolveProjectSelectionResult } from "./project-selection.js";
import {
  getBackend,
  getRouter,
  DuplicateSessionError,
} from "./backend.js";
import {
  SESSION_PROMPT_MAX_REQUEST_BODY_BYTES,
  SESSION_PROMPT_OUTCOME,
  SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS,
  SESSION_PROMPT_SELECTOR_MAX_CHARS,
  unicodeCodePointLength,
} from "../session-prompt-contract.js";


// ── Constants ──
const SESSION_WAIT_DEFAULT_TIMEOUT_MS = 30_000;
const SESSION_WAIT_MAX_TIMEOUT_MS = 600_000;
const SESSION_WAIT_BUFFER_MAX_CHARS = 128 * 1024;

/** Validate project name param. Returns project string or sends 400 and returns null. */
function validateProject(res: ServerResponse, project: string | null | undefined): project is string {
  if (!project || !isValidProjectName(project)) {
    json(res, { error: "invalid project" }, 400);
    return false;
  }
  return true;
}

function listDevProjects(): string[] {
  try {
    return readdirSync(DEV_DIR)
      .filter((entry) => {
        if (entry.startsWith(".")) return false;
        try {
          return statSync(join(DEV_DIR, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

import {
  uniqueSessionName,
  isAllowedSession,
  json,
  parseBody,
  serveFile,
  enumerateLocalTailnetCandidates,
  getLocalMachineHandshake,
} from "./http.js";
import type { InvalidBodyResponse, ParseBodyOptions } from "./http.js";
import { activePtySessions, notifySubSessionOpened, teardownPty } from "./websocket.js";
import { inferAgentKind } from "./session-identity.js";
import type { ParentSessionIdentity, PublicSessionIdentity } from "./session-identity.js";
import {
  forgetSessionObservation,
  observeDashboardSessions,
  resetNotificationObservation,
} from "./session-observation.js";
export {
  __resetSessionObservationForTests,
  __runSessionNotificationObservationForTests,
} from "./session-observation.js";
import {
  SESSION_OPEN_ERROR,
  SESSION_OPEN_HTTP_STATUS,
} from "../session-open-contract.js";
import { openSubSession, SessionOpenError } from "./session-open.js";
import { SESSION_CREATE_ERROR } from "../session-create-contract.js";
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
import { createTopLevelSession } from "./session-create.js";
import { resolveSessionSelector } from "./session-selector.js";
import type { SessionSelectorResult } from "./session-selector.js";
import { taskRoutes } from "./task-routes.ts";
import { taskRelayRoutes } from "./task-relay-routes.ts";
import { getTaskRelayGateway } from "../task-relay/gateway.ts";
import type { RelayEndpoint } from "../task-relay/domain.ts";
import { getTaskGateway } from "../tasks/gateway.ts";

const SESSION_OPEN_INVALID_BODY_RESPONSE = {
  envelope: {
    error: "invalid session-open request",
    code: SESSION_OPEN_ERROR.INVALID_REQUEST,
  },
  status: SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.INVALID_REQUEST],
} as const satisfies InvalidBodyResponse;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseObjectBody(
  req: IncomingMessage,
  res: ServerResponse,
  options: ParseBodyOptions = {},
): Promise<Record<string, unknown> | null> {
  const body = await parseBody(req, res, options);
  if (body === undefined) return null;
  if (!isJsonObject(body)) {
    json(
      res,
      options.invalidResponse?.envelope ?? { error: "JSON body must be an object" },
      options.invalidResponse?.status ?? 400,
    );
    return null;
  }
  return body;
}

function hasOptionalType(
  body: Record<string, unknown>,
  key: string,
  type: "string" | "number" | "boolean",
): boolean {
  return body[key] === undefined || typeof body[key] === type;
}

interface CreateBody extends Record<string, unknown> {
  project?: string;
  projectDir?: string;
  newProject?: string;
  cmd?: string;
  sessionName?: string;
  parentSession?: string;
  initialPrompt?: string;
}

function isCreateBody(body: Record<string, unknown>): body is CreateBody {
  return ["project", "projectDir", "newProject", "cmd", "sessionName", "parentSession", "initialPrompt"].every(
    key => hasOptionalType(body, key, "string"),
  );
}

interface SessionCreateBody extends Record<string, unknown> {
  project?: string;
  projectDir?: string;
  harness?: string;
  initialPrompt?: string;
}

function isSessionCreateBody(body: Record<string, unknown>): body is SessionCreateBody {
  const allowedKeys = new Set(["project", "projectDir", "harness", "initialPrompt"]);
  return Object.keys(body).every(key => allowedKeys.has(key))
    && hasOptionalType(body, "project", "string")
    && hasOptionalType(body, "projectDir", "string")
    && hasOptionalType(body, "harness", "string")
    && hasOptionalType(body, "initialPrompt", "string");
}

interface SessionOpenBody extends Record<string, unknown> {
  project?: string;
  projectDir?: string;
  parentSession: string;
  sessionName?: string;
  initialPrompt?: string;
}

function isSessionOpenBody(body: Record<string, unknown>): body is SessionOpenBody {
  const allowedKeys = new Set(["project", "projectDir", "parentSession", "sessionName", "initialPrompt"]);
  return Object.keys(body).every(key => allowedKeys.has(key))
    && hasOptionalType(body, "project", "string")
    && hasOptionalType(body, "projectDir", "string")
    && typeof body.parentSession === "string"
    && hasOptionalType(body, "sessionName", "string")
    && hasOptionalType(body, "initialPrompt", "string");
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

interface SettingsBody extends Record<string, unknown> {
  agentCmd?: string;
  addCmd?: string;
  removeCmd?: string;
  setCmdEnabled?: { cmd: string; enabled: boolean };
}

interface AgentRuntimeAckBody extends Record<string, unknown> {
  sessionId: string;
  transitionSequence: number;
}

function isAgentRuntimeAckBody(body: Record<string, unknown>): body is AgentRuntimeAckBody {
  const allowedKeys = new Set(["sessionId", "transitionSequence"]);
  return Object.keys(body).every(key => allowedKeys.has(key))
    && typeof body.sessionId === "string"
    && body.sessionId.length > 0
    && typeof body.transitionSequence === "number"
    && Number.isInteger(body.transitionSequence)
    && body.transitionSequence > 0;
}

function isSettingsBody(body: Record<string, unknown>): body is SettingsBody {
  if (!["agentCmd", "addCmd", "removeCmd"].every(key => hasOptionalType(body, key, "string"))) {
    return false;
  }
  return body.setCmdEnabled === undefined || (
    isJsonObject(body.setCmdEnabled) &&
    typeof body.setCmdEnabled.cmd === "string" &&
    typeof body.setCmdEnabled.enabled === "boolean"
  );
}

type ProjectSelectionFailure = Extract<ResolveProjectSelectionResult, { readonly ok: false }>;

function projectDirectoryHttpStatus(code: ProjectSelectionFailure["code"]): 400 | 404 | 503 {
  if (code === "not_found") return 404;
  if (code === "unavailable") return 503;
  return 400;
}

/** Validate project name + directory in one call. Returns resolved path or sends error and returns null. */
function resolveProjectDir(res: ServerResponse, project: string | null | undefined): string | null {
  if (!validateProject(res, project)) return null;
  const selection = resolveExistingProjectSelection({ project });
  if (selection.ok) return selection.value.projectDir;
  json(res, { error: selection.error }, projectDirectoryHttpStatus(selection.code));
  return null;
}

function parseTimeoutMs(value: unknown): number | null {
  if (value == null) return SESSION_WAIT_DEFAULT_TIMEOUT_MS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > SESSION_WAIT_MAX_TIMEOUT_MS) return null;
  return n;
}

async function resolveActiveSession(
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

const VERSION: string = pkg.version;
/** Tests override this with WOLFPACK_SETTINGS_PATH so loadSettings/saveSettings
 *  hit a temp file instead of the user's real ~/.wolfpack/bridge-settings.json.
 *  Resolved at every call so test setup that mutates env mid-process is honored. */
function settingsPath(): string {
  return process.env.WOLFPACK_SETTINGS_PATH || join(homedir(), ".wolfpack", "bridge-settings.json");
}

/**
 * Default agent commands shown in a fresh install. Order matters — it's
 * the order they appear in the settings list and the session-create picker.
 * `shell` is the always-on fallback when nothing is enabled, so it sits
 * first.
 */
const DEFAULT_CMDS: ReadonlyArray<{ cmd: string; enabled: boolean }> = [
  { cmd: AGENT_KIND.SHELL, enabled: true },
  { cmd: AGENT_KIND.CLAUDE, enabled: true },
  { cmd: AGENT_KIND.PI, enabled: true },
  { cmd: AGENT_KIND.CODEX, enabled: true },
];

interface CmdEntry {
  cmd: string;
  enabled: boolean;
}

interface Settings {
  /** User's selected default agent for new sessions. May be disabled or absent
   *  from `cmds`; `effectiveAgentCmd()` resolves the actual fallback. */
  agentCmd: string;
  /** Full list of known commands. Each toggleable independently. */
  cmds: CmdEntry[];
}

/** A command is valid if it's literally `"shell"` or matches CMD_REGEX. */
function isValidCmd(cmd: string): boolean {
  return cmd === AGENT_KIND.SHELL || CMD_REGEX.test(cmd);
}

export function loadSettings(): Settings {
  let raw: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch { /* expected: settings file doesn't exist yet */ }

  const agentCmd = raw && typeof raw.agentCmd === "string" && isValidCmd(raw.agentCmd)
    ? raw.agentCmd
    : "shell";

  // A persisted `cmds` array is authoritative, including an explicitly empty
  // array. Synthesizing built-ins would undo the user's explicit configuration.
  if (raw && Array.isArray(raw.cmds)) {
    const cmds: CmdEntry[] = [];
    const seen = new Set<string>();
    for (const entry of raw.cmds as unknown[]) {
      if (!entry || typeof entry !== "object") continue;
      const obj = entry as Record<string, unknown>;
      if (typeof obj.cmd !== "string" || !isValidCmd(obj.cmd) || seen.has(obj.cmd)) continue;
      seen.add(obj.cmd);
      cmds.push({ cmd: obj.cmd, enabled: obj.enabled !== false });
    }
    return { agentCmd, cmds };
  }

  // Legacy settings still receive the session-picker defaults.
  const cmds: CmdEntry[] = DEFAULT_CMDS.map(c => ({ ...c }));
  const seen = new Set(cmds.map(c => c.cmd));
  if (raw && Array.isArray(raw.customCmds)) {
    for (const command of raw.customCmds as unknown[]) {
      if (typeof command !== "string" || !isValidCmd(command)) continue;
      if (seen.has(command)) continue;
      seen.add(command);
      cmds.push({ cmd: command, enabled: true });
    }
  }
  return { agentCmd, cmds };
}

function saveSettings(s: Settings): void {
  // Persist exactly what we expose in the API response — a clean { agentCmd, cmds }
  // object. Drop any legacy keys (customCmds) that may still be in the file.
  writeFileSync(settingsPath(), JSON.stringify({ agentCmd: s.agentCmd, cmds: s.cmds }, null, 2));
}

/** Resolve the agent that should actually run for a new session.
 *  Priority: settings.agentCmd if it's enabled → first enabled cmd → shell. */
export function effectiveAgentCmd(s: Settings): string {
  const enabled = s.cmds.filter(c => c.enabled);
  const requested = enabled.find(c => c.cmd === s.agentCmd);
  if (requested) return requested.cmd;
  if (enabled.length > 0) return enabled[0].cmd;
  return AGENT_KIND.SHELL;
}

/** What the session-create picker should show: enabled cmds, or ["shell"] if
 *  the user has disabled everything (always-on fallback). */
export function effectiveCmds(s: Settings): string[] {
  const enabled = s.cmds.filter(c => c.enabled).map(c => c.cmd);
  return enabled.length > 0 ? enabled : [AGENT_KIND.SHELL];
}

export const routes: Record<
  string,
  (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
> = {
  "GET /": (req, res) => serveFile(res, "index.html", req),
  "GET /manifest.json": (req, res) => {
    const asset = assets.get("manifest.json");
    if (!asset) { res.writeHead(404); res.end("Not Found"); return; }
    const url = new URL(req.url ?? "/", "http://localhost");
    const customName = url.searchParams.get("name");
    const host = (req.headers.host ?? "localhost").replace(/[:.]/g, "-");
    const manifest = JSON.parse(asset.content as string);
    manifest.id = `/?host=${host}`;
    if (customName) {
      const safeName = customName.replace(/[^\w\s\-().]/g, "").slice(0, 50);
      manifest.name = safeName;
      manifest.short_name = safeName;
    } else {
      const label = host.split("-").slice(0, -1).join("-") || host;
      manifest.name = `Wolfpack (${label})`;
      manifest.short_name = label;
    }
    res.writeHead(200, { "Content-Type": "application/manifest+json" });
    res.end(JSON.stringify(manifest, null, 2));
  },

  "GET /api/info": (_req, res) => {
    const name = hostname()
      .replace(/\.local$/, "")
      .replace(/\.tail[a-z0-9-]*\.ts\.net$/i, "");
    json(res, { name, version: VERSION, machineId: getTaskGateway().machineId });
  },

  "GET /api/machine": async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const handshake = await getLocalMachineHandshake(VERSION);
    if (!handshake) return json(res, { error: "tailnet machine identity unavailable" }, 503);
    json(res, handshake);
  },

  "GET /api/sessions": async (_req, res) => {
    json(res, { sessions: await observeDashboardSessions() });
  },

  "POST /api/agent-runtime-state/ack": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (!isAgentRuntimeAckBody(body)) {
      return json(res, { error: "sessionId and positive integer transitionSequence required" }, 400);
    }
    const runtimeState = getAgentRuntimeStateStore().acknowledge(body.sessionId, body.transitionSequence);
    if (!runtimeState) return json(res, { error: "runtime state not found" }, 404);
    json(res, { ok: true, runtimeState });
  },

  "GET /api/projects": async (_req, res) => {
    const projects = listDevProjects();
    json(res, { projects });
  },

  "GET /api/next-session-name": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project") ?? undefined;
    const projectDir = url.searchParams.get("projectDir") ?? undefined;
    const selection = resolveExistingProjectSelection({ project, projectDir });
    if (!selection.ok) {
      json(res, { error: selection.error }, projectDirectoryHttpStatus(selection.code));
      return;
    }
    const name = await uniqueSessionName(selection.value.project);
    json(res, { name });
  },

  "POST /api/create": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (!isCreateBody(body)) {
      return json(res, {
        error: "project, projectDir, newProject, cmd, sessionName, parentSession, and initialPrompt must be strings",
      }, 400);
    }
    const { project, projectDir: requestedProjectDir, newProject, cmd, sessionName, parentSession, initialPrompt } = body;
    if (requestedProjectDir !== undefined && (project !== undefined || newProject !== undefined)) {
      return json(res, { error: "invalid project selection" }, 400);
    }
    if (cmd && cmd !== AGENT_KIND.SHELL && !CMD_REGEX.test(cmd)) {
      return json(res, { error: "invalid characters in command" }, 400);
    }
    if (
      initialPrompt !== undefined
      && (!initialPrompt.trim()
        || unicodeCodePointLength(initialPrompt) > MAX_INITIAL_PROMPT_LENGTH)
    ) {
      return json(res, {
        error: `initial prompt must be 1..${MAX_INITIAL_PROMPT_LENGTH} characters`,
      }, 400);
    }
    const parentName = parentSession?.trim();
    let parentIdentity: ParentSessionIdentity | undefined;
    if (parentSession !== undefined) {
      if (!parentName || !isValidSessionName(parentName)) {
        return json(res, { error: "invalid parent session" }, 400);
      }
      if (!(await isAllowedSession(parentName))) {
        return json(res, {
          error: "parent session not found",
          code: SESSION_OPEN_ERROR.PARENT_SESSION_NOT_FOUND,
        }, 404);
      }
      const activeParentIdentity = (await getBackend().listIdentities?.())?.[parentName];
      if (!activeParentIdentity) {
        return json(res, {
          error: "parent session identity unavailable",
          code: SESSION_OPEN_ERROR.PARENT_IDENTITY_UNAVAILABLE,
        }, 503);
      }
      parentIdentity = {
        wolfpackSessionId: activeParentIdentity.wolfpackSessionId,
        wolfpackSessionName: activeParentIdentity.wolfpackSessionName,
      };
    }
    const customName = sessionName?.trim();
    if (customName) {
      if (!isValidSessionName(customName)) {
        return json(res, { error: "invalid session name (letters, numbers, hyphens, underscores only)" }, 400);
      }
      const existing = await getBackend().list();
      if (existing.includes(customName)) {
        return json(res, { error: "session name already taken" }, 409);
      }
    }
    let projectSelection: { readonly project: string; readonly projectDir: string };
    if (newProject !== undefined) {
      const folderName = newProject.trim();
      if (!validateProject(res, folderName)) return;
      const rootedProjectDir = join(DEV_DIR, folderName);
      try { mkdirSync(rootedProjectDir, { recursive: true }); } catch (e: unknown) {
        log.error("/api/create: failed to create project directory", { path: rootedProjectDir, error: errMsg(e) });
      }
      const validation = validateProjectDirPure(rootedProjectDir);
      if (!validation.ok) {
        json(res, { error: validation.error }, projectDirectoryHttpStatus(validation.code));
        return;
      }
      projectSelection = { project: folderName, projectDir: validation.projectDir };
    } else {
      const selection = resolveExistingProjectSelection({
        ...(project !== undefined && { project: project.trim() }),
        ...(requestedProjectDir !== undefined && { projectDir: requestedProjectDir }),
      });
      if (!selection.ok) {
        json(res, { error: selection.error }, projectDirectoryHttpStatus(selection.code));
        return;
      }
      projectSelection = selection.value;
    }
    const { project: projectLabel, projectDir } = projectSelection;
    const finalName = customName || await uniqueSessionName(projectLabel);
    try {
      // Backends accept a `loadSettings` thunk that returns the agent to spawn.
      // Resolve the effective agent (respecting enabled-state + fallbacks) here
      // so the backend never sees a disabled or missing agentCmd.
      const settingsResolver = () => ({ agentCmd: effectiveAgentCmd(loadSettings()) });
      const agentKind = inferAgentKind(cmd || settingsResolver().agentCmd);
      if (initialPrompt !== undefined && agentKind === AGENT_KIND.SHELL) {
        return json(res, { error: "initial prompt requires an agent harness" }, 400);
      }
      await getBackend().createSession(finalName, projectDir, cmd, settingsResolver, {
        agentKind,
        parentSession: parentIdentity,
        initialPrompt,
      });
    } catch (e: unknown) {
      if (e instanceof DuplicateSessionError) {
        return json(res, { error: "session exists", session: finalName, hint: "reconnect or choose a different name" }, 409);
      }
      throw e;
    }
    if (parentName) notifySubSessionOpened(parentName, finalName);
    json(res, { ok: true, session: finalName });
  },

  "POST /api/session-create": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (
      !body
      || !isSessionCreateBody(body)
      || (body.harness !== undefined && !isCreatableHarness(body.harness))
      || (
        body.initialPrompt !== undefined
        && (!body.initialPrompt.trim()
          || unicodeCodePointLength(body.initialPrompt) > MAX_INITIAL_PROMPT_LENGTH)
      )
    ) {
      if (body) json(res, {
        error: "invalid session-create request",
        code: SESSION_CREATE_ERROR.INVALID_REQUEST,
      }, 400);
      return;
    }

    const projectSelection = resolveExistingProjectSelection(body);
    if (!projectSelection.ok) {
      if (projectSelection.code === "unavailable") {
        return json(res, {
          error: projectSelection.error,
          code: SESSION_CREATE_ERROR.BACKEND_UNAVAILABLE,
        }, projectDirectoryHttpStatus(projectSelection.code));
      }
      return json(
        res,
        {
          error: projectSelection.code === "not_found" ? "project not found" : "invalid session-create request",
          code: projectSelection.code === "not_found"
            ? SESSION_CREATE_ERROR.PROJECT_NOT_FOUND
            : SESSION_CREATE_ERROR.INVALID_REQUEST,
        },
        projectDirectoryHttpStatus(projectSelection.code),
      );
    }
    const { project, projectDir } = projectSelection.value;

    const configuredCommand = body.harness ?? effectiveAgentCmd(loadSettings());
    if (body.initialPrompt !== undefined && inferAgentKind(configuredCommand) === AGENT_KIND.SHELL) {
      return json(res, {
        error: "initial prompt requires an agent harness",
        code: SESSION_CREATE_ERROR.UNSUPPORTED_HARNESS,
      }, 400);
    }

    try {
      const result = await createTopLevelSession({
        backend: getBackend(),
        project,
        projectDir,
        command: configuredCommand,
        initialPrompt: body.initialPrompt,
        loadSettings: () => ({ agentCmd: configuredCommand }),
      });
      json(res, result);
    } catch (error: unknown) {
      if (error instanceof DuplicateSessionError) {
        return json(res, {
          error: "could not allocate a session name",
          code: SESSION_CREATE_ERROR.NAME_COLLISION,
        }, 409);
      }
      log.warn("session-create failed", { error: errMsg(error) });
      json(res, {
        error: "backend unavailable",
        code: SESSION_CREATE_ERROR.BACKEND_UNAVAILABLE,
      }, 503);
    }
  },

  "POST /api/session-open": async (req, res) => {
    const body = await parseObjectBody(req, res, {
      invalidResponse: SESSION_OPEN_INVALID_BODY_RESPONSE,
    });
    if (!body) return;
    if (
      !isSessionOpenBody(body)
      || !isValidSessionName(body.parentSession)
      || (body.sessionName !== undefined && !isValidSessionName(body.sessionName))
      || (
        body.initialPrompt !== undefined
        && (!body.initialPrompt.trim()
          || unicodeCodePointLength(body.initialPrompt) > MAX_INITIAL_PROMPT_LENGTH)
      )
    ) {
      return json(
        res,
        SESSION_OPEN_INVALID_BODY_RESPONSE.envelope,
        SESSION_OPEN_INVALID_BODY_RESPONSE.status,
      );
    }

    const projectSelection = resolveExistingProjectSelection(body);
    if (!projectSelection.ok) {
      if (projectSelection.code === "unavailable") {
        return json(res, {
          error: projectSelection.error,
          code: SESSION_OPEN_ERROR.BACKEND_UNAVAILABLE,
        }, SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.BACKEND_UNAVAILABLE]);
      }
      if (projectSelection.code === "not_found") {
        return json(res, {
          error: "project not found",
          code: SESSION_OPEN_ERROR.PROJECT_NOT_FOUND,
        }, SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.PROJECT_NOT_FOUND]);
      }
      return json(res, {
        error: "invalid session-open request",
        code: SESSION_OPEN_ERROR.INVALID_REQUEST,
      }, SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.INVALID_REQUEST]);
    }
    const { project, projectDir } = projectSelection.value;

    const backend = getBackend();
    if (!backend.listIdentities) {
      return json(res, {
        error: "parent session identity unavailable",
        code: SESSION_OPEN_ERROR.PARENT_IDENTITY_UNAVAILABLE,
      }, SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.PARENT_IDENTITY_UNAVAILABLE]);
    }

    try {
      const result = await openSubSession({
        backend: {
          list: () => backend.list(),
          listIdentities: () => backend.listIdentities!(),
          createSession: (name, cwd, cmd, loadSettings, options) => (
            backend.createSession(name, cwd, cmd, loadSettings, options)
          ),
        },
        parentSession: body.parentSession,
        project,
        projectDir,
        sessionName: body.sessionName,
        initialPrompt: body.initialPrompt,
        notify: (parent, session) => {
          notifySubSessionOpened(parent.wolfpackSessionName, session);
        },
      });
      json(res, result);
    } catch (error: unknown) {
      if (error instanceof SessionOpenError) {
        return json(
          res,
          { error: error.message, code: error.code },
          SESSION_OPEN_HTTP_STATUS[error.code],
        );
      }
      log.warn("session-open failed", { error: errMsg(error) });
      json(res, {
        error: "backend unavailable",
        code: SESSION_OPEN_ERROR.BACKEND_UNAVAILABLE,
      }, SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.BACKEND_UNAVAILABLE]);
    }
  },

  "GET /api/providers": async (_req, res) => {
    const providers = await detectProviderReadiness({ path: process.env.PATH });
    json(res, { providers });
  },

  "GET /api/settings": async (_req, res) => {
    const settings = loadSettings();
    // Surface the effective values so the frontend doesn't reimplement the
    // fallback rules. `effective.cmds` is what the picker should render;
    // `effective.agentCmd` is the pre-selected default.
    //
    // If the stored `settings.agentCmd` points to a disabled command, the
    // runtime already resolves correctly via effectiveAgentCmd(). Normalize
    // the raw field in the response so a future settings-UI consumer that
    // reads `settings.agentCmd` directly doesn't surface a stale/disabled
    // selection. We don't mutate the on-disk settings — just the returned
    // view.
    const enabled = new Set((settings.cmds ?? []).filter((c) => c.enabled).map((c) => c.cmd));
    const view = settings.agentCmd && !enabled.has(settings.agentCmd)
      ? { ...settings, agentCmd: "" }
      : settings;
    json(res, {
      settings: view,
      effective: {
        cmds: effectiveCmds(settings),
        agentCmd: effectiveAgentCmd(settings),
      },
    });
  },

  "POST /api/settings": async (req, res) => {
    // Single endpoint, multiple ops — each is independently optional and
    // applied in order. agentCmd is applied last so it can target a cmd added
    // in the same request. All ops validate strict inputs and reject quietly
    // with 400 on malformed bodies; on success the full settings + effective
    // values are echoed back so the frontend can re-render without a refetch.
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (!isSettingsBody(body)) {
      return json(res, { error: "invalid settings body" }, 400);
    }
    const settings = loadSettings();

    if (body.addCmd != null) {
      const cmd = body.addCmd.trim();
      if (!isValidCmd(cmd)) {
        return json(res, { error: "invalid characters in command" }, 400);
      }
      if (!settings.cmds.some(c => c.cmd === cmd)) {
        settings.cmds.push({ cmd, enabled: true });
      }
    }

    if (body.removeCmd != null) {
      const cmd = body.removeCmd;
      settings.cmds = settings.cmds.filter(c => c.cmd !== cmd);
      // If we removed the current default, drop it back to whatever
      // effectiveAgentCmd would resolve next time — setting it to "" lets the
      // resolver fall through to first-enabled → "shell".
      if (settings.agentCmd === cmd) settings.agentCmd = "";
    }

    if (body.setCmdEnabled != null) {
      const target = body.setCmdEnabled;
      const entry = settings.cmds.find(c => c.cmd === target.cmd);
      if (entry) entry.enabled = target.enabled;
    }

    if (body.agentCmd != null) {
      const cmd = body.agentCmd.trim();
      if (!isValidCmd(cmd)) {
        return json(res, { error: "invalid characters in agent command" }, 400);
      }
      settings.agentCmd = cmd;
    }

    saveSettings(settings);
    json(res, {
      ok: true,
      settings,
      effective: {
        cmds: effectiveCmds(settings),
        agentCmd: effectiveAgentCmd(settings),
      },
    });
  },

  "GET /api/backend": async (_req, res) => {
    const router = getRouter();
    const counts = await router.getSessionCounts();
    json(res, {
      brokerAvailable: router.isBrokerAvailable(),
      counts,
    });
  },

  "POST /api/kill": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    const selector = body.session;
    if (typeof selector !== "string" || !selector) return json(res, { error: "missing session" }, 400);
    const resolved = await resolveActiveSession(res, selector);
    if (!resolved) return;
    // Clean up any associated desktop PTY session (wp_*) before killing
    teardownPty(resolved.name);
    forgetSessionObservation(resolved.identity.wolfpackSessionId, resolved.name);
    await getBackend().killSession(resolved.name);
    json(res, {
      ok: true,
      session: resolved.name,
      sessionId: resolved.identity.wolfpackSessionId,
    });
  },

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

  "POST /api/resize": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    const { session, cols, rows } = body;
    if (
      typeof session !== "string" || !session ||
      typeof cols !== "number" || !Number.isFinite(cols) ||
      typeof rows !== "number" || !Number.isFinite(rows)
    ) return json(res, { error: "missing params" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    if (!activePtySessions.has(session)) {
      try {
        await getBackend().resize(session, clampCols(cols), clampRows(rows));
      } catch (e: unknown) {
        log.warn("resize failed", { session, error: errMsg(e) });
        return json(res, { error: "backend unavailable" }, 503);
      }
    }
    json(res, { ok: true });
  },

  "GET /api/tailnet/v1/candidates": async (_req, res) => {
    json(res, await enumerateLocalTailnetCandidates());
  },

  "GET /api/discover": async (_req, res) => {
    const discovery = await enumerateLocalTailnetCandidates();
    res.setHeader("Deprecation", "true");
    res.setHeader("Link", '</api/tailnet/v1/candidates>; rel="successor-version"');
    json(res, {
      peers: discovery.candidates
        .filter((candidate) => candidate.online)
        .map((candidate) => ({
          hostname: candidate.hostname,
          url: candidate.origin,
          name: candidate.hostname,
        })),
      ...(discovery.error ? { error: discovery.error } : {}),
    });
  },

  "GET /api/poll": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const session = url.searchParams.get("session");
    if (!session) return json(res, { error: "missing session param" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    const pane = await getBackend().capturePane(session);
    json(res, { pane });
  },

  "GET /api/copy-text": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const session = url.searchParams.get("session");
    if (!session) return json(res, { error: "missing session param" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    const text = await getBackend().capturePane(session);
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(text);
  },

  "GET /api/git-status": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const session = url.searchParams.get("session");
    if (!validateProject(res, session)) return;
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    const projectDir = getBackend().sessionDir(session);
    if (!projectDir || !existsSync(projectDir))
      return json(res, { error: "project directory not found" }, 404);
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile("git", ["status", "--short", "--branch"], { cwd: projectDir }, (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr || err.message));
          resolve(stdout);
        });
      });
      json(res, { status: output });
    } catch (e: unknown) {
      json(res, { error: errMsg(e) || "git status failed" }, 500);
    }
  },

  // ── Readiness and bounded operational metrics ──

  "GET /api/health": (_req, res) => {
    const health = operationalHealth();
    json(res, health, health.status === "ready" ? 200 : 503);
  },

  "GET /api/metrics": (_req, res) => json(res, boundedMetrics()),

  "GET /metrics": (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(prometheusMetrics());
  },

  // ── Browser authentication ──

  "POST /api/auth/ws-ticket": (req, res) => {
    const client = classifyRequestClient({
      remoteAddress: req.socket.remoteAddress,
      tailscaleUserLogin: req.headers["tailscale-user-login"],
    });
    json(res, issueWebSocketTicket(client.clientKey));
  },

  // ── Push notifications ──

  "GET /api/push/vapid-key": (_req, res) => {
    json(res, { publicKey: getVapidPublicKey() });
  },

  "POST /api/push/subscribe": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (
      typeof body.endpoint !== "string" ||
      !isJsonObject(body.keys) ||
      typeof body.keys.p256dh !== "string" ||
      typeof body.keys.auth !== "string"
    ) return json(res, { error: "invalid subscription" }, 400);
    const sub: PushSubscription = {
      endpoint: body.endpoint,
      keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    };
    const validationError = validateSubscription(sub);
    if (validationError) return json(res, { error: validationError }, 400);
    const hadSubscriptions = getSubscriptionCount() > 0;
    const result = addSubscription(sub);
    if (!result.ok) return json(res, { error: result.error }, 429);
    if (!hadSubscriptions) resetNotificationObservation();
    json(res, { ok: true });
  },

  "POST /api/push/unsubscribe": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (!body.endpoint || typeof body.endpoint !== "string") return json(res, { error: "missing endpoint" }, 400);
    removeSubscription(body.endpoint);
    if (getSubscriptionCount() === 0) resetNotificationObservation();
    json(res, { ok: true });
  },

  // ── Agent-triggered notifications ──

  ...taskRoutes,
  ...taskRelayRoutes,

  "POST /api/notify": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (!body.message || typeof body.message !== "string") return json(res, { error: "missing message" }, 400);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    const sessionName = typeof body.sessionName === "string" ? body.sessionName : undefined;
    if ((sessionId === undefined) !== (sessionName === undefined)) {
      return json(res, { error: "sessionId and sessionName must be provided together" }, 400);
    }
    const message = body.message.slice(0, 500);
    let payload;
    try {
      payload = buildAgentNotificationPayload(message, sessionId !== undefined && sessionName !== undefined ? {
        sessionId,
        sessionName,
      } : undefined);
    } catch {
      return json(res, { error: "invalid notification session target" }, 400);
    }

    const rateLimitError = checkNotifyRateLimit();
    if (rateLimitError) return json(res, { error: rateLimitError }, 429);

    const result = await sendPush(payload);
    json(res, { ok: true, ...result });
  },
};
