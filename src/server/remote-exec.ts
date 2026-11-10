/**
 * Run one command for `wolfpack exec`: argv without a shell, in its own process
 * group, with the server's environment and stdin closed. A timeout, a caller
 * abort, or the command's own exit kills the whole group, so background
 * children cannot outlive the request or hold its pipes open.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import {
  REMOTE_EXEC_ERROR,
  REMOTE_EXEC_MAX_CONCURRENT,
  REMOTE_EXEC_OUTPUT_MAX_BYTES,
  REMOTE_FILE_ENCODING,
  type RemoteExecErrorCode,
  type RemoteExecResult,
  type RemoteFileEncoding,
} from "../remote-ops-contract.js";
import { utf8Text } from "./remote-files.js";

/** After the command exits, output still in its pipes is read for at most this long. */
const EXIT_DRAIN_MS = 500;

export class RemoteExecError extends Error {
  constructor(readonly code: RemoteExecErrorCode, message: string) {
    super(message);
  }
}

export interface RemoteExecRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Aborted when the caller goes away; the command's group is killed. */
  readonly signal?: AbortSignal;
}

let running = 0;

/** Keeps the first bytes up to the cap and counts the rest without storing them. */
class CappedOutput {
  readonly #chunks: Buffer[] = [];
  #kept = 0;
  total = 0;
  constructor(stream: Readable) {
    stream.on("data", (chunk: Buffer) => {
      this.total += chunk.length;
      const room = REMOTE_EXEC_OUTPUT_MAX_BYTES - this.#kept;
      if (room <= 0) return;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      this.#chunks.push(part);
      this.#kept += part.length;
    });
  }
  get truncated(): boolean { return this.total > this.#kept; }
  encoded(): { readonly content: string; readonly encoding: RemoteFileEncoding } {
    let bytes: Buffer = Buffer.concat(this.#chunks);
    // The cap can split a multi-byte character; drop only that incomplete tail.
    if (this.truncated) bytes = withoutPartialUtf8Tail(bytes);
    const text = utf8Text(bytes);
    return text === null
      ? { content: bytes.toString("base64"), encoding: REMOTE_FILE_ENCODING.BASE64 }
      : { content: text, encoding: REMOTE_FILE_ENCODING.UTF8 };
  }
}

function withoutPartialUtf8Tail(bytes: Buffer): Buffer {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue; // Continuation byte: keep looking for the lead byte.
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

async function assertWorkingDirectory(cwd: string): Promise<void> {
  if (!isAbsolute(cwd)) throw new RemoteExecError(REMOTE_EXEC_ERROR.CWD_NOT_ABSOLUTE, `cwd must be absolute: ${cwd}`);
  let info;
  try {
    info = await stat(cwd);
  } catch (error: unknown) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") throw new RemoteExecError(REMOTE_EXEC_ERROR.CWD_NOT_FOUND, `cwd not found: ${cwd}`);
    if (code === "EACCES" || code === "EPERM") throw new RemoteExecError(REMOTE_EXEC_ERROR.PERMISSION_DENIED, `permission denied: ${cwd}`);
    throw new RemoteExecError(REMOTE_EXEC_ERROR.SPAWN_FAILED, `cannot use cwd ${cwd}: ${code ?? String(error)}`);
  }
  if (!info.isDirectory()) throw new RemoteExecError(REMOTE_EXEC_ERROR.CWD_NOT_DIRECTORY, `cwd is not a directory: ${cwd}`);
}

function spawnFailure(error: unknown, command: string): RemoteExecError {
  const code = errnoCode(error);
  if (code === "ENOENT") return new RemoteExecError(REMOTE_EXEC_ERROR.COMMAND_NOT_FOUND, `command not found: ${command}`);
  if (code === "EACCES" || code === "EPERM") return new RemoteExecError(REMOTE_EXEC_ERROR.PERMISSION_DENIED, `permission denied: ${command}`);
  return new RemoteExecError(REMOTE_EXEC_ERROR.SPAWN_FAILED, `could not start ${command}: ${code ?? String(error)}`);
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error: unknown) {
    if (errnoCode(error) !== "ESRCH") throw error; // ESRCH: the whole group is already gone.
  }
}

function closed(stream: Readable): Promise<void> {
  return new Promise(resolve => {
    if (stream.destroyed || stream.readableEnded) resolve();
    else stream.once("close", () => resolve());
  });
}

export async function runRemoteCommand(request: RemoteExecRequest): Promise<RemoteExecResult> {
  if (running >= REMOTE_EXEC_MAX_CONCURRENT) {
    throw new RemoteExecError(REMOTE_EXEC_ERROR.EXEC_BUSY, `${REMOTE_EXEC_MAX_CONCURRENT} commands are already running; retry later`);
  }
  running++;
  try {
    await assertWorkingDirectory(request.cwd);
    return await execute(request);
  } finally {
    running--;
  }
}

async function execute(request: RemoteExecRequest): Promise<RemoteExecResult> {
  const [command, ...args] = request.argv as [string, ...string[]];
  const startedAt = performance.now();
  let child: ChildProcess;
  try {
    child = spawn(command, args, { cwd: request.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true, shell: false });
  } catch (error: unknown) {
    throw spawnFailure(error, command);
  }
  const stdout = new CappedOutput(child.stdout!);
  const stderr = new CappedOutput(child.stderr!);
  const started = await new Promise<{ ok: true } | { ok: false; error: unknown }>(resolve => {
    child.once("spawn", () => resolve({ ok: true }));
    child.once("error", error => resolve({ ok: false, error }));
  });
  if (!started.ok) throw spawnFailure(started.error, command);

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killGroup(child); }, request.timeoutMs);
  const abort = () => killGroup(child);
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) abort();
  try {
    const exit = await exited;
    const durationMs = Math.round(performance.now() - startedAt);
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([closed(child.stdout!), closed(child.stderr!)]),
      new Promise<void>(resolve => { drainTimer = setTimeout(resolve, EXIT_DRAIN_MS); }),
    ]);
    clearTimeout(drainTimer);
    // Background children left in the group die with the command.
    killGroup(child);
    child.stdout!.destroy();
    child.stderr!.destroy();
    const out = stdout.encoded();
    const err = stderr.encoded();
    return {
      ok: true,
      cwd: request.cwd,
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      durationMs,
      stdout: out.content,
      stdoutEncoding: out.encoding,
      stdoutBytes: stdout.total,
      stdoutTruncated: stdout.truncated,
      stderr: err.content,
      stderrEncoding: err.encoding,
      stderrBytes: stderr.total,
      stderrTruncated: stderr.truncated,
    };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
  }
}
