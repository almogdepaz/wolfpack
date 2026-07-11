import { createHmac, randomBytes } from "node:crypto";
import { print, red, yellow } from "./formatting.js";
import { loadConfig } from "./config.js";

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
type SessionAction = "read" | "send" | "wait" | "current-context";

export type ParsedSessionCommand =
  | { ok: true; action: "read"; session: string; output: OutputMode }
  | { ok: true; action: "send"; session: string; text: string; noEnter: boolean; output: OutputMode }
  | { ok: true; action: "wait"; session: string; text: string; timeoutMs: number; output: OutputMode }
  | { ok: true; action: "current-context"; output: OutputMode }
  | { ok: false; message: string };

interface ApiError {
  readonly status: number;
  readonly body: string;
}

function baseUrl(): string {
  const config = loadConfig();
  const port = config?.port ?? 18790;
  return `http://127.0.0.1:${port}`;
}

function issueJwt(): string | null {
  const secret = process.env.WOLFPACK_JWT_SECRET;
  if (!secret || secret.length < 32) return null;
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iat: now,
    exp: now + 60,
    jti: randomBytes(8).toString("hex"),
  };
  const iss = process.env.WOLFPACK_JWT_ISSUER?.trim();
  if (iss) payload.iss = iss;
  const aud = process.env.WOLFPACK_JWT_AUDIENCE?.trim();
  if (aud) payload.aud = aud;
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${header}.${body}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  const jwt = issueJwt();
  if (jwt) headers.set("Authorization", `Bearer ${jwt}`);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl()}${path}`, { ...init, headers });
  } catch (e: unknown) {
    throw { status: 0, body: e instanceof Error ? e.message : String(e) } satisfies ApiError;
  }
  if (!resp.ok) throw { status: resp.status, body: await resp.text() } satisfies ApiError;
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

function parseOutputMode(args: string[]): { mode: OutputMode; shellRequested: boolean } {
  const json = consumeFlag(args, "--json");
  const shell = consumeFlag(args, "--shell");
  return { mode: shell ? "shell" : json ? "json" : "plain", shellRequested: shell };
}

export function parseSessionCommand(argv: readonly string[]): ParsedSessionCommand {
  const args = [...argv];
  const action = args.shift() as SessionAction | undefined;
  if (!action) return { ok: false, message: "Usage: wolfpack session <read|send|wait|current-context> ..." };
  if (!["read", "send", "wait", "current-context"].includes(action)) {
    return { ok: false, message: `Unknown session command: ${action}` };
  }
  const { mode: output, shellRequested } = parseOutputMode(args);
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

export async function runSessionCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseSessionCommand(argv);
  if (!parsed.ok) {
    print(red(parsed.message));
    return SESSION_EXIT.USAGE;
  }

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
