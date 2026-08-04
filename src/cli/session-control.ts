import { access, readFile } from "node:fs/promises";
import {
  isOpenableHarness,
  isSessionOpenErrorCode,
  SESSION_OPEN_ERROR,
} from "../session-open-contract.js";
import type {
  OpenableHarness,
  SessionOpenErrorCode,
} from "../session-open-contract.js";
import {
  isSessionCreateErrorCode,
  SESSION_CREATE_ERROR,
} from "../session-create-contract.js";
import type { SessionCreateErrorCode } from "../session-create-contract.js";
import {
  isBoundedSessionStatusIdentity,
  isSessionStatusErrorCode,
  parseSessionTerminalLiveness,
  SESSION_STATUS_ERROR_MESSAGE,
} from "../session-status-contract.js";
import type { SessionTerminalLiveness } from "../session-status-contract.js";
import { isValidSessionName, MAX_INITIAL_PROMPT_LENGTH } from "../validation.js";
import {
  SESSION_PROMPT_MAX_TIMEOUT_MS,
  SESSION_PROMPT_OUTCOME,
  SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS,
  unicodeCodePointLength,
} from "../session-prompt-contract.js";
import type {
  SessionPromptOutcome,
  SessionPromptWaitResult,
} from "../session-prompt-contract.js";
import { call as callApi } from "./api.js";
import { print, printError, printJson, red, yellow } from "./formatting.js";

export const SESSION_EXIT = {
  OK: 0,
  GENERAL: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  TIMEOUT: 4,
  AUTH: 5,
  BACKEND_UNAVAILABLE: 6,
} as const;

type OutputMode = "plain" | "json" | "shell";
type SessionAction = "create" | "open" | "status" | "read" | "send" | "wait" | "prompt" | "current-context";
const HELP_ALIASES = new Set(["--help", "-h", "help"]);

export function sessionCreateUsage(): string {
  return `Usage: wolfpack session create <project> [--harness <agent>] [--prompt|--prompt-file|--plan <value>] [--json]

Creates a top-level session. The server owns validation, naming, identity, and launch.
The optional prompt is passed to the agent harness at process startup.`;
}

export function sessionOpenUsage(): string {
  return `Usage: wolfpack session open <project> [--name <session>] [--prompt|--prompt-file|--plan <value>] [--notify-parent] [--json]

Deprecated alias for: wolfpack agent spawn <project> [--name <session>] [--prompt|--prompt-file|--plan <value>] [--notify-parent] [--json]`;
}

export function agentUsage(): string {
  return `Usage: wolfpack agent <command> [options]

Commands:
  wolfpack agent spawn <project> [--name <session>] [--prompt|--prompt-file|--plan <value>] [--notify-parent] [--json]
  wolfpack agent notify-parent [--message <text>] [--json]

Spawns a same-harness child of the current Wolfpack agent session or sends a user-visible notification from a child agent.`;
}

export function sessionUsage(): string {
  return `Usage: wolfpack session <command> [options]

Commands:
  wolfpack session create <project> [--harness <agent>] [--prompt|--prompt-file|--plan <value>] [--json]
  wolfpack session status <session-or-id> [--json]
  wolfpack session read <session-or-id> [--json]
  wolfpack session send <session-or-id> <text...> [--no-enter] [--json]
  wolfpack session wait <session-or-id> <text> [--timeout-ms <1..600000>] [--json]
  wolfpack session prompt <session-or-id> <prompt...> --until <text> [--no-enter] [--timeout-ms <1..600000>] [--json]
  wolfpack session current-context [--json|--shell]
  wolfpack session open <project> ...  Deprecated alias for 'wolfpack agent spawn'

Run 'wolfpack session create --help' or 'wolfpack agent --help' for details.`;
}

export type ParsedSessionCommand =
  | {
    readonly ok: true;
    readonly action: "create";
    readonly project: string;
    readonly harness: OpenableHarness | undefined;
    readonly prompt: string | undefined;
    readonly promptFile?: string;
    readonly plan?: string;
    readonly output: OutputMode;
  }
  | {
    readonly ok: true;
    readonly action: "open";
    readonly project: string;
    readonly sessionName?: string;
    readonly prompt: string | undefined;
    readonly promptFile?: string;
    readonly plan?: string;
    readonly notifyParent?: true;
    readonly output: OutputMode;
  }
  | { readonly ok: true; readonly action: "status"; readonly session: string; readonly output: OutputMode }
  | { readonly ok: true; readonly action: "read"; readonly session: string; readonly output: OutputMode }
  | { readonly ok: true; readonly action: "send"; readonly session: string; readonly text: string; readonly noEnter: boolean; readonly output: OutputMode }
  | { readonly ok: true; readonly action: "wait"; readonly session: string; readonly text: string; readonly timeoutMs: number; readonly output: OutputMode }
  | { readonly ok: true; readonly action: "prompt"; readonly session: string; readonly prompt: string; readonly outputContains: string; readonly noEnter: boolean; readonly timeoutMs: number; readonly output: OutputMode }
  | { readonly ok: true; readonly action: "current-context"; readonly output: OutputMode }
  | { readonly ok: false; readonly message: string };

