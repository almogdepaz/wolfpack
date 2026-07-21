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
  unlinkSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { hostname, homedir } from "node:os";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { AGENT_KIND } from "../agent-kind.js";
import { createLogger, errMsg } from "../log.js";
import {
  configuredRalphAgents,
  selectConfiguredRalphAgent,
  type RalphAgent,
} from "../ralph-agent.js";
import {
  isActiveRalphWorktreeMode,
  RALPH_WORKTREE_MODE,
} from "../ralph-worktree-mode.js";
import { isProcessAlive, isRalphProcessAlive } from "../shared/process-cleanup.js";
import {
  CMD_REGEX,
  BRANCH_REGEX,
  MAX_INITIAL_PROMPT_LENGTH,
  isValidProjectName,
  isValidSessionName,
  isValidPlanFile,
  SAFE_FILENAME,
  clampCols,
  clampRows,
} from "../validation.js";
import { cleanupAllExceptFinal } from "../worktree.js";
import { assets } from "../public-assets.js";
import { isJunkLine, type TriageStatus } from "../triage.js";
import { getVapidPublicKey, addSubscription, removeSubscription, sendPush, validateSubscription, checkSessionTransitions, checkRalphLoopTransitions, checkNotifyRateLimit, type PushSubscription } from "./push.js";
import pkg from "../../package.json";

const log = createLogger("routes");
import { DEV_DIR } from "./dev-dir.js";
import { validateProjectDir as validateProjectDirPure } from "./validate-project-dir.js";
import { getBackend, getRouter, DuplicateSessionError } from "./backend.js";
import {
  listDevProjects,
  parseRalphLog,
  pruneStaleRalphLock,
  scanRalphLoops,
  countPlanTasks,
} from "./ralph.js";

// ── Constants ──
const PEER_FETCH_TIMEOUT_MS = 3_000;
const RALPH_LOG_MAX_TAIL_BYTES = 128 * 1024;
const RALPH_LOG_MAX_LINES = 500;
const SESSION_WAIT_DEFAULT_TIMEOUT_MS = 30_000;
const SESSION_WAIT_MAX_TIMEOUT_MS = 600_000;
const SESSION_WAIT_BUFFER_MAX_CHARS = 128 * 1024;

// ── Peer ralph-response validation ──

/** Allowed keys on a ralph loop entry from a remote peer. */
const RALPH_LOOP_SCHEMA: Record<string, "string" | "number" | "boolean" | "object" | "array"> = {
  project: "string",
  active: "boolean",
  completed: "boolean",
  audit: "boolean",
  cleanup: "boolean",
  cleanupEnabled: "boolean",
  auditFixEnabled: "boolean",
  iteration: "number",
  totalIterations: "number",
  agent: "string",
  planFile: "string",
  progressFile: "string",
  started: "string",
  finished: "string",
  lastOutput: "string",
  pid: "number",
  tasksDone: "number",
  tasksTotal: "number",
  worktreeMode: "string",
  worktreeBranch: "string",
  sandbox: "string",
  statusSource: "object",
  statusSources: "array",
};

/**
 * Validate and sanitize a peer's ralph response.
 * Returns validated loop entries or null if the response is malformed.
 * Strips unexpected keys from each entry.
 */
export function validatePeerLoops(peerName: string, data: unknown): Record<string, unknown>[] | null {
  if (typeof data !== "object" || data === null || !("loops" in data)) {
    log.warn(`malformed peer response from ${peerName}: missing 'loops' key`);
    return null;
  }
  const { loops } = data as { loops: unknown };
  if (!Array.isArray(loops)) {
    log.warn(`malformed peer response from ${peerName}: 'loops' is not an array`);
    return null;
  }
  const validated: Record<string, unknown>[] = [];
  for (const entry of loops) {
    if (typeof entry !== "object" || entry === null) {
      log.warn(`malformed peer loop entry from ${peerName}: not an object, skipping`);
      continue;
    }
    const obj = entry as Record<string, unknown>;
    // project is required — skip entries without it
    if (typeof obj.project !== "string") {
      log.warn(`malformed peer loop entry from ${peerName}: missing 'project', skipping`);
      continue;
    }
    const clean: Record<string, unknown> = {};
    for (const [key, expectedType] of Object.entries(RALPH_LOOP_SCHEMA)) {
      if (key in obj && (
        (expectedType === "array" && Array.isArray(obj[key])) ||
        (expectedType === "object" && typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) ||
        (expectedType !== "array" && expectedType !== "object" && typeof obj[key] === expectedType)
      )) {
        clean[key] = obj[key];
      }
    }
    validated.push(clean);
  }
  return validated;
}

