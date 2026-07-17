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
import { MAX_INITIAL_PROMPT_LENGTH } from "../validation.js";
import { call as callApi } from "./api.js";
import { print, red, yellow } from "./formatting.js";

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
type SessionAction = "create" | "open" | "status" | "read" | "send" | "wait" | "current-context";
const HELP_ALIASES = new Set(["--help", "-h", "help"]);

export function sessionCreateUsage(): string {
  return `Usage: wolfpack session create <project> [--harness <agent>] [--prompt <instruction>] [--json]

Creates a top-level session. The server owns validation, naming, identity, and launch.
The optional prompt is passed to the agent harness at process startup.`;
}

export function sessionOpenUsage(): string {
  return `Usage: wolfpack session open <project> [--prompt <instruction>] [--json]

Deprecated alias for: wolfpack agent spawn <project> [--prompt <instruction>] [--json]`;
}

export function agentUsage(): string {
  return `Usage: wolfpack agent <command> [options]

Commands:
  wolfpack agent spawn <project> [--prompt <instruction>] [--json]

Spawns a same-harness child of the current Wolfpack agent session.`;
}

export function sessionUsage(): string {
  return `Usage: wolfpack session <command> [options]

Commands:
  wolfpack session create <project> [--harness <agent>] [--prompt <instruction>] [--json]
  wolfpack session status <session-or-id> [--json]
  wolfpack session read <session-or-id> [--json]
  wolfpack session send <session-or-id> <text...> [--no-enter] [--json]
  wolfpack session wait <session-or-id> <text> [--timeout-ms <1..600000>] [--json]
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
    readonly output: OutputMode;
  }
  | {
    readonly ok: true;
    readonly action: "open";
    readonly project: string;
    readonly prompt: string | undefined;
    readonly output: OutputMode;
  }
  | { readonly ok: true; readonly action: "status"; readonly session: string; readonly output: OutputMode }
  | { readonly ok: true; readonly action: "read"; readonly session: string; readonly output: OutputMode }
  | { readonly ok: true; readonly action: "send"; readonly session: string; readonly text: string; readonly noEnter: boolean; readonly output: OutputMode }
  | { readonly ok: true; readonly action: "wait"; readonly session: string; readonly text: string; readonly timeoutMs: number; readonly output: OutputMode }
  | { readonly ok: true; readonly action: "current-context"; readonly output: OutputMode }
  | { readonly ok: false; readonly message: string };

export type ParsedAgentCommand =
  | {
    readonly ok: true;
    readonly action: "spawn";
    readonly project: string;
    readonly prompt: string | undefined;
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

const LAUNCH_KNOWN_OPTIONS = new Set(["--json", "--shell", "--prompt", "--harness"]);

function consumeLaunchPrompt(args: string[]): string | null {
  const directIndex = args.indexOf("--prompt");
  const equalsIndexes = args.flatMap((arg, index) => arg.startsWith("--prompt=") ? [index] : []);
  if ((directIndex !== -1 && equalsIndexes.length > 0) || equalsIndexes.length > 1) return "";
  const equalsIndex = equalsIndexes[0];
  if (equalsIndex !== undefined) {
    const [value] = args.splice(equalsIndex, 1);
    return value.slice("--prompt=".length);
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
  if (!action) return { ok: false, message: "Usage: wolfpack session <create|status|read|send|wait|current-context> ..." };
  if (!["create", "open", "status", "read", "send", "wait", "current-context"].includes(action)) {
    return { ok: false, message: `Unknown session command: ${action}` };
  }
  const promptValue = action === "create" || action === "open" ? consumeLaunchPrompt(args) : null;
  const harnessValue = action === "create" ? consumeValue(args, "--harness") : null;
  const { mode: output, shellRequested } = parseOutputMode(args);
  if (action === "create" || action === "open") {
    if (shellRequested) return { ok: false, message: "--shell is only valid for current-context" };
    const prompt = promptValue ?? undefined;
    const project = args.shift();
    const harness = harnessValue !== null && isOpenableHarness(harnessValue)
      ? harnessValue
      : undefined;
    const validPrompt = prompt === undefined
      || (prompt.trim().length > 0 && prompt.length <= MAX_INITIAL_PROMPT_LENGTH);
    const validHarness = action !== "create"
      || harnessValue === null
      || harness !== undefined;
    if (!project || args.length > 0 || !validPrompt || !validHarness) {
      return {
        ok: false,
        message: action === "create" ? sessionCreateUsage().split("\n")[0] : sessionOpenUsage().split("\n")[0],
      };
    }
    if (action === "create") return { ok: true, action, project, harness, prompt, output };
    return { ok: true, action, project, prompt, output };
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
  const timeoutRaw = consumeValue(args, "--timeout-ms");
  const timeoutMs = timeoutRaw == null ? 30_000 : Number(timeoutRaw);
  const text = args.join(" ");
  if (!text || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    return { ok: false, message: "Usage: wolfpack session wait <session> <text> [--timeout-ms <1..600000>] [--json]" };
  }
  return { ok: true, action, session, text, timeoutMs, output };
}

export function parseAgentCommand(argv: readonly string[]): ParsedAgentCommand {
  const [action, ...args] = argv;
  if (action !== "spawn") {
    return { ok: false, message: action ? `Unknown agent command: ${action}` : "Usage: wolfpack agent spawn <project> ..." };
  }
  const parsed = parseSessionCommand(["open", ...args]);
  if (!parsed.ok) return { ok: false, message: "Usage: wolfpack agent spawn <project> [--prompt <instruction>] [--json]" };
  if (parsed.action !== "open") return { ok: false, message: "Usage: wolfpack agent spawn <project> ..." };
  return {
    ok: true,
    action: "spawn",
    project: parsed.project,
    prompt: parsed.prompt,
    output: parsed.output,
  };
}

function jsonOut(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const SESSION_API_FAILURES: Readonly<Record<number, CliErrorDescriptor & { readonly code: string }>> = {
  401: { code: "AUTH_REQUIRED", message: "auth required", exitCode: SESSION_EXIT.AUTH },
  404: { code: "SESSION_NOT_FOUND", message: "session not found", exitCode: SESSION_EXIT.NOT_FOUND },
  408: { code: "TIMEOUT", message: "timeout", exitCode: SESSION_EXIT.TIMEOUT },
  409: { code: "AMBIGUOUS_SELECTOR", message: "ambiguous session selector", exitCode: SESSION_EXIT.GENERAL },
  503: { code: "BACKEND_UNAVAILABLE", message: "backend unavailable", exitCode: SESSION_EXIT.BACKEND_UNAVAILABLE },
};

function mapApiError(e: unknown, output: OutputMode): number {
  const err = e as Partial<ApiError>;
  const failure = SESSION_API_FAILURES[err.status ?? 0] ?? {
    code: "SESSION_COMMAND_FAILED",
    message: `session command failed: ${err.body ?? String(e)}`,
    exitCode: SESSION_EXIT.GENERAL,
  };
  if (output === "json") jsonOut({ ok: false, error: { code: failure.code, message: failure.message } });
  else print((failure.exitCode === SESSION_EXIT.NOT_FOUND || failure.exitCode === SESSION_EXIT.TIMEOUT)
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

interface SessionStatusResponse {
  readonly ok: true;
  readonly session: string;
  readonly sessionId: string;
  readonly state: "active";
  readonly projectPath: string;
  readonly harness: string;
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
  else print(red(message));
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

async function runSessionOpen(
  parsed: {
    readonly project: string;
    readonly prompt: string | undefined;
    readonly output: OutputMode;
  },
): Promise<number> {
  const context = resolveSessionOpenContext(process.env);
  if (!context.ok) {
    return writeOpenError(parsed.output, context.code, context.message, SESSION_EXIT.NOT_FOUND);
  }

  try {
    const response = await call("/api/session-open", {
      method: "POST",
      body: JSON.stringify({
        project: parsed.project,
        parentSession: context.parentSession,
        ...(parsed.prompt !== undefined && { initialPrompt: parsed.prompt }),
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
  try {
    const response = await call("/api/session-create", {
      method: "POST",
      body: JSON.stringify({
        project: parsed.project,
        ...(parsed.harness !== undefined && { harness: parsed.harness }),
        ...(parsed.prompt !== undefined && { initialPrompt: parsed.prompt }),
      }),
    }) as SessionLaunchResponse;
    if (parsed.output === "json") jsonOut(response);
    else print(response.session);
    return SESSION_EXIT.OK;
  } catch (error: unknown) {
    return mapCreateApiError(parsed.output, error);
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
  const parsed = parseAgentCommand(argv);
  if (!parsed.ok) {
    print(red(parsed.message));
    return SESSION_EXIT.USAGE;
  }
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
    print(red(parsed.message));
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
      else print(yellow("no wolfpack context in this process"));
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