export type ParsedAgentCommand =
  | {
    readonly ok: true;
    readonly action: "spawn";
    readonly project: string;
    readonly sessionName?: string;
    readonly prompt: string | undefined;
    readonly promptFile?: string;
    readonly plan?: string;
    readonly notifyParent?: true;
    readonly output: OutputMode;
  }
  | {
    readonly ok: true;
    readonly action: "notify-parent";
    readonly message: string | undefined;
    readonly output: OutputMode;
  }
  | { readonly ok: false; readonly message: string };

export type SessionOpenContext =
  | { readonly ok: true; readonly parentSession: string; readonly harness: OpenableHarness }
  | {
    readonly ok: false;
    readonly code: "MISSING_PARENT_SESSION" | typeof SESSION_OPEN_ERROR.UNSUPPORTED_HARNESS;
    readonly message: string;
  };

export function resolveSessionOpenContext(env: Readonly<Record<string, string | undefined>>): SessionOpenContext {
  const parentSession = env.WOLFPACK_SESSION_NAME?.trim();
  if (!parentSession) {
    return { ok: false, code: "MISSING_PARENT_SESSION", message: "wolfpack session context is missing" };
  }
  const harness = env.WOLFPACK_AGENT_KIND?.trim().toLowerCase();
  if (!harness || !isOpenableHarness(harness)) {
    return {
      ok: false,
      code: SESSION_OPEN_ERROR.UNSUPPORTED_HARNESS,
      message: "current Wolfpack session is not running a supported agent harness",
    };
  }
  return { ok: true, parentSession, harness };
}

interface ApiError {
  readonly status: number;
  readonly body: string;
  readonly code?: string;
}

function structuredErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return undefined;
    const code = (parsed as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  let resp: Response;
  try {
    resp = await callApi(path, init);
  } catch (e: unknown) {
    throw { status: 0, body: e instanceof Error ? e.message : String(e) } satisfies ApiError;
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw { status: resp.status, body, code: structuredErrorCode(body) } satisfies ApiError;
  }
  return resp.json();
}

function consumeFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function consumeValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) return "";
  args.splice(idx, 2);
  return value;
}

const LAUNCH_KNOWN_OPTIONS = new Set([
  "--json",
  "--shell",
  "--prompt",
  "--prompt-file",
  "--plan",
  "--name",
  "--session-name",
  "--notify-parent",
  "--harness",
  "--message",
]);

function consumeLaunchValue(args: string[], flag: string): string | null {
  const directIndex = args.indexOf(flag);
  const equalsPrefix = `${flag}=`;
  const equalsIndexes = args.flatMap((arg, index) => arg.startsWith(equalsPrefix) ? [index] : []);
  if ((directIndex !== -1 && equalsIndexes.length > 0) || equalsIndexes.length > 1) return "";
  const equalsIndex = equalsIndexes[0];
  if (equalsIndex !== undefined) {
    const [value] = args.splice(equalsIndex, 1);
    return value.slice(equalsPrefix.length);
  }
  if (directIndex === -1) return null;
  const value = args[directIndex + 1];
  if (value === undefined || LAUNCH_KNOWN_OPTIONS.has(value)) {
    args.splice(directIndex, 1);
    return "";
  }
  args.splice(directIndex, 2);
  return value;
}

function parseOutputMode(args: string[]): { mode: OutputMode; shellRequested: boolean } {
  const json = consumeFlag(args, "--json");
  const shell = consumeFlag(args, "--shell");
  return { mode: shell ? "shell" : json ? "json" : "plain", shellRequested: shell };
}

