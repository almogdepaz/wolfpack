import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { AGENT_KIND, isCreatableHarness } from "../agent-kind.js";
import { createLogger, errMsg } from "../log.js";
import { detectProviderReadiness } from "../provider-readiness.js";
import {
  CMD_REGEX,
  MAX_INITIAL_PROMPT_LENGTH,
  isValidProjectName,
  isValidSessionName,
} from "../validation.js";
import { SESSION_CREATE_ERROR } from "../session-create-contract.js";
import {
  SESSION_OPEN_ERROR,
  SESSION_OPEN_HTTP_STATUS,
  SESSION_OPEN_MAX_MODEL_LENGTH,
  SESSION_TASK_WORKER_MAX_READINESS_TIMEOUT_MS,
} from "../session-open-contract.js";
import { unicodeCodePointLength } from "../session-prompt-contract.js";
import { DEV_DIR } from "./dev-dir.js";
import { browseServerDirectory } from "./directory-browser.js";
import type { DirectoryBrowseResult } from "./directory-browser.js";
import {
  DuplicateSessionError,
  getBackend,
} from "./backend.js";
import {
  hasOnlyKeys,
  hasOptionalType,
  isAllowedSession,
  isJsonObject,
  json,
  parseObjectBody,
  uniqueSessionName,
  validateProjectParam,
} from "./http.js";
import {
  projectDirectoryHttpStatus,
  resolveExistingProjectSelection,
} from "./project-selection.js";
import {
  validateExplicitProjectDir,
  validateProjectDir as validateProjectDirPure,
} from "./validate-project-dir.js";
import { inferAgentKind } from "./session-identity.js";
import type { ParentSessionIdentity } from "./session-identity.js";
import { createTopLevelSession } from "./session-create.js";
import { openSubSession, SessionOpenError } from "./session-open.js";
import {
  TaskWorkerReadinessError,
  prepareTaskWorkerLaunch,
} from "./task-worker-readiness.js";
import { notifySubSessionOpened } from "./session-notifications.js";
import { getTaskRelayGateway } from "../task-relay/gateway.js";
import type { InvalidBodyResponse } from "./http.js";
import type { RouteHandler } from "./route-handler.js";

const log = createLogger("routes");

const SESSION_OPEN_INVALID_BODY_RESPONSE = {
  envelope: {
    error: "invalid session-open request",
    code: SESSION_OPEN_ERROR.INVALID_REQUEST,
  },
  status: SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.INVALID_REQUEST],
} as const satisfies InvalidBodyResponse;

const CREATE_BODY_STRING_KEYS = [
  "project",
  "projectDir",
  "newProject",
  "newProjectParent",
  "cmd",
  "sessionName",
  "parentSession",
  "initialPrompt",
] as const;
const CREATE_BODY_KEYS = new Set<string>(CREATE_BODY_STRING_KEYS);
function validTaskWorkerReadinessTimeout(value: number | undefined): boolean {
  return value === undefined || (
    Number.isInteger(value)
    && value >= 1
    && value <= SESSION_TASK_WORKER_MAX_READINESS_TIMEOUT_MS
  );
}

function taskWorkerFailureBody(error: TaskWorkerReadinessError): Record<string, unknown> {
  return {
    error: error.message,
    code: error.code,
    ...(error.createdSession && { createdSession: error.createdSession }),
    ...(error.cleanup && { cleanup: error.cleanup }),
  };
}

const SETTINGS_BODY_STRING_KEYS = ["agentCmd", "addCmd", "removeCmd"] as const;
const SETTINGS_BODY_KEYS = new Set<string>([...SETTINGS_BODY_STRING_KEYS, "setCmdEnabled"]);
const SET_CMD_ENABLED_BODY_KEYS = new Set(["cmd", "enabled"]);

interface CreateBody extends Record<string, unknown> {
  project?: string;
  projectDir?: string;
  newProject?: string;
  newProjectParent?: string;
  cmd?: string;
  sessionName?: string;
  parentSession?: string;
  initialPrompt?: string;
}

function isCreateBody(body: Record<string, unknown>): body is CreateBody {
  return hasOnlyKeys(body, CREATE_BODY_KEYS)
    && CREATE_BODY_STRING_KEYS.every(key => hasOptionalType(body, key, "string"));
}

interface SessionCreateBody extends Record<string, unknown> {
  project?: string;
  projectDir?: string;
  harness?: string;
  initialPrompt?: string;
  taskWorker?: boolean;
  readinessTimeoutMs?: number;
}

function isSessionCreateBody(body: Record<string, unknown>): body is SessionCreateBody {
  const allowedKeys = new Set(["project", "projectDir", "harness", "initialPrompt", "taskWorker", "readinessTimeoutMs"]);
  return Object.keys(body).every(key => allowedKeys.has(key))
    && hasOptionalType(body, "project", "string")
    && hasOptionalType(body, "projectDir", "string")
    && hasOptionalType(body, "harness", "string")
    && hasOptionalType(body, "initialPrompt", "string")
    && hasOptionalType(body, "taskWorker", "boolean")
    && hasOptionalType(body, "readinessTimeoutMs", "number");
}

