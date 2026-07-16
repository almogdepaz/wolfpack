import { call as callApi } from "./api.js";
import { print, red, yellow } from "./formatting.js";
import {
  MAX_INITIAL_PROMPT_LENGTH,
  MAX_SESSION_NAME_LENGTH,
} from "../validation.js";

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
type OpenableHarness = "pi" | "claude" | "codex" | "gemini" | "cursor";

const OPENABLE_HARNESSES = new Set<OpenableHarness>(["pi", "claude", "codex", "gemini", "cursor"]);

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
  | { readonly ok: false; readonly code: "MISSING_PARENT_SESSION" | "UNSUPPORTED_HARNESS"; readonly message: string };

export function chooseSubAgentSessionName(parentSession: string, existingNames: readonly string[]): string {
  const existing = new Set(existingNames);
  let number = 1;
  while (true) {
    const suffix = number === 1 ? "-sub-agent" : `-sub-agent-${number}`;
    const parentPrefix = parentSession.slice(0, MAX_SESSION_NAME_LENGTH - suffix.length);
    const candidate = `${parentPrefix}${suffix}`;
    if (!existing.has(candidate)) return candidate;
    number++;
  }
}

export function resolveSessionOpenContext(env: Readonly<Record<string, string | undefined>>): SessionOpenContext {
  const parentSession = env.WOLFPACK_SESSION_NAME?.trim();
  if (!parentSession) {
    return { ok: false, code: "MISSING_PARENT_SESSION", message: "wolfpack session context is missing" };
  }
  const harness = env.WOLFPACK_AGENT_KIND?.trim().toLowerCase();
  if (!harness || !OPENABLE_HARNESSES.has(harness as OpenableHarness)) {
    return {
      ok: false,
      code: "UNSUPPORTED_HARNESS",
      message: "current Wolfpack session is not running a supported agent harness",
    };
  }
  return { ok: true, parentSession, harness: harness as OpenableHarness };
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

function consumeLiteralValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (value === undefined) return "";
  args.splice(idx, 2);
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
  const promptValue = action === "open" ? consumeLiteralValue(args, "--prompt") : null;
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

interface SessionListResponse {
  readonly sessions: ReadonlyArray<{ readonly name: string }>;
}

function sessionNames(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const sessions = (value as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return [];
  return sessions.flatMap((session) => {
    if (!session || typeof session !== "object") return [];
    const name = (session as { name?: unknown }).name;
    return typeof name === "string" ? [name] : [];
  });
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

function mapOpenApiError(output: OutputMode, error: unknown): number {
  const apiError = error as Partial<ApiError>;
  if (apiError.status === 401) {
    return writeOpenError(output, "AUTH_REQUIRED", "auth required", SESSION_EXIT.AUTH);
  }
  if (apiError.status === 404) {
    if (apiError.code === "PARENT_SESSION_NOT_FOUND") {
      return writeOpenError(
        output,
        "PARENT_SESSION_NOT_FOUND",
        "parent Wolfpack session is not active",
        SESSION_EXIT.NOT_FOUND,
      );
    }
    return writeOpenError(output, "PROJECT_NOT_FOUND", "project not found", SESSION_EXIT.NOT_FOUND);
  }
  if (apiError.status === 503) {
    return writeOpenError(output, "BACKEND_UNAVAILABLE", "backend unavailable", SESSION_EXIT.BACKEND_UNAVAILABLE);
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
    let names = sessionNames(await call("/api/sessions") as SessionListResponse);
    if (!names.includes(context.parentSession)) {
      return writeOpenError(
        parsed.output,
        "PARENT_SESSION_NOT_FOUND",
        "parent Wolfpack session is not active",
        SESSION_EXIT.NOT_FOUND,
      );
    }

    for (let attempt = 0; attempt <= 3; attempt++) {
      const session = chooseSubAgentSessionName(context.parentSession, names);
      try {
        await call("/api/create", {
          method: "POST",
          body: JSON.stringify({
            project: parsed.project,
            cmd: context.harness,
            sessionName: session,
            parentSession: context.parentSession,
            ...(parsed.prompt !== undefined && { initialPrompt: parsed.prompt }),
          }),
        });
        if (parsed.output === "json") {
          jsonOut({ ok: true, session, project: parsed.project, harness: context.harness });
        } else {
          print(session);
        }
        return SESSION_EXIT.OK;
      } catch (error: unknown) {
        const apiError = error as Partial<ApiError>;
        if (apiError.status !== 409) return mapOpenApiError(parsed.output, error);
        if (attempt === 3) {
          return writeOpenError(
            parsed.output,
            "NAME_COLLISION",
            "could not allocate a sub-agent session name",
            SESSION_EXIT.GENERAL,
          );
        }
        names = sessionNames(await call("/api/sessions") as SessionListResponse);
      }
    }
  } catch (error: unknown) {
    return mapOpenApiError(parsed.output, error);
  }
  return writeOpenError(parsed.output, "CREATE_FAILED", "session creation failed", SESSION_EXIT.GENERAL);
}

export async function runSessionCommand(argv: readonly string[]): Promise<number> {
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