export function parseSessionCommand(argv: readonly string[]): ParsedSessionCommand {
  const args = [...argv];
  const action = args.shift() as SessionAction | undefined;
  if (!action) return { ok: false, message: "Usage: wolfpack session <create|status|read|send|wait|prompt|current-context> ..." };
  if (!["create", "open", "status", "read", "send", "wait", "prompt", "current-context"].includes(action)) {
    return { ok: false, message: `Unknown session command: ${action}` };
  }
  const isLaunch = action === "create" || action === "open";
  const promptValue = isLaunch ? consumeLaunchValue(args, "--prompt") : null;
  const promptFileValue = isLaunch ? consumeLaunchValue(args, "--prompt-file") : null;
  const planValue = isLaunch ? consumeLaunchValue(args, "--plan") : null;
  const nameValue = action === "open" ? (consumeLaunchValue(args, "--name") ?? consumeLaunchValue(args, "--session-name")) : null;
  const notifyParent = isLaunch ? consumeFlag(args, "--notify-parent") : false;
  const harnessValue = action === "create" ? consumeValue(args, "--harness") : null;
  const { mode: output, shellRequested } = parseOutputMode(args);
  if (isLaunch) {
    if (shellRequested) return { ok: false, message: "--shell is only valid for current-context" };
    const prompt = promptValue ?? undefined;
    const promptFile = promptFileValue ?? undefined;
    const plan = planValue ?? undefined;
    const sessionName = nameValue ?? undefined;
    const project = args.shift();
    const harness = harnessValue !== null && isOpenableHarness(harnessValue)
      ? harnessValue
      : undefined;
    const promptSources = [promptValue, promptFileValue, planValue].filter(value => value !== null);
    const validPrompt = prompt === undefined
      || (prompt.trim().length > 0
        && unicodeCodePointLength(prompt) <= MAX_INITIAL_PROMPT_LENGTH);
    const validPromptFile = promptFileValue === null || Boolean(promptFileValue.trim());
    const validPlan = planValue === null || Boolean(planValue.trim());
    const validSessionName = action !== "open"
      || nameValue === null
      || (Boolean(nameValue.trim()) && isValidSessionName(nameValue));
    const validPromptSources = promptSources.length <= 1 && validPromptFile && validPlan;
    const validHarness = action !== "create"
      || harnessValue === null
      || harness !== undefined;
    const validNotify = action !== "create" || !notifyParent;
    if (!project || args.length > 0 || !validPrompt || !validPromptSources || !validSessionName || !validHarness || !validNotify) {
      return {
        ok: false,
        message: action === "create" ? sessionCreateUsage().split("\n")[0] : sessionOpenUsage().split("\n")[0],
      };
    }
    if (action === "create") {
      return {
        ok: true,
        action,
        project,
        harness,
        prompt,
        ...(promptFile !== undefined && { promptFile }),
        ...(plan !== undefined && { plan }),
        output,
      };
    }
    return {
      ok: true,
      action,
      project,
      ...(sessionName !== undefined && { sessionName }),
      prompt,
      ...(promptFile !== undefined && { promptFile }),
      ...(plan !== undefined && { plan }),
      ...(notifyParent && { notifyParent: true }),
      output,
    };
  }
  if (action === "current-context") {
    if (args.length > 0) return { ok: false, message: "Usage: wolfpack session current-context [--json|--shell]" };
    return { ok: true, action, output };
  }
  if (shellRequested) {
    return { ok: false, message: "--shell is only valid for current-context" };
  }
  const session = args.shift();
  if (!session) return { ok: false, message: `Usage: wolfpack session ${action} <session> ...` };
  if (action === "status" || action === "read") {
    if (args.length > 0) return { ok: false, message: `Usage: wolfpack session ${action} <session-or-id> [--json]` };
    return { ok: true, action, session, output };
  }
  if (action === "send") {
    const noEnter = consumeFlag(args, "--no-enter");
    const text = args.join(" ");
    if (!text) return { ok: false, message: "Usage: wolfpack session send <session> <text...> [--no-enter] [--json]" };
    return { ok: true, action, session, text, noEnter, output };
  }
  if (action === "prompt") {
    const noEnter = consumeFlag(args, "--no-enter");
    const outputContains = consumeValue(args, "--until");
    const timeoutRaw = consumeValue(args, "--timeout-ms");
    const timeoutMs = timeoutRaw == null ? 30_000 : Number(timeoutRaw);
    const prompt = args.join(" ");
    if (
      !prompt
      || unicodeCodePointLength(prompt) > MAX_INITIAL_PROMPT_LENGTH
      || !outputContains
      || unicodeCodePointLength(outputContains) > SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS
      || !Number.isInteger(timeoutMs)
      || timeoutMs < 1
      || timeoutMs > SESSION_PROMPT_MAX_TIMEOUT_MS
    ) {
      return {
        ok: false,
        message: "Usage: wolfpack session prompt <session-or-id> <prompt...> --until <text> [--no-enter] [--timeout-ms <1..600000>] [--json]",
      };
    }
    return {
      ok: true,
      action,
      session,
      prompt,
      outputContains,
      noEnter,
      timeoutMs,
      output,
    };
  }
  const timeoutRaw = consumeValue(args, "--timeout-ms");
  const timeoutMs = timeoutRaw == null ? 30_000 : Number(timeoutRaw);
  const text = args.join(" ");
  if (!text || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    return { ok: false, message: "Usage: wolfpack session wait <session> <text> [--timeout-ms <1..600000>] [--json]" };
  }
  return { ok: true, action, session, text, timeoutMs, output };
}