interface SessionOpenBody extends Record<string, unknown> {
  project?: string;
  projectDir?: string;
  parentSession: string;
  sessionName?: string;
  model?: string;
  initialPrompt?: string;
  taskWorker?: boolean;
  readinessTimeoutMs?: number;
}

function isSessionOpenBody(body: Record<string, unknown>): body is SessionOpenBody {
  const allowedKeys = new Set(["project", "projectDir", "parentSession", "sessionName", "model", "initialPrompt", "taskWorker", "readinessTimeoutMs"]);
  return Object.keys(body).every(key => allowedKeys.has(key))
    && hasOptionalType(body, "project", "string")
    && hasOptionalType(body, "projectDir", "string")
    && typeof body.parentSession === "string"
    && hasOptionalType(body, "sessionName", "string")
    && hasOptionalType(body, "model", "string")
    && hasOptionalType(body, "initialPrompt", "string")
    && hasOptionalType(body, "taskWorker", "boolean")
    && hasOptionalType(body, "readinessTimeoutMs", "number");
}

interface SettingsBody extends Record<string, unknown> {
  agentCmd?: string;
  addCmd?: string;
  removeCmd?: string;
  setCmdEnabled?: { cmd: string; enabled: boolean };
}

function isSettingsBody(body: Record<string, unknown>): body is SettingsBody {
  if (!hasOnlyKeys(body, SETTINGS_BODY_KEYS)
    || !SETTINGS_BODY_STRING_KEYS.every(key => hasOptionalType(body, key, "string"))) return false;
  return body.setCmdEnabled === undefined || (
    isJsonObject(body.setCmdEnabled) &&
    hasOnlyKeys(body.setCmdEnabled, SET_CMD_ENABLED_BODY_KEYS) &&
    typeof body.setCmdEnabled.cmd === "string" &&
    typeof body.setCmdEnabled.enabled === "boolean"
  );
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

type DirectoryBrowseFailure = Extract<DirectoryBrowseResult, { readonly ok: false }>;

type DirectoryBrowseHttpStatus = 400 | 403 | 404 | 422 | 503;

const DIRECTORY_BROWSE_HTTP_STATUS: Readonly<Record<
  DirectoryBrowseFailure["code"],
  DirectoryBrowseHttpStatus
>> = {
  invalid: 400,
  not_found: 404,
  permission_denied: 403,
  too_many_entries: 422,
  unavailable: 503,
};

function directoryBrowseHttpStatus(code: DirectoryBrowseFailure["code"]): DirectoryBrowseHttpStatus {
  return DIRECTORY_BROWSE_HTTP_STATUS[code];
}

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
  { cmd: AGENT_KIND.SHELL.id, enabled: true },
  { cmd: AGENT_KIND.CLAUDE.id, enabled: true },
  { cmd: AGENT_KIND.PI.id, enabled: true },
  { cmd: AGENT_KIND.CODEX.id, enabled: true },
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
  return cmd === AGENT_KIND.SHELL.id || CMD_REGEX.test(cmd);
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
    : AGENT_KIND.SHELL.id;

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
  return AGENT_KIND.SHELL.id;
}

/** What the session-create picker should show: enabled cmds, or ["shell"] if
 *  the user has disabled everything (always-on fallback). */
export function effectiveCmds(s: Settings): string[] {
  const enabled = s.cmds.filter(c => c.enabled).map(c => c.cmd);
  return enabled.length > 0 ? enabled : [AGENT_KIND.SHELL.id];
}

