/**
 * `wolfpack attach` — direct terminal attach through the server `/ws/pty` path.
 */
import { isValidSessionName } from "../validation.js";
import {
  CLOSE_CODE_DISPLACED,
  CLOSE_CODE_NORMAL,
  CLOSE_CODE_SERVER_ERROR,
  CLOSE_CODE_SESSION_UNAVAILABLE,
} from "../ws-constants.js";
import { baseUrl, call, issueJwt } from "./api.js";
import { dim, red, yellow } from "./formatting.js";

export type AttachPrefillMode = "full" | "none";

export const ATTACH_EXIT = {
  OK: 0,
  GENERAL_ERROR: 1,
  VIEWER_CONFLICT: 2,
  SESSION_UNAVAILABLE: 3,
  SERVER_ERROR: 4,
} as const;

export interface ParsedAttachCommand {
  readonly session?: string;
  readonly takeControl: boolean;
  readonly prefillMode: AttachPrefillMode;
}

export type AttachTargetResolution =
  | { ok: true; session: string }
  | { ok: false; message: string };

export function parseAttachCommand(argv: readonly string[]): ParsedAttachCommand | null {
  let session: string | undefined;
  let takeControl = false;
  let prefillMode: AttachPrefillMode = "full";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--take-control" || arg === "--force") {
      takeControl = true;
    } else if (arg === "--no-prefill") {
      prefillMode = "none";
    } else if (arg === "--prefill") {
      const next = argv[i + 1];
      if (next !== "full" && next !== "none") return null;
      prefillMode = next;
      i += 1;
    } else if (arg.startsWith("--prefill=")) {
      const value = arg.slice("--prefill=".length);
      if (value !== "full" && value !== "none") return null;
      prefillMode = value;
    } else if (arg.startsWith("-")) {
      return null;
    } else if (!session) {
      session = arg;
    } else {
      return null;
    }
  }
  return { session, takeControl, prefillMode };
}

export function resolveAttachTarget(sessionArg: string | undefined, sessions: readonly string[]): AttachTargetResolution {
  if (sessionArg) {
    if (!isValidSessionName(sessionArg)) {
      return { ok: false, message: `invalid session name "${sessionArg}"` };
    }
    if (!sessions.includes(sessionArg)) {
      return { ok: false, message: `session "${sessionArg}" not found` };
    }
    return { ok: true, session: sessionArg };
  }
  if (sessions.length === 1) return { ok: true, session: sessions[0] };
  if (sessions.length === 0) return { ok: false, message: "no active sessions" };
  return { ok: false, message: `multiple sessions; specify one: ${sessions.join(", ")}` };
}

export function terminalSize(stdout: Pick<NodeJS.WriteStream, "columns" | "rows"> = process.stdout): { cols: number; rows: number } {
  const cols = Number.isFinite(stdout.columns) && stdout.columns > 0 ? Math.floor(stdout.columns) : 80;
  const rows = Number.isFinite(stdout.rows) && stdout.rows > 0 ? Math.floor(stdout.rows) : 24;
  return { cols, rows };
}

interface RawModeStream {
  readonly isTTY?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
  resume?: () => unknown;
  pause?: () => unknown;
}

export function createRawModeRestorer(stdin: RawModeStream = process.stdin): () => void {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return () => {};
  stdin.setRawMode(true);
  stdin.resume?.();
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try { stdin.setRawMode?.(false); } catch { /* stream already gone */ }
    try { stdin.pause?.(); } catch { /* stream already gone */ }
  };
}

function appendTokenToWsUrl(url: URL): void {
  const jwt = issueJwt();
  if (jwt) url.searchParams.set("token", jwt);
}