export function parseAgentCommand(argv: readonly string[]): ParsedAgentCommand {
  const [action, ...rest] = argv;
  const args = [...rest];
  if (action === "notify-parent") {
    const messageValue = consumeLaunchValue(args, "--message");
    const { mode: output, shellRequested } = parseOutputMode(args);
    const message = messageValue ?? (args.length > 0 ? args.join(" ") : undefined);
    const validMessage = message === undefined || (message.trim().length > 0 && message.length <= 500);
    if (shellRequested || !validMessage || (messageValue !== null && args.length > 0)) {
      return { ok: false, message: "Usage: wolfpack agent notify-parent [--message <text>] [--json]" };
    }
    return { ok: true, action: "notify-parent", message, output };
  }
  if (action !== "spawn") {
    return { ok: false, message: action ? `Unknown agent command: ${action}` : "Usage: wolfpack agent spawn <project> ..." };
  }
  const parsed = parseSessionCommand(["open", ...args]);
  const usage = "Usage: wolfpack agent spawn <project> [--name <session>] [--prompt|--prompt-file|--plan <value>] [--notify-parent] [--json]";
  if (!parsed.ok) return { ok: false, message: usage };
  if (parsed.action !== "open") return { ok: false, message: "Usage: wolfpack agent spawn <project> ..." };
  return {
    ok: true,
    action: "spawn",
    project: parsed.project,
    ...(parsed.sessionName !== undefined && { sessionName: parsed.sessionName }),
    prompt: parsed.prompt,
    ...(parsed.promptFile !== undefined && { promptFile: parsed.promptFile }),
    ...(parsed.plan !== undefined && { plan: parsed.plan }),
    ...(parsed.notifyParent && { notifyParent: true }),
    output: parsed.output,
  };
}