/** Validate project name param. Returns project string or sends 400 and returns null. */
function validateProject(res: ServerResponse, project: string | null | undefined): project is string {
  if (!project || !isValidProjectName(project)) {
    json(res, { error: "invalid project" }, 400);
    return false;
  }
  return true;
}

/** Validate project directory exists, is not a symlink, and resolves under DEV_DIR.
 *  Thin HTTP wrapper around the pure `validateProjectDirPure` so the security-sensitive
 *  containment logic lives in one tested place. */
function validateProjectDir(res: ServerResponse, projectDir: string): boolean {
  const result = validateProjectDirPure(projectDir);
  if (result.ok) return true;
  json(res, { error: result.error }, result.code === "not_found" ? 404 : 400);
  return false;
}

import {
  uniqueSessionName,
  isAllowedSession,
  json,
  parseBody,
  serveFile,
  cachedPeers,
  discoverPeers,
} from "./http.js";
import type { InvalidBodyResponse } from "./http.js";
import { activePtySessions, notifySubSessionOpened, teardownPty } from "./websocket.js";
import { inferAgentKind } from "./session-identity.js";
import type { ParentSessionIdentity, PublicSessionIdentity } from "./session-identity.js";
import {
  isOpenableHarness,
  SESSION_OPEN_ERROR,
  SESSION_OPEN_HTTP_STATUS,
} from "../session-open-contract.js";
import { openSubSession, SessionOpenError } from "./session-open.js";
import { SESSION_CREATE_ERROR } from "../session-create-contract.js";
import { createTopLevelSession } from "./session-create.js";
import { resolveSessionSelector } from "./session-selector.js";
import type { SessionSelectorResult } from "./session-selector.js";

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
  invalidResponse?: InvalidBodyResponse,
): Promise<Record<string, unknown> | null> {
  const body = await parseBody(req, res, invalidResponse);
  if (body === undefined) return null;
  if (!isJsonObject(body)) {
    json(
      res,
      invalidResponse?.envelope ?? { error: "JSON body must be an object" },
      invalidResponse?.status ?? 400,
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
  newProject?: string;
  cmd?: string;
  sessionName?: string;
  parentSession?: string;
  initialPrompt?: string;
}

function isCreateBody(body: Record<string, unknown>): body is CreateBody {
  return ["project", "newProject", "cmd", "sessionName", "parentSession", "initialPrompt"].every(
    key => hasOptionalType(body, key, "string"),
  );
}

interface SessionCreateBody extends Record<string, unknown> {
  project: string;
  harness?: string;
  initialPrompt?: string;
}

function isSessionCreateBody(body: Record<string, unknown>): body is SessionCreateBody {
  const allowedKeys = new Set(["project", "harness", "initialPrompt"]);
  return Object.keys(body).every(key => allowedKeys.has(key))
    && typeof body.project === "string"
    && hasOptionalType(body, "harness", "string")
    && hasOptionalType(body, "initialPrompt", "string");
}

interface SessionOpenBody extends Record<string, unknown> {
  project: string;
  parentSession: string;
  initialPrompt?: string;
}

function isSessionOpenBody(body: Record<string, unknown>): body is SessionOpenBody {
  const allowedKeys = new Set(["project", "parentSession", "initialPrompt"]);
  return Object.keys(body).every(key => allowedKeys.has(key))
    && typeof body.project === "string"
    && typeof body.parentSession === "string"
    && hasOptionalType(body, "initialPrompt", "string");
}

interface SettingsBody extends Record<string, unknown> {
  agentCmd?: string;
  addCmd?: string;
  removeCmd?: string;
  setCmdEnabled?: { cmd: string; enabled: boolean };
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

/** Validate project name + directory in one call. Returns resolved path or sends error and returns null. */
function resolveProjectDir(res: ServerResponse, project: string | null | undefined): string | null {
  if (!validateProject(res, project)) return null;
  const dir = join(DEV_DIR, project);
  if (!validateProjectDir(res, dir)) return null;
  return dir;
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
        { error: resolved.code === "AMBIGUOUS" ? "ambiguous session selector" : "session not found" },
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

function sessionStatusPayload(name: string, identity: PublicSessionIdentity) {
  return {
    ok: true as const,
    session: name,
    sessionId: identity.wolfpackSessionId,
    state: "active" as const,
    projectPath: identity.projectPath,
    harness: identity.agentKind,
    ...(identity.parentSession && {
      parentSession: {
        session: identity.parentSession.wolfpackSessionName,
        sessionId: identity.parentSession.wolfpackSessionId,
      },
    }),
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

/** Previous pane content per session — used for content-diff triage. */
const prevPaneContent = new Map<string, string>();

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

export interface LoadedSettings {
  settings: Settings;
  ralphAgents: RalphAgent[];
}

export function loadSettingsWithRalphAgents(): LoadedSettings {
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
  // array. Synthesizing built-ins here would make unconfigured commands look
  // user-configured to Ralph authorization.
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
    const settings = { agentCmd, cmds };
    return {
      settings,
      ralphAgents: configuredRalphAgents(cmds.filter(cmd => cmd.enabled).map(cmd => cmd.cmd)),
    };
  }

  // Legacy settings still receive the session-picker defaults, but only
  // commands explicitly present in `customCmds` authorize Ralph.
  const cmds: CmdEntry[] = DEFAULT_CMDS.map(c => ({ ...c }));
  const configuredCommands: string[] = [];
  const seen = new Set(cmds.map(c => c.cmd));
  if (raw && Array.isArray(raw.customCmds)) {
    for (const command of raw.customCmds as unknown[]) {
      if (typeof command !== "string" || !isValidCmd(command)) continue;
      configuredCommands.push(command);
      if (seen.has(command)) continue;
      seen.add(command);
      cmds.push({ cmd: command, enabled: true });
    }
  }
  return {
    settings: { agentCmd, cmds },
    ralphAgents: configuredRalphAgents(configuredCommands),
  };
}

export function loadSettings(): Settings {
  return loadSettingsWithRalphAgents().settings;
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

export function effectiveRalphAgents(s: Settings): RalphAgent[] {
  return configuredRalphAgents(effectiveCmds(s));
}

// Ralph worker is invoked as a subcommand: `wolfpack worker --plan ...`
const RALPH_BIN_ARGS = (() => {
  const exe = process.execPath;
  const isBunRuntime = exe.endsWith("/bun") || exe.endsWith("/bun.exe");
  if (isBunRuntime) return [exe, join(import.meta.dir, "..", "cli", "index.ts")];
  return [exe];
})();

export const routes: Record<
  string,
  (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
> = {
  "GET /": (_req, res) => serveFile(res, "index.html"),
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
    json(res, { name, version: VERSION });
  },

  "GET /api/sessions": async (_req, res) => {
    const sessions = await getBackend().list();
    const identities = await getBackend().listIdentities?.() ?? {};
    const activeNames = new Set<string>();
    const results = await Promise.all(
      sessions.map(async (name) => {
        activeNames.add(name);
        const pane = await getBackend().capturePaneForTriage(name);
        const content = pane.trimEnd();

        // Walk lines from bottom, skip junk, take first real line for preview
        const lines = content.split("\n");
        let lastLine = "";
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!isJunkLine(lines[i])) {
            lastLine = lines[i].trim();
            break;
          }
        }

        // Content-diff triage
        const prev = prevPaneContent.get(name);
        let triage: TriageStatus;
        if (prev !== content) {
          triage = "running";
          prevPaneContent.set(name, content);
        } else {
          triage = "idle";
        }

        return { name, lastLine, triage, ...(identities[name] && { identity: identities[name] }) };
      }),
    );
    results.sort((a, b) => a.name.localeCompare(b.name));
    // prune prevPaneContent for sessions that no longer exist
    for (const key of prevPaneContent.keys()) {
      if (!activeNames.has(key)) prevPaneContent.delete(key);
    }
    json(res, { sessions: results });

    // Fire push notifications for running → idle transitions (async, don't block response)
    checkSessionTransitions(results);
  },

  "GET /api/projects": async (_req, res) => {
    const projects = listDevProjects();
    json(res, { projects });
  },

  "GET /api/next-session-name": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    if (!validateProject(res, project)) return;
    const name = await uniqueSessionName(project);
    json(res, { name });
  },

  "POST /api/create": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (!isCreateBody(body)) {
      return json(res, {
        error: "project, newProject, cmd, sessionName, parentSession, and initialPrompt must be strings",
      }, 400);
    }
    const { project, newProject, cmd, sessionName, parentSession, initialPrompt } = body;
    const folderName = newProject?.trim() || project?.trim();
    if (!validateProject(res, folderName)) return;
    if (cmd && cmd !== AGENT_KIND.SHELL && !CMD_REGEX.test(cmd)) {
      return json(res, { error: "invalid characters in command" }, 400);
    }
    if (
      initialPrompt !== undefined
      && (!initialPrompt.trim() || initialPrompt.length > MAX_INITIAL_PROMPT_LENGTH)
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
    const projectDir = join(DEV_DIR, folderName);
    if (newProject) {
      try { mkdirSync(projectDir, { recursive: true }); } catch (e: unknown) {
        log.error("/api/create: failed to create project directory", { path: projectDir, error: errMsg(e) });
      }
    }
    if (!validateProjectDir(res, projectDir)) return;
    const finalName = customName || await uniqueSessionName(folderName);
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
      || !isValidProjectName(body.project)
      || (body.harness !== undefined && !isOpenableHarness(body.harness))
      || (
        body.initialPrompt !== undefined
        && (!body.initialPrompt.trim() || body.initialPrompt.length > MAX_INITIAL_PROMPT_LENGTH)
      )
    ) {
      if (body) json(res, {
        error: "invalid session-create request",
        code: SESSION_CREATE_ERROR.INVALID_REQUEST,
      }, 400);
      return;
    }

    const projectDir = join(DEV_DIR, body.project);
    const projectValidation = validateProjectDirPure(projectDir);
    if (!projectValidation.ok) {
      return json(
        res,
        {
          error: projectValidation.code === "not_found" ? "project not found" : "invalid project",
          code: projectValidation.code === "not_found"
            ? SESSION_CREATE_ERROR.PROJECT_NOT_FOUND
            : SESSION_CREATE_ERROR.INVALID_REQUEST,
        },
        projectValidation.code === "not_found" ? 404 : 400,
      );
    }

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
        project: body.project,
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
    const body = await parseObjectBody(req, res, SESSION_OPEN_INVALID_BODY_RESPONSE);
    if (!body) return;
    if (
      !isSessionOpenBody(body)
      || !isValidProjectName(body.project)
      || !isValidSessionName(body.parentSession)
      || (
        body.initialPrompt !== undefined
        && (!body.initialPrompt.trim() || body.initialPrompt.length > MAX_INITIAL_PROMPT_LENGTH)
      )
    ) {
      return json(
        res,
        SESSION_OPEN_INVALID_BODY_RESPONSE.envelope,
        SESSION_OPEN_INVALID_BODY_RESPONSE.status,
      );
    }

    const projectDir = join(DEV_DIR, body.project);
    const projectValidation = validateProjectDirPure(projectDir);
    if (!projectValidation.ok) {
      if (projectValidation.code === "not_found") {
        return json(res, {
          error: "project not found",
          code: SESSION_OPEN_ERROR.PROJECT_NOT_FOUND,
        }, SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.PROJECT_NOT_FOUND]);
      }
      return json(res, {
        error: "invalid project",
        code: SESSION_OPEN_ERROR.INVALID_REQUEST,
      }, SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.INVALID_REQUEST]);
    }

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
        project: body.project,
        projectDir,
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

  "GET /api/settings": async (_req, res) => {
    const loaded = loadSettingsWithRalphAgents();
    const settings = loaded.settings;
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
        ralphAgents: loaded.ralphAgents,
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
        ralphAgents: effectiveRalphAgents(settings),
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
    prevPaneContent.delete(resolved.name);
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
      const sessions = names
        .map(name => sessionStatusPayload(name, identities[name]!))
        .sort((left, right) => left.session.localeCompare(right.session));
      json(res, { sessions });
    } catch (error: unknown) {
      log.warn("session-control list failed", { error: errMsg(error) });
      json(res, { error: "backend unavailable" }, 503);
    }
  },

  "GET /api/session-control/status": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const selector = url.searchParams.get("session");
    if (!selector) return json(res, { error: "missing session" }, 400);
    const resolved = await resolveActiveSession(res, selector);
    if (!resolved) return;
    json(res, sessionStatusPayload(resolved.name, resolved.identity));
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

  "GET /api/discover": async (_req, res) => {
    const result = await discoverPeers();
    if (result.error) return json(res, { peers: [], error: result.error });
    json(res, { peers: result.peers });
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

  // ── Ralph loop API ──

  "GET /api/ralph": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const aggregate = url.searchParams.get("aggregate") === "true";
    const selfHost = hostname().replace(/\.local$/, "").replace(/\.tail[a-z0-9-]*\.ts\.net$/i, "");
    const localLoops = scanRalphLoops().map(l => ({ ...l, machineName: selfHost, machineUrl: "" }));

    if (!aggregate || cachedPeers.length === 0) {
      json(res, { loops: localLoops });
      checkRalphLoopTransitions(localLoops);
      return;
    }

    const remotePeers = cachedPeers.filter(p => p.name !== selfHost);
    const peerResults = await Promise.all(
      remotePeers.map(async (peer) => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), PEER_FETCH_TIMEOUT_MS);
          const authHeader = Array.isArray(req.headers.authorization)
            ? req.headers.authorization[0]
            : req.headers.authorization;
          const headers = authHeader ? { Authorization: authHeader } : undefined;
          const r = await fetch(peer.url + "/api/ralph", {
            signal: ctrl.signal,
            headers,
          });
          clearTimeout(timer);
          const data = await r.json();
          const loops = validatePeerLoops(peer.name, data);
          if (!loops) return [];
          return loops.map(l => ({ ...l, machineName: peer.name, machineUrl: peer.url }));
        } catch { /* expected: peer unreachable or non-wolfpack — skip silently */
          return [];
        }
      })
    );

    const allLoops = [...localLoops, ...peerResults.flat()];
    json(res, { loops: allLoops });
    // Only fire transitions for LOCAL loops — each peer machine runs its own
    // /api/ralph poll and fires transitions for its own loops, so feeding
    // peer loops here would double-notify (once per peer per machine).
    checkRalphLoopTransitions(localLoops);
  },

  "GET /api/ralph/branches": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;
    try {
      const out = execFileSync("git", ["branch", "--list", "--no-color"], {
        cwd: projectDir,
        encoding: "utf-8",
        timeout: 5000,
      });
      let current = "";
      const branches: string[] = [];
      for (const line of out.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("* ")) {
          const name = trimmed.slice(2).trim();
          current = name;
          branches.push(name);
        } else {
          branches.push(trimmed);
        }
      }
      json(res, { branches, current });
    } catch (e: unknown) {
      const msg = (e as { stderr?: string })?.stderr || errMsg(e) || "git not available";
      json(res, { error: msg }, 500);
    }
  },

  "GET /api/ralph/plans": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;
    try {
      const rootPlans = readdirSync(projectDir)
        .filter((f) => f.endsWith(".md") && !f.startsWith(".") && !/^(readme|doc|changelog|contributing|license|code.of.conduct)\.md$/i.test(f))
        .filter((f) => { try { return statSync(join(projectDir, f)).isFile(); } catch { /* race: file removed between readdir and stat */ return false; } });
      const dotPlansDir = join(projectDir, ".plans");
      const dotPlans = existsSync(dotPlansDir)
        ? readdirSync(dotPlansDir)
          .map((f) => `.plans/${f}`)
          .filter((f) => isValidPlanFile(f))
          .filter((f) => { try { return statSync(join(projectDir, f)).isFile(); } catch { /* race: file removed between readdir and stat */ return false; } })
        : [];
      json(res, { plans: [...rootPlans, ...dotPlans].sort() });
    } catch (e: unknown) {
      log.warn("failed to list plan files", { error: errMsg(e) });
      json(res, { plans: [] });
    }
  },

  "GET /api/ralph/log": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;
    const logPath = join(projectDir, ".ralph.log");
    if (!existsSync(logPath)) {
      return json(res, { error: "no ralph log found" }, 404);
    }
    try {
      const fd = openSync(logPath, "r");
      try {
        const size = statSync(logPath).size;
        const offset = Math.max(0, size - RALPH_LOG_MAX_TAIL_BYTES);
        const buf = Buffer.alloc(Math.min(size, RALPH_LOG_MAX_TAIL_BYTES));
        readSync(fd, buf, 0, buf.length, offset);
        const content = buf.toString("utf-8");
        const lines = content.split("\n");
        if (offset > 0) lines.shift();
        const totalLines = lines.length;
        const log = lines.slice(-RALPH_LOG_MAX_LINES).join("\n");
        json(res, { log, totalLines });
      } finally {
        closeSync(fd);
      }
    } catch (e: unknown) {
      log.error("failed to read ralph log", { error: errMsg(e) });
      json(res, { error: "failed to read log" }, 500);
    }
  },

  "POST /api/ralph/start": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (!["project", "planFile", "agent", "newBranch", "sourceBranch", "worktreeBranch", "worktreeBase"].every(
      key => hasOptionalType(body, key, "string"),
    )) return json(res, { error: "invalid string field" }, 400);
    if (
      !hasOptionalType(body, "iterations", "number") ||
      (typeof body.iterations === "number" && !Number.isInteger(body.iterations))
    ) return json(res, { error: "iterations must be an integer" }, 400);
    if (!["format", "cleanup", "auditFix", "sandbox"].every(key => hasOptionalType(body, key, "boolean"))) {
      return json(res, { error: "invalid boolean field" }, 400);
    }
    const { project, iterations, planFile, agent, newBranch, sourceBranch, format, cleanup, auditFix, worktree, worktreeBranch, worktreeBase, sandbox } = body as {
      project?: string;
      iterations?: number;
      planFile?: string;
      agent?: string;
      newBranch?: string;
      sourceBranch?: string;
      format?: boolean;
      cleanup?: boolean;
      auditFix?: boolean;
      worktree?: unknown;
      worktreeBranch?: string;
      worktreeBase?: string;
      sandbox?: boolean;
    };
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;

    const iters = Math.max(1, Math.min(500, iterations ?? 5));
    const resolvedPlan = planFile || "PLAN.md";
    if (!isValidPlanFile(resolvedPlan)) {
      return json(res, { error: "invalid plan file name" }, 400);
    }
    if (cleanup != null && typeof cleanup !== "boolean") {
      return json(res, { error: "invalid cleanup flag" }, 400);
    }
    if (auditFix != null && typeof auditFix !== "boolean") {
      return json(res, { error: "invalid auditFix flag" }, 400);
    }
    const validWorktree = worktree === undefined || worktree === false || worktree === RALPH_WORKTREE_MODE.DISABLED || (typeof worktree === "string" && isActiveRalphWorktreeMode(worktree));
    if (!validWorktree) {
      return json(res, { error: `invalid worktree mode — must be false, "${RALPH_WORKTREE_MODE.PLAN}", or "${RALPH_WORKTREE_MODE.TASK}"` }, 400);
    }
    const worktreeMode = typeof worktree === "string" && isActiveRalphWorktreeMode(worktree) ? worktree : RALPH_WORKTREE_MODE.DISABLED;
    if (worktreeBranch != null && typeof worktreeBranch !== "string") {
      return json(res, { error: "invalid worktreeBranch" }, 400);
    }
    if (worktreeBranch && !BRANCH_REGEX.test(worktreeBranch)) {
      return json(res, { error: "invalid worktree branch name" }, 400);
    }
    if (worktreeBase != null && typeof worktreeBase !== "string") {
      return json(res, { error: "invalid worktreeBase" }, 400);
    }
    if (worktreeBase && !BRANCH_REGEX.test(worktreeBase)) {
      return json(res, { error: "invalid worktree base branch name" }, 400);
    }
    const source = sourceBranch || "main";
    if (newBranch && !BRANCH_REGEX.test(newBranch)) {
      return json(res, { error: "invalid branch name" }, 400);
    }
    if (newBranch && !BRANCH_REGEX.test(source)) {
      return json(res, { error: "invalid source branch name" }, 400);
    }
    if (!existsSync(join(projectDir, resolvedPlan))) {
      return json(res, { error: `plan file '${resolvedPlan}' not found` }, 404);
    }
    const selectedAgent = selectConfiguredRalphAgent(agent, loadSettingsWithRalphAgents().ralphAgents);
    if (!selectedAgent) {
      return json(res, { error: "ralph agent is not configured and enabled" }, 400);
    }
    const cleanupEnabled = cleanup ?? true;
    const auditFixEnabled = auditFix ?? false;

    const existing = parseRalphLog(projectDir);
    if (existing?.active) {
      return json(res, { error: "ralph loop already running", pid: existing.pid }, 409);
    }
    if (existing && existing.pid > 1) {
      pruneStaleRalphLock(projectDir, existing.pid);
    }

    const lockPath = join(projectDir, ".ralph.lock");
    // Try atomic create first — avoids TOCTOU between stale-check and create
    try {
      writeFileSync(lockPath, "", { flag: "wx" });
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") {
        return json(res, { error: "failed to acquire lock" }, 500);
      }
      // Lock exists — check if it's stale
      let lockPid = 0;
      try { lockPid = Number(readFileSync(lockPath, "utf-8").trim()); } catch { /* lock may have been removed between wx and read */ }
      if (isRalphProcessAlive(lockPid)) {
        return json(res, { error: "ralph loop already running (lock held)", pid: lockPid }, 409);
      }
      if (lockPid > 1 && isProcessAlive(lockPid)) {
        // Process at PID exists but is not ralph (PID reuse / unrelated
        // proc). Lock is stale; fall through to remove + retry.
        log.warn("lock PID belongs to unrelated process, removing stale lock", { pid: lockPid });
      }
      // Stale lock — remove and retry atomic create
      try { unlinkSync(lockPath); } catch (e2: unknown) {
        if ((e2 as NodeJS.ErrnoException)?.code !== "ENOENT") log.warn("ralph start: failed to remove stale lock", { error: errMsg(e2) });
      }
      try {
        writeFileSync(lockPath, "", { flag: "wx" });
      } catch (e2: unknown) {
        if ((e2 as NodeJS.ErrnoException)?.code === "EEXIST") {
          return json(res, { error: "ralph loop already starting (lock contention)" }, 409);
        }
        return json(res, { error: "failed to acquire lock" }, 500);
      }
    }

    const removeLock = () => {
      try { unlinkSync(lockPath); } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") log.warn("ralph start: failed to remove lock on validation failure", { error: errMsg(e) });
      }
    };

    let spawned = false;
    try {
    if (newBranch) {
      try {
        execFileSync("git", ["fetch", "origin", `${source}:${source}`], {
          cwd: projectDir, encoding: "utf-8", timeout: 30000,
        });
      } catch (e: unknown) {
        const stderr = (e as { stderr?: string })?.stderr || errMsg(e) || "";
        try {
          execFileSync("git", ["rev-parse", "--verify", source], {
            cwd: projectDir, encoding: "utf-8", timeout: 5000,
          });
        } catch { /* local ref also not found — report fetch failure to user */
          return json(res, { error: `failed to fetch source branch '${source}': ${stderr}` }, 400);
        }
      }
      try {
        execFileSync("git", ["checkout", "-b", newBranch, source], {
          cwd: projectDir, encoding: "utf-8", timeout: 10000,
        });
      } catch (e: unknown) {
        const stderr = (e as { stderr?: string })?.stderr || errMsg(e) || "branch creation failed";
        return json(res, { error: stderr }, 400);
      }
    }

    // Worktree creation is handled by the worker process itself
    // (plan mode creates one worktree at startup, task mode creates per-iteration).
    // The route only passes the mode flag — the worker manages the lifecycle.

    const workerArgs = [
      ...RALPH_BIN_ARGS.slice(1),
      "worker",
      "--plan", resolvedPlan,
      "--iterations", String(iters),
      "--agent", selectedAgent,
      "--progress", "progress.txt",
      "--cleanup", String(cleanupEnabled),
      "--audit-fix", String(auditFixEnabled),
      ...(format ? ["--format"] : []),
      "--worktree", worktreeMode,
      ...(worktreeBranch ? ["--worktree-branch", worktreeBranch] : []),
      ...(worktreeBase ? ["--worktree-base", worktreeBase] : []),
      "--sandbox", String(sandbox !== false),
    ];
    const child = spawn(RALPH_BIN_ARGS[0], workerArgs, {
      cwd: projectDir,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        WOLFPACK_PROJECT_DIR: projectDir,
        WOLFPACK_AGENT_KIND: selectedAgent,
        WOLFPACK_RALPH_AGENT_KIND: selectedAgent,
      },
    });
    child.unref();
    spawned = true;

    try { writeFileSync(lockPath, String(child.pid ?? 0)); } catch (e: unknown) {
      log.error("ralph start: failed to write lock file", { error: errMsg(e) });
    }

    json(res, {
      ok: true,
      pid: child.pid ?? 0,
      branch: newBranch || undefined,
      worktree: worktreeMode !== RALPH_WORKTREE_MODE.DISABLED ? worktreeMode : undefined,
    });
    } finally {
      if (!spawned) removeLock();
    }
  },

  "GET /api/ralph/task-count": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    const plan = url.searchParams.get("plan");
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;
    if (!plan || !isValidPlanFile(plan)) {
      return json(res, { error: "invalid plan file" }, 400);
    }
    const planPath = join(projectDir, plan);
    if (!existsSync(planPath)) {
      return json(res, { error: "plan not found" }, 404);
    }
    json(res, countPlanTasks(planPath));
  },

  "POST /api/ralph/cancel": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    const { project } = body;
    if (typeof project !== "string") return json(res, { error: "invalid project" }, 400);
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;
    const status = parseRalphLog(projectDir);
    if (!status?.active || !status.pid || status.pid <= 1) {
      return json(res, { error: "no active ralph loop found" }, 404);
    }
    // Reuse the same PID-reuse-safe filter parseRalphLog applies so the
    // cancel and active-detection paths agree. ps -o command= confirms
    // it's actually a ralph worker, not a reused PID slot.
    if (!isRalphProcessAlive(status.pid)) {
      return json(res, { error: "PID does not belong to a ralph process or process not found" }, 404);
    }
    try {
      process.kill(status.pid, "SIGTERM");
      // Clean up progress file so cancelled loop starts fresh on next continue
      if (status.progressFile && SAFE_FILENAME.test(status.progressFile) && !status.progressFile.includes("..")) {
        try { unlinkSync(join(projectDir, status.progressFile)); } catch { /* may not exist */ }
      }
      json(res, { ok: true, killed: status.pid });
    } catch (e: unknown) {
      log.error("failed to kill ralph process", { pid: status.pid, error: errMsg(e) });
      json(res, { error: "failed to kill process" }, 500);
    }
  },

  "POST /api/ralph/dismiss": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    const { project, deletePlan } = body;
    if (typeof project !== "string") return json(res, { error: "invalid project" }, 400);
    if (deletePlan !== undefined && typeof deletePlan !== "boolean") {
      return json(res, { error: "deletePlan must be a boolean" }, 400);
    }
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;
    const status = parseRalphLog(projectDir);
    if (status?.active) {
      return json(res, { error: "cannot dismiss active loop — cancel it first" }, 409);
    }
    if (!status) {
      return json(res, { error: "no ralph log found" }, 404);
    }

    const deleted: string[] = [];
    const failed: string[] = [];

    const tryDelete = (path: string, label: string) => {
      try {
        if (existsSync(path)) { unlinkSync(path); deleted.push(label); }
      } catch (e: unknown) { log.warn(`dismiss: failed to delete ${label}`, { error: errMsg(e) }); failed.push(label); }
    };

    tryDelete(join(projectDir, ".ralph.log"), ".ralph.log");
    tryDelete(join(projectDir, ".ralph.lock"), ".ralph.lock");

    if (status.progressFile && SAFE_FILENAME.test(status.progressFile) && !status.progressFile.includes("..")) {
      tryDelete(join(projectDir, status.progressFile), status.progressFile);
    }

    if (deletePlan && status.planFile) {
      if (isValidPlanFile(status.planFile)) {
        tryDelete(join(projectDir, status.planFile), status.planFile);
      } else {
        failed.push(status.planFile);
      }
    }

    // Clean up worktrees if the worktree directory exists
    let worktreeCleanup: { removed: string[]; kept: string } | undefined;
    const worktreeDir = join(projectDir, ".wolfpack", "worktrees");
    if (existsSync(worktreeDir)) {
      try {
        const result = cleanupAllExceptFinal(projectDir);
        if (result.removed.length > 0 || result.kept) {
          worktreeCleanup = result;
        }
      } catch (e: unknown) {
        log.warn("dismiss: worktree cleanup failed", { error: errMsg(e) });
      }
    }

    json(res, { ok: true, deleted, failed, ...(worktreeCleanup && { worktreeCleanup }) });
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
    const result = addSubscription(sub);
    if (!result.ok) return json(res, { error: result.error }, 429);
    json(res, { ok: true });
  },

  "POST /api/push/unsubscribe": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (!body.endpoint || typeof body.endpoint !== "string") return json(res, { error: "missing endpoint" }, 400);
    removeSubscription(body.endpoint);
    json(res, { ok: true });
  },

  // ── Agent-triggered notifications ──

  "POST /api/notify": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (!body.message || typeof body.message !== "string") return json(res, { error: "missing message" }, 400);
    const message = body.message.slice(0, 500);

    const rateLimitError = checkNotifyRateLimit();
    if (rateLimitError) return json(res, { error: rateLimitError }, 429);

    const result = await sendPush({ title: "Wolfpack", body: message, tag: "wolfpack-notify" });
    json(res, { ok: true, ...result });
  },
};
