import {
  isOpenableHarness,
  isSessionOpenErrorCode,
  SESSION_OPEN_ERROR,
} from "../session-open-contract.js";
import type {
  OpenableHarness,
  SessionOpenErrorCode,
} from "../session-open-contract.js";
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
type SessionAction = "open" | "read" | "send" | "wait" | "current-context";
const HELP_ALIASES = new Set(["--help", "-h", "help"]);

export function sessionOpenUsage(): string {
  return `Usage: wolfpack session open <project> [--prompt <instruction>] [--json]

Opens a same-harness child of the current Wolfpack agent session.
The server owns parent validation, child naming, and session creation.`;
}

export function sessionUsage(): string {
  return `Usage: wolfpack session <command> [options]

Commands:
  wolfpack session open <project> [--prompt <instruction>] [--json]
  wolfpack session read <session> [--json]
  wolfpack session send <session> <text...> [--no-enter] [--json]
  wolfpack session wait <session> <text> [--timeout-ms <1..600000>] [--json]
  wolfpack session current-context [--json|--shell]

Run 'wolfpack session open --help' for open-specific help.`;
}

export type ParsedSessionCommand =
  | {
    readonly ok: true;
    readonly action: "open";
    readonly project: string;
    readonly prompt: string | undefined;
    readonly output: OutputMode;
  }
  | { readonly ok: true; readonly action: "read"; readonly session: string; readonly output: OutputMode }
  | { readonly ok: true; readonly action: "send"; readonly session: string; readonly text: string; readonly noEnter: boolean; readonly output: OutputMode }
  | { readonly ok: true; readonly action: "wait"; readonly session: string; readonly text: string; readonly timeoutMs: number; readonly output: OutputMode }
  | { readonly ok: true; readonly action: "current-context"; readonly output: OutputMode }
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

const OPEN_KNOWN_OPTIONS = new Set(["--json", "--shell", "--prompt"]);

function consumeOpenPrompt(args: string[]): string | null {
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
  if (value === undefined || OPEN_KNOWN_OPTIONS.has(value)) {
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
  if (!action) return { ok: false, message: "Usage: wolfpack session <open|read|send|wait|current-context> ..." };
  if (!["open", "read", "send", "wait", "current-context"].includes(action)) {
    return { ok: false, message: `Unknown session command: ${action}` };
  }
  const promptValue = action === "open" ? consumeOpenPrompt(args) : null;
  const { mode: output, shellRequested } = parseOutputMode(args);
  if (action === "open") {
    if (shellRequested) return { ok: false, message: "--shell is only valid for current-context" };
    const prompt = promptValue ?? undefined;
    const project = args.shift();
    if (
      !project
      || args.length > 0
      || (prompt !== undefined && (!prompt.trim() || prompt.length > MAX_INITIAL_PROMPT_LENGTH))
    ) {
      return { ok: false, message: "Usage: wolfpack session open <project> [--prompt <instruction>] [--json]" };
    }
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
  if (action === "read") {
    if (args.length > 0) return { ok: false, message: "Usage: wolfpack session read <session> [--json]" };
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

function jsonOut(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function mapApiError(e: unknown): number {
  const err = e as Partial<ApiError>;
  if (err.status === 401) {
    print(red("auth required"));
    return SESSION_EXIT.AUTH;
  }
  if (err.status === 404) {
    print(yellow("session not found"));
    return SESSION_EXIT.NOT_FOUND;
  }
  if (err.status === 408) {
    print(yellow("timeout"));
    return SESSION_EXIT.TIMEOUT;
  }
  if (err.status === 503) {
    print(red("backend unavailable"));
    return SESSION_EXIT.BACKEND_UNAVAILABLE;
  }
  print(red(`session command failed: ${err.body ?? String(e)}`));
  return SESSION_EXIT.GENERAL;
}

interface SessionOpenResponse {
  readonly ok: true;
  readonly session: string;
  readonly project: string;
  readonly harness: OpenableHarness;
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

interface SessionOpenCliError {
  readonly message: string;
  readonly exitCode: number;
}

const OPEN_API_ERRORS: Readonly<Record<SessionOpenErrorCode, SessionOpenCliError>> = {
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

export function sessionOpenCliError(code: SessionOpenErrorCode): SessionOpenCliError {
  return OPEN_API_ERRORS[code];
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
  parsed: Extract<ParsedSessionCommand, { readonly action: "open" }>,
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
    }) as SessionOpenResponse;
    if (parsed.output === "json") jsonOut(response);
    else print(response.session);
    return SESSION_EXIT.OK;
  } catch (error: unknown) {
    return mapOpenApiError(parsed.output, error);
  }
}

export async function runSessionCommand(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && HELP_ALIASES.has(argv[0])) {
    print(sessionUsage());
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
    if (parsed.action === "read") {
      const data = await call(`/api/session-control/read?session=${encodeURIComponent(parsed.session)}`) as { output: string };
      if (parsed.output === "json") jsonOut({ session: parsed.session, output: data.output });
      else process.stdout.write(data.output);
      return SESSION_EXIT.OK;
    }
    if (parsed.action === "send") {
      await call("/api/session-control/send", {
        method: "POST",
        body: JSON.stringify({ session: parsed.session, text: parsed.text, noEnter: parsed.noEnter }),
      });
      if (parsed.output === "json") jsonOut({ ok: true, session: parsed.session });
      return SESSION_EXIT.OK;
    }
    await call("/api/session-control/wait", {
      method: "POST",
      body: JSON.stringify({ session: parsed.session, text: parsed.text, timeoutMs: parsed.timeoutMs }),
    });
    if (parsed.output === "json") jsonOut({ ok: true, session: parsed.session, matched: true });
    return SESSION_EXIT.OK;
  } catch (e: unknown) {
    return mapApiError(e);
  }
}