function jsonOut(value: unknown): void {
  printJson(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const SESSION_API_FAILURES: Readonly<Record<number, CliErrorDescriptor & { readonly code: string }>> = {
  400: { code: "INVALID_REQUEST", message: "invalid request", exitCode: SESSION_EXIT.GENERAL },
  401: { code: "AUTH_REQUIRED", message: "auth required", exitCode: SESSION_EXIT.AUTH },
  404: { code: "SESSION_NOT_FOUND", message: "session not found", exitCode: SESSION_EXIT.NOT_FOUND },
  408: { code: "TIMEOUT", message: "timeout", exitCode: SESSION_EXIT.TIMEOUT },
  409: { code: "AMBIGUOUS_SELECTOR", message: "ambiguous session selector", exitCode: SESSION_EXIT.GENERAL },
  410: { code: "SESSION_DEAD", message: "session is not alive", exitCode: SESSION_EXIT.NOT_FOUND },
  503: { code: "BACKEND_UNAVAILABLE", message: "backend unavailable", exitCode: SESSION_EXIT.BACKEND_UNAVAILABLE },
};

function parseStructuredFailure(
  body: string | undefined,
  failure: CliErrorDescriptor & { readonly code: string },
): unknown {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const envelope = parsed as Record<string, unknown>;
    if (envelope.ok !== false || !envelope.error || typeof envelope.error !== "object") return undefined;
    const error = envelope.error as Record<string, unknown>;
    if (!isSessionStatusErrorCode(error.code) || error.code !== failure.code) return undefined;
    const terminal = parseSessionTerminalLiveness(envelope.terminal);
    return {
      ok: false,
      ...(isBoundedSessionStatusIdentity(envelope.selector) && { selector: envelope.selector }),
      ...(isBoundedSessionStatusIdentity(envelope.session) && { session: envelope.session }),
      ...(isBoundedSessionStatusIdentity(envelope.sessionId) && { sessionId: envelope.sessionId }),
      ...(terminal && { terminal }),
      error: {
        code: error.code,
        message: SESSION_STATUS_ERROR_MESSAGE[error.code],
      },
    };
  } catch {
    return undefined;
  }
}

function mapApiError(e: unknown, output: OutputMode): number {
  const err = e as Partial<ApiError>;
  const failure = SESSION_API_FAILURES[err.status ?? 0] ?? {
    code: "SESSION_COMMAND_FAILED",
    message: "session command failed",
    exitCode: SESSION_EXIT.GENERAL,
  };
  const structured = output === "json" ? parseStructuredFailure(err.body, failure) : undefined;
  if (structured !== undefined) jsonOut(structured);
  else if (output === "json") jsonOut({ ok: false, error: { code: failure.code, message: failure.message } });
  else printError((failure.exitCode === SESSION_EXIT.NOT_FOUND || failure.exitCode === SESSION_EXIT.TIMEOUT)
    ? yellow(failure.message)
    : red(failure.message));
  return failure.exitCode;
}

interface SessionLaunchResponse {
  readonly ok: true;
  readonly session: string;
  readonly sessionId: string;
  readonly project: string;
  readonly harness: string;
}

interface SessionPromptResponse extends SessionPromptWaitResult {
  readonly ok: boolean;
  readonly session: string;
  readonly sessionId: string;
}

const SESSION_PROMPT_EXIT: Readonly<Record<SessionPromptOutcome, number>> = {
  [SESSION_PROMPT_OUTCOME.MATCHED]: SESSION_EXIT.OK,
  [SESSION_PROMPT_OUTCOME.TIMED_OUT]: SESSION_EXIT.TIMEOUT,
  [SESSION_PROMPT_OUTCOME.TARGET_EXITED]: SESSION_EXIT.NOT_FOUND,
  [SESSION_PROMPT_OUTCOME.TARGET_UNAVAILABLE]: SESSION_EXIT.NOT_FOUND,
  [SESSION_PROMPT_OUTCOME.TARGET_REPLACED]: SESSION_EXIT.NOT_FOUND,
  [SESSION_PROMPT_OUTCOME.REPLAY_GAP]: SESSION_EXIT.GENERAL,
  [SESSION_PROMPT_OUTCOME.BACKEND_UNAVAILABLE]: SESSION_EXIT.BACKEND_UNAVAILABLE,
};

interface SessionStatusResponse {
  readonly ok: true;
  readonly selector: string;
  readonly session: string;
  readonly sessionId: string;
  readonly state: "active";
  readonly project: string;
  readonly projectPath: string;
  readonly projectDir: string;
  readonly harness: string;
  readonly terminal: SessionTerminalLiveness;
  readonly parentSession?: {
    readonly session: string;
    readonly sessionId: string;
  };
}

function writeOpenError(
  output: OutputMode,
  code: string,
  message: string,
  exitCode: number,
): number {
  if (output === "json") jsonOut({ ok: false, error: { code, message } });
  else printError(red(message));
  return exitCode;
}

interface CliErrorDescriptor {
  readonly message: string;
  readonly exitCode: number;
}

const OPEN_API_ERRORS: Readonly<Record<SessionOpenErrorCode, CliErrorDescriptor>> = {
  [SESSION_OPEN_ERROR.INVALID_REQUEST]: {
    message: "invalid session-open request",
    exitCode: SESSION_EXIT.GENERAL,
  },
  [SESSION_OPEN_ERROR.PROJECT_NOT_FOUND]: {
    message: "project not found",
    exitCode: SESSION_EXIT.NOT_FOUND,
  },
  [SESSION_OPEN_ERROR.PARENT_SESSION_NOT_FOUND]: {
    message: "parent Wolfpack session is not active",
    exitCode: SESSION_EXIT.NOT_FOUND,
  },
  [SESSION_OPEN_ERROR.PARENT_SESSION_CHANGED]: {
    message: "parent Wolfpack session changed",
    exitCode: SESSION_EXIT.GENERAL,
  },
  [SESSION_OPEN_ERROR.PARENT_IDENTITY_UNAVAILABLE]: {
    message: "parent Wolfpack session identity unavailable",
    exitCode: SESSION_EXIT.BACKEND_UNAVAILABLE,
  },
  [SESSION_OPEN_ERROR.UNSUPPORTED_HARNESS]: {
    message: "parent Wolfpack session is not running a supported agent harness",
    exitCode: SESSION_EXIT.GENERAL,
  },
  [SESSION_OPEN_ERROR.NAME_COLLISION]: {
    message: "could not allocate a sub-agent session name",
    exitCode: SESSION_EXIT.GENERAL,
  },
  [SESSION_OPEN_ERROR.BACKEND_UNAVAILABLE]: {
    message: "backend unavailable",
    exitCode: SESSION_EXIT.BACKEND_UNAVAILABLE,
  },
};

export function sessionOpenCliError(code: SessionOpenErrorCode): CliErrorDescriptor {
  return OPEN_API_ERRORS[code];
}

const CREATE_API_ERRORS: Readonly<Record<SessionCreateErrorCode, CliErrorDescriptor>> = {
  [SESSION_CREATE_ERROR.INVALID_REQUEST]: {
    message: "invalid session-create request",
    exitCode: SESSION_EXIT.GENERAL,
  },
  [SESSION_CREATE_ERROR.PROJECT_NOT_FOUND]: {
    message: "project not found",
    exitCode: SESSION_EXIT.NOT_FOUND,
  },
  [SESSION_CREATE_ERROR.UNSUPPORTED_HARNESS]: {
    message: "selected session command cannot accept an initial prompt",
    exitCode: SESSION_EXIT.GENERAL,
  },
  [SESSION_CREATE_ERROR.NAME_COLLISION]: {
    message: "could not allocate a session name",
    exitCode: SESSION_EXIT.GENERAL,
  },
  [SESSION_CREATE_ERROR.BACKEND_UNAVAILABLE]: {
    message: "backend unavailable",
    exitCode: SESSION_EXIT.BACKEND_UNAVAILABLE,
  },
};

function mapCreateApiError(output: OutputMode, error: unknown): number {
  const apiError = error as Partial<ApiError>;
  if (apiError.status === 401) {
    return writeOpenError(output, "AUTH_REQUIRED", "auth required", SESSION_EXIT.AUTH);
  }
  if (apiError.code && isSessionCreateErrorCode(apiError.code)) {
    const known = CREATE_API_ERRORS[apiError.code];
    return writeOpenError(output, apiError.code, known.message, known.exitCode);
  }
  return writeOpenError(output, "CREATE_FAILED", "session creation failed", SESSION_EXIT.GENERAL);
}

function mapOpenApiError(output: OutputMode, error: unknown): number {
  const apiError = error as Partial<ApiError>;
  if (apiError.status === 401) {
    return writeOpenError(output, "AUTH_REQUIRED", "auth required", SESSION_EXIT.AUTH);
  }
  if (apiError.code && isSessionOpenErrorCode(apiError.code)) {
    const known = sessionOpenCliError(apiError.code);
    return writeOpenError(output, apiError.code, known.message, known.exitCode);
  }
  if (apiError.status === 404) {
    return writeOpenError(
      output,
      SESSION_OPEN_ERROR.PROJECT_NOT_FOUND,
      "project not found",
      SESSION_EXIT.NOT_FOUND,
    );
  }
  if (apiError.status === 503) {
    return writeOpenError(
      output,
      SESSION_OPEN_ERROR.BACKEND_UNAVAILABLE,
      "backend unavailable",
      SESSION_EXIT.BACKEND_UNAVAILABLE,
    );
  }
  return writeOpenError(output, "CREATE_FAILED", "session creation failed", SESSION_EXIT.GENERAL);
}

interface LaunchPromptSource {
  readonly prompt: string | undefined;
  readonly promptFile?: string;
  readonly plan?: string;
  readonly notifyParent?: true;
  readonly output: OutputMode;
}

const NOTIFY_PARENT_PROMPT = "when done or blocked, run `wolfpack agent notify-parent` once, then summarize changes, verification, and concerns.";

function compactPlanPrompt(plan: string, notifyParent?: true): string {
  const base = `implement ${plan}. read repo instructions and the full plan first; update plan status as work progresses. preserve unrelated dirty work. do not commit, push, merge, or deploy. when done or blocked, leave this session open and summarize changes, verification, and concerns.`;
  return notifyParent ? `${base} ${NOTIFY_PARENT_PROMPT}` : base;
}

async function readPromptFile(path: string, output: OutputMode): Promise<string | number> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return writeOpenError(output, "PROMPT_FILE_UNREADABLE", "prompt file not readable", SESSION_EXIT.NOT_FOUND);
  }
}