export const projectSettingsRoutes: Record<string, RouteHandler> = {
  "GET /api/projects": async (_req, res) => {
    const projects = listDevProjects();
    json(res, { projects });
  },

  "GET /api/directories": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const result = await browseServerDirectory(url.searchParams.get("path") ?? DEV_DIR);
    if (!result.ok) {
      json(res, { error: result.error, code: result.code }, directoryBrowseHttpStatus(result.code));
      return;
    }
    json(res, result.value);
  },

  "GET /api/next-session-name": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project") ?? undefined;
    const projectDir = url.searchParams.get("projectDir") ?? undefined;
    const newProject = url.searchParams.get("newProject") ?? undefined;
    if (newProject !== undefined) {
      if (project !== undefined || projectDir !== undefined || !isValidProjectName(newProject)) {
        json(res, { error: "invalid project selection" }, 400);
        return;
      }
      json(res, { name: await uniqueSessionName(newProject) });
      return;
    }
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
        error: "project selectors, cmd, sessionName, parentSession, and initialPrompt must be strings",
      }, 400);
    }
    const {
      project,
      projectDir: requestedProjectDir,
      newProject,
      newProjectParent,
      cmd,
      sessionName,
      parentSession,
      initialPrompt,
    } = body;
    if (
      (requestedProjectDir !== undefined
        && (project !== undefined || newProject !== undefined || newProjectParent !== undefined))
      || (newProjectParent !== undefined && newProject === undefined)
    ) {
      return json(res, { error: "invalid project selection" }, 400);
    }
    if (cmd && cmd !== AGENT_KIND.SHELL.id && !CMD_REGEX.test(cmd)) {
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
      if (!validateProjectParam(res, folderName)) return;
      let projectParent = DEV_DIR;
      if (newProjectParent !== undefined) {
        const parentValidation = validateExplicitProjectDir(newProjectParent);
        if (!parentValidation.ok) {
          json(res, { error: parentValidation.error }, projectDirectoryHttpStatus(parentValidation.code));
          return;
        }
        projectParent = parentValidation.projectDir;
      }
      const rootedProjectDir = join(projectParent, folderName);
      try { mkdirSync(rootedProjectDir, { recursive: true }); } catch (e: unknown) {
        log.error("/api/create: failed to create project directory", { path: rootedProjectDir, error: errMsg(e) });
      }
      const validation = newProjectParent === undefined
        ? validateProjectDirPure(rootedProjectDir)
        : validateExplicitProjectDir(rootedProjectDir);
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
      if (initialPrompt !== undefined && agentKind === AGENT_KIND.SHELL.id) {
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
      || !validTaskWorkerReadinessTimeout(body.readinessTimeoutMs)
      || (body.taskWorker !== undefined && body.taskWorker !== true)
      || (body.readinessTimeoutMs !== undefined && body.taskWorker !== true)
      || (body.taskWorker === true && (
        body.projectDir === undefined
        || body.initialPrompt !== undefined
      ))
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
    if (body.taskWorker === true && configuredCommand !== AGENT_KIND.PI.id) {
      return json(res, {
        error: "invalid session-create request",
        code: SESSION_CREATE_ERROR.INVALID_REQUEST,
      }, 400);
    }
    if (body.initialPrompt !== undefined && inferAgentKind(configuredCommand) === AGENT_KIND.SHELL.id) {
      return json(res, {
        error: "initial prompt requires an agent harness",
        code: SESSION_CREATE_ERROR.UNSUPPORTED_HARNESS,
      }, 400);
    }

    let taskWorker;
    try {
      taskWorker = body.taskWorker === true ? prepareTaskWorkerLaunch(process.env) : undefined;
    } catch (error: unknown) {
      if (error instanceof TaskWorkerReadinessError) {
        return json(res, taskWorkerFailureBody(error), 503);
      }
      throw error;
    }

    try {
      const backend = getBackend();
      const result = await createTopLevelSession({
        backend,
        project,
        projectDir,
        command: configuredCommand,
        initialPrompt: body.initialPrompt,
        ...(taskWorker !== undefined && {
          taskWorker,
          readinessTimeoutMs: body.readinessTimeoutMs,
          endpointForSession: (sessionId) => getTaskRelayGateway().endpointForSession(sessionId),
        }),
        loadSettings: () => ({ agentCmd: configuredCommand }),
      });
      json(res, result);
    } catch (error: unknown) {
      if (error instanceof TaskWorkerReadinessError) {
        return json(res, taskWorkerFailureBody(error), 503);
      }
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
        body.model !== undefined
        && (!body.model.trim()
          || unicodeCodePointLength(body.model) > SESSION_OPEN_MAX_MODEL_LENGTH)
      )
      || (
        body.initialPrompt !== undefined
        && (!body.initialPrompt.trim()
          || unicodeCodePointLength(body.initialPrompt) > MAX_INITIAL_PROMPT_LENGTH)
      )
      || !validTaskWorkerReadinessTimeout(body.readinessTimeoutMs)
      || (body.taskWorker !== undefined && body.taskWorker !== true)
      || (body.readinessTimeoutMs !== undefined && body.taskWorker !== true)
      || (body.taskWorker === true && (
        body.projectDir === undefined
        || body.initialPrompt !== undefined
      ))
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

    let taskWorker;
    try {
      taskWorker = body.taskWorker === true ? prepareTaskWorkerLaunch(process.env) : undefined;
    } catch (error: unknown) {
      if (error instanceof TaskWorkerReadinessError) {
        return json(res, taskWorkerFailureBody(error), 503);
      }
      throw error;
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
          inspectSession: backend.inspectSession?.bind(backend),
          killSessionById: backend.killSessionById.bind(backend),
        },
        parentSession: body.parentSession,
        project,
        projectDir,
        sessionName: body.sessionName,
        model: body.model,
        initialPrompt: body.initialPrompt,
        ...(taskWorker !== undefined && {
          taskWorker,
          readinessTimeoutMs: body.readinessTimeoutMs,
          endpointForSession: (sessionId) => getTaskRelayGateway().endpointForSession(sessionId),
        }),
        notify: (parent, session) => {
          notifySubSessionOpened(parent.wolfpackSessionName, session);
        },
      });
      json(res, result);
    } catch (error: unknown) {
      if (error instanceof TaskWorkerReadinessError) {
        return json(res, taskWorkerFailureBody(error), 503);
      }
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
};