export function attachWsUrl(session: string, httpBaseUrl = baseUrl()): string {
  const url = new URL("/ws/pty", httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session", session);
  appendTokenToWsUrl(url);
  return url.toString();
}

export function explainWsClose(code: number, reason: string): { exitCode: number; message: string | null } {
  if (code === CLOSE_CODE_NORMAL || code === 1005) return { exitCode: ATTACH_EXIT.OK, message: null };
  if (code === CLOSE_CODE_DISPLACED) return { exitCode: ATTACH_EXIT.VIEWER_CONFLICT, message: "attach displaced by another viewer" };
  if (code === CLOSE_CODE_SESSION_UNAVAILABLE) return { exitCode: ATTACH_EXIT.SESSION_UNAVAILABLE, message: "session unavailable" };
  if (code === CLOSE_CODE_SERVER_ERROR) return { exitCode: ATTACH_EXIT.SERVER_ERROR, message: reason || "server error during attach" };
  if (code === 1006) return { exitCode: ATTACH_EXIT.GENERAL_ERROR, message: "websocket connection failed" };
  return { exitCode: ATTACH_EXIT.GENERAL_ERROR, message: reason ? `websocket closed (${code}): ${reason}` : `websocket closed (${code})` };
}

function toBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export interface DirectAttachOptions {
  readonly session: string;
  readonly takeControl: boolean;
  readonly prefillMode: AttachPrefillMode;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly websocketUrl?: string;
  readonly rawMode?: boolean;
}

export async function directAttach(options: DirectAttachOptions): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const restoreRaw = options.rawMode === false ? () => {} : createRawModeRestorer(stdin);
  const url = options.websocketUrl ?? attachWsUrl(options.session);
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const size = () => terminalSize(stdout);
  let finished = false;
  let conflict = false;
  let exitCode: number = ATTACH_EXIT.GENERAL_ERROR;

  const sendAttach = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "attach", ...size(), prefillMode: options.prefillMode }));
  };
  const sendResize = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "resize", ...size() }));
  };
  const cleanup = () => {
    restoreRaw();
    stdin.off?.("data", onInput);
    stdout.off?.("resize", sendResize);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
  };
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    exitCode = code;
    cleanup();
  };
  const onSignal = (signal: NodeJS.Signals) => {
    cleanup();
    try { ws.close(CLOSE_CODE_NORMAL, "signal"); } catch { /* socket already gone */ }
    process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
  };
  const onInput = (chunk: Buffer) => {
    if (chunk.length === 1 && chunk[0] === 0x1d) {
      finish(ATTACH_EXIT.OK);
      try { ws.close(CLOSE_CODE_NORMAL, "detached"); } catch { /* socket already gone */ }
      return;
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(Uint8Array.from(chunk));
  };

  try {
    stdin.on("data", onInput);
    stdout.on?.("resize", sendResize);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    process.once("SIGHUP", onSignal);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        sendAttach();
        resolve();
      });
      ws.addEventListener("error", () => reject(new Error("websocket connect failed")));
    });

    await new Promise<void>((resolve) => {
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data) as { type?: string };
            if (msg.type === "viewer_conflict") {
              conflict = true;
              if (options.takeControl) ws.send(JSON.stringify({ type: "take_control" }));
              else {
                stderr.write(`${yellow("  Viewer conflict.")} Another viewer controls "${options.session}". Re-run with --take-control to displace it.\n`);
                finish(ATTACH_EXIT.VIEWER_CONFLICT);
                ws.close(CLOSE_CODE_NORMAL, "viewer conflict");
              }
            } else if (msg.type === "control_granted") {
              conflict = false;
              sendAttach();
            }
          } catch {
            // Unknown text frames are control-plane only; ignore malformed ones.
          }
          return;
        }
        const buf = toBuffer(ev.data);
        if (buf) stdout.write(buf);
      });
      ws.addEventListener("close", (ev) => {
        if (!finished) {
          const mapped = explainWsClose(ev.code, ev.reason);
          if (mapped.message && !conflict) stderr.write(`${red(`  ${mapped.message}`)}\n`);
          finish(mapped.exitCode);
        }
        resolve();
      });
    });
  } catch (e: unknown) {
    stderr.write(`${red(`  Could not attach to ${url}.`)}\n`);
    stderr.write(`${dim(`  Error: ${e instanceof Error ? e.message : String(e)}`)}\n`);
    finish(ATTACH_EXIT.GENERAL_ERROR);
  }

  return exitCode;
}

async function listSessionsForAttach(): Promise<string[] | null> {
  let resp: Response;
  try {
    resp = await call("/api/sessions");
  } catch (e: unknown) {
    process.stderr.write(`${red(`  Could not reach the wolfpack server at ${baseUrl()}.`)}\n`);
    process.stderr.write(`${dim(`  Error: ${e instanceof Error ? e.message : String(e)}`)}\n`);
    return null;
  }
  if (resp.status === 401) {
    process.stderr.write(`${red("  Auth required. Set WOLFPACK_JWT_SECRET to the server's secret and re-run.")}\n`);
    return null;
  }
  if (!resp.ok) {
    process.stderr.write(`${red(`  /api/sessions returned ${resp.status}: ${await resp.text()}`)}\n`);
    return null;
  }
  const data = (await resp.json()) as { sessions?: Array<{ name?: unknown }> };
  return (data.sessions ?? []).map((s) => s.name).filter((name): name is string => typeof name === "string");
}

export async function attachCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseAttachCommand(argv);
  if (!parsed) {
    process.stderr.write(`${red("  Usage: wolfpack attach [session] [--take-control] [--prefill full|none]")}\n`);
    return ATTACH_EXIT.GENERAL_ERROR;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`${red("  wolfpack attach requires an interactive tty on stdin and stdout.")}\n`);
    process.stderr.write(`${dim("  Piped stdin/stdout is not supported because attach uses raw terminal IO.")}\n`);
    return ATTACH_EXIT.GENERAL_ERROR;
  }
  const sessions = await listSessionsForAttach();
  if (!sessions) return ATTACH_EXIT.GENERAL_ERROR;
  const target = resolveAttachTarget(parsed.session, sessions);
  if (!target.ok) {
    process.stderr.write(`${red(`  ${target.message}`)}\n`);
    return ATTACH_EXIT.GENERAL_ERROR;
  }
  return directAttach({
    session: target.session,
    takeControl: parsed.takeControl,
    prefillMode: parsed.prefillMode,
  });
}