async function verifyReadablePlan(path: string, output: OutputMode): Promise<number | undefined> {
  try {
    await access(path);
    return undefined;
  } catch {
    return writeOpenError(output, "PLAN_FILE_UNREADABLE", "plan file not readable", SESSION_EXIT.NOT_FOUND);
  }
}

async function materializeInitialPrompt(source: LaunchPromptSource): Promise<string | undefined | number> {
  let prompt = source.prompt;
  let includesNotifyParent = false;
  if (source.promptFile !== undefined) {
    const promptFileContent = await readPromptFile(source.promptFile, source.output);
    if (typeof promptFileContent === "number") return promptFileContent;
    prompt = promptFileContent;
  } else if (source.plan !== undefined) {
    const planError = await verifyReadablePlan(source.plan, source.output);
    if (planError !== undefined) return planError;
    prompt = compactPlanPrompt(source.plan, source.notifyParent);
    includesNotifyParent = Boolean(source.notifyParent);
  }
  if (source.notifyParent && !includesNotifyParent) {
    prompt = prompt !== undefined ? `${prompt} ${NOTIFY_PARENT_PROMPT}` : NOTIFY_PARENT_PROMPT;
  }

  if (
    prompt !== undefined
    && (!prompt.trim() || unicodeCodePointLength(prompt) > MAX_INITIAL_PROMPT_LENGTH)
  ) {
    return writeOpenError(source.output, "INVALID_PROMPT", "invalid initial prompt", SESSION_EXIT.USAGE);
  }
  return prompt;
}

async function runSessionOpen(
  parsed: {
    readonly project: string;
    readonly sessionName?: string;
    readonly prompt: string | undefined;
    readonly promptFile?: string;
    readonly plan?: string;
    readonly notifyParent?: true;
    readonly output: OutputMode;
  },
): Promise<number> {
  const context = resolveSessionOpenContext(process.env);
  if (!context.ok) {
    return writeOpenError(parsed.output, context.code, context.message, SESSION_EXIT.NOT_FOUND);
  }
  const initialPrompt = await materializeInitialPrompt(parsed);
  if (typeof initialPrompt === "number") return initialPrompt;

  try {
    const response = await call("/api/session-open", {
      method: "POST",
      body: JSON.stringify({
        project: parsed.project,
        parentSession: context.parentSession,
        ...(parsed.sessionName !== undefined && { sessionName: parsed.sessionName }),
        ...(initialPrompt !== undefined && { initialPrompt }),
      }),
    }) as SessionLaunchResponse;
    if (parsed.output === "json") jsonOut(response);
    else print(response.session);
    return SESSION_EXIT.OK;
  } catch (error: unknown) {
    return mapOpenApiError(parsed.output, error);
  }
}

async function runSessionCreate(
  parsed: Extract<ParsedSessionCommand, { readonly action: "create" }>,
): Promise<number> {
  const initialPrompt = await materializeInitialPrompt(parsed);
  if (typeof initialPrompt === "number") return initialPrompt;

  try {
    const response = await call("/api/session-create", {
      method: "POST",
      body: JSON.stringify({
        project: parsed.project,
        ...(parsed.harness !== undefined && { harness: parsed.harness }),
        ...(initialPrompt !== undefined && { initialPrompt }),
      }),
    }) as SessionLaunchResponse;
    if (parsed.output === "json") jsonOut(response);
    else print(response.session);
    return SESSION_EXIT.OK;
  } catch (error: unknown) {
    return mapCreateApiError(parsed.output, error);
  }
}

function defaultNotifyParentMessage(): string {
  const session = process.env.WOLFPACK_SESSION_NAME?.trim() || "Wolfpack sub-agent";
  return `${session} finished or blocked; ready for parent review`;
}

async function runNotifyParent(
  parsed: Extract<ParsedAgentCommand, { readonly action: "notify-parent" }>,
): Promise<number> {
  const message = parsed.message ?? defaultNotifyParentMessage();
  const parentSessionId = process.env.WOLFPACK_PARENT_SESSION_ID?.trim();
  const parentSessionName = process.env.WOLFPACK_PARENT_SESSION_NAME?.trim();
  try {
    const response = await call("/api/notify", {
      method: "POST",
      body: JSON.stringify({
        message,
        ...(parentSessionId && parentSessionName && {
          sessionId: parentSessionId,
          sessionName: parentSessionName,
        }),
      }),
    });
    if (parsed.output === "json") jsonOut(response);
    else print("notified");
    return SESSION_EXIT.OK;
  } catch (error: unknown) {
    return mapApiError(error, parsed.output);
  }
}

export async function runAgentCommand(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && HELP_ALIASES.has(argv[0])) {
    print(agentUsage());
    return SESSION_EXIT.OK;
  }
  if (argv.length === 2 && argv[0] === "spawn" && HELP_ALIASES.has(argv[1])) {
    print(agentUsage());
    return SESSION_EXIT.OK;
  }
  if (argv.length === 2 && argv[0] === "notify-parent" && HELP_ALIASES.has(argv[1])) {
    print(agentUsage());
    return SESSION_EXIT.OK;
  }
  const parsed = parseAgentCommand(argv);
  if (!parsed.ok) {
    printError(red(parsed.message));
    return SESSION_EXIT.USAGE;
  }
  if (parsed.action === "notify-parent") return runNotifyParent(parsed);
  return runSessionOpen(parsed);
}

export async function runSessionCommand(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && HELP_ALIASES.has(argv[0])) {
    print(sessionUsage());
    return SESSION_EXIT.OK;
  }
  if (argv.length === 2 && argv[0] === "create" && HELP_ALIASES.has(argv[1])) {
    print(sessionCreateUsage());
    return SESSION_EXIT.OK;
  }
  if (argv.length === 2 && argv[0] === "open" && HELP_ALIASES.has(argv[1])) {
    print(sessionOpenUsage());
    return SESSION_EXIT.OK;
  }

  const parsed = parseSessionCommand(argv);
  if (!parsed.ok) {
    printError(red(parsed.message));
    return SESSION_EXIT.USAGE;
  }

  if (parsed.action === "create") return runSessionCreate(parsed);
  if (parsed.action === "open") return runSessionOpen(parsed);

  if (parsed.action === "current-context") {
    const context = {
      session: process.env.WOLFPACK_SESSION_NAME || "",
      projectDir: process.env.WOLFPACK_PROJECT_DIR || "",
    };
    if (!context.session && !context.projectDir) {
      if (parsed.output === "json") jsonOut(context);
      else printError(yellow("no wolfpack context in this process"));
      return SESSION_EXIT.NOT_FOUND;
    }
    if (parsed.output === "json") jsonOut(context);
    else if (parsed.output === "shell") {
      process.stdout.write(`WOLFPACK_SESSION_NAME=${shellQuote(context.session)}\n`);
      process.stdout.write(`WOLFPACK_PROJECT_DIR=${shellQuote(context.projectDir)}\n`);
    } else {
      if (context.session) print(context.session);
      if (context.projectDir) print(context.projectDir);
    }
    return SESSION_EXIT.OK;
  }

  try {
    if (parsed.action === "status") {
      const data = await call(
        `/api/session-control/status?session=${encodeURIComponent(parsed.session)}`,
      ) as SessionStatusResponse;
      if (parsed.output === "json") jsonOut(data);
      else {
        print(`${data.session} (${data.sessionId})`);
        print(`${data.state} ${data.harness} ${data.projectPath}`);
      }
      return SESSION_EXIT.OK;
    }
    if (parsed.action === "read") {
      const data = await call(`/api/session-control/read?session=${encodeURIComponent(parsed.session)}`) as {
        session: string;
        sessionId: string;
        output: string;
      };
      if (parsed.output === "json") jsonOut(data);
      else process.stdout.write(data.output);
      return SESSION_EXIT.OK;
    }
    if (parsed.action === "send") {
      const data = await call("/api/session-control/send", {
        method: "POST",
        body: JSON.stringify({ session: parsed.session, text: parsed.text, noEnter: parsed.noEnter }),
      });
      if (parsed.output === "json") jsonOut(data);
      return SESSION_EXIT.OK;
    }
    if (parsed.action === "prompt") {
      const data = await call("/api/session-control/prompt", {
        method: "POST",
        body: JSON.stringify({
          session: parsed.session,
          prompt: parsed.prompt,
          outputContains: parsed.outputContains,
          noEnter: parsed.noEnter,
          timeoutMs: parsed.timeoutMs,
        }),
      }) as SessionPromptResponse;
      if (parsed.output === "json") jsonOut(data);
      else if (data.outcome !== SESSION_PROMPT_OUTCOME.MATCHED) print(yellow(data.outcome));
      return SESSION_PROMPT_EXIT[data.outcome] ?? SESSION_EXIT.GENERAL;
    }
    const data = await call("/api/session-control/wait", {
      method: "POST",
      body: JSON.stringify({ session: parsed.session, text: parsed.text, timeoutMs: parsed.timeoutMs }),
    });
    if (parsed.output === "json") jsonOut(data);
    return SESSION_EXIT.OK;
  } catch (e: unknown) {
    return mapApiError(e, parsed.output);
  }
}
