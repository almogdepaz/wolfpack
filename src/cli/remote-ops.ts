/**
 * `wolfpack [--machine X] file read|write|edit` and `exec`: remote file
 * operations and commands through the server API. With `--machine` the verified
 * target is used and paths must be absolute; without it a relative path resolves
 * against the local working directory.
 */
import { readFileSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { VerifiedMachineTarget } from "./machine-target.js";
import { baseUrl, call, LONG_REQUEST_GRACE_MS, longRequestInit } from "./api.js";
import { print, printApiJson, printError, printJson, red } from "./formatting.js";
import { SESSION_EXIT } from "./session-control.js";
import {
  REMOTE_EXEC_DEFAULT_TIMEOUT_SECONDS,
  REMOTE_EXEC_MAX_TIMEOUT_SECONDS,
  REMOTE_EXEC_OUTPUT_MAX_BYTES,
  REMOTE_EXEC_ROUTE,
  REMOTE_FILE_ENCODING,
  REMOTE_FILE_ERROR,
  REMOTE_FILE_MAX_BYTES,
  REMOTE_FILE_ROUTE,
  type RemoteExecResult,
  type RemoteFileEdit,
  type RemoteFileRead,
  type RemoteFileWrite,
} from "../remote-ops-contract.js";

export const FILE_USAGE = `Usage: wolfpack [--machine <short-name-or-fqdn>] file <action>

  file read <path> [--json]
  file write <path> (--stdin | --from <local-file>) [--create-only] [--json]
  file edit <path> --old <text> --new <text> [--all] [--json]

Any path the wolfpack server user can access, behind the ordinary API auth.
With --machine the path must be absolute. Files are limited to ${REMOTE_FILE_MAX_BYTES} bytes.
read prints the exact bytes; --json returns base64 content with binary: true for binary files.
write replaces the file atomically and keeps an existing file's mode;
--create-only refuses an existing file.
edit replaces exact text; without --all the old text must match exactly once.`;

const HELP = new Set(["--help", "-h", "help"]);
/** Flags that take the next argument as their value, verbatim (it may be empty or start with "-"). */
const VALUE_FLAGS = new Set(["--from", "--old", "--new"]);
const BOOLEAN_FLAGS = new Set(["--json", "--stdin", "--create-only", "--all"]);
const ACTION_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  read: new Set(["--json"]),
  write: new Set(["--json", "--stdin", "--from", "--create-only"]),
  edit: new Set(["--json", "--old", "--new", "--all"]),
};

interface ParsedFileArgs {
  readonly action: string;
  readonly path: string;
  readonly flags: ReadonlyMap<string, string | true>;
}

class ArgumentError extends Error {}

function parse(argv: readonly string[]): ParsedFileArgs {
  const [action, ...rest] = argv;
  const allowed = action === undefined ? undefined : ACTION_FLAGS[action];
  if (!allowed) throw new ArgumentError(`unknown file action: ${action ?? "(none)"}`);
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (VALUE_FLAGS.has(arg) || BOOLEAN_FLAGS.has(arg)) {
      if (!allowed.has(arg)) throw new ArgumentError(`${arg} is not valid for file ${action}`);
      if (flags.has(arg)) throw new ArgumentError(`${arg} given more than once`);
      if (VALUE_FLAGS.has(arg)) {
        const value = rest[++index];
        if (value === undefined) throw new ArgumentError(`${arg} requires a value`);
        flags.set(arg, value);
      } else {
        flags.set(arg, true);
      }
    } else if (arg.startsWith("--")) {
      throw new ArgumentError(`unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1) throw new ArgumentError(`file ${action} takes exactly one path`);
  if (action === "write" && flags.has("--stdin") === flags.has("--from")) {
    throw new ArgumentError("file write requires exactly one of --stdin or --from <local-file>");
  }
  if (action === "edit" && (typeof flags.get("--old") !== "string" || typeof flags.get("--new") !== "string")) {
    throw new ArgumentError("file edit requires --old <text> and --new <text>");
  }
  if (action === "edit" && flags.get("--old") === "") throw new ArgumentError("--old must not be empty");
  return { action, path: positionals[0]!, flags };
}

interface Failure {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

function emit(jsonOutput: boolean, failure: Failure, target: VerifiedMachineTarget | undefined, exitCode: number): number {
  if (jsonOutput) {
    const envelope = { ok: false, error: { code: failure.code, message: failure.message }, ...failure.details };
    if (target) printApiJson(envelope, target); else printJson(envelope);
  } else {
    printError(red(`  ${failure.message}`));
  }
  return exitCode;
}

/** POST one remote operation; on failure the error is already printed and the exit code returned. */
async function post(
  route: string,
  body: Record<string, unknown>,
  target: VerifiedMachineTarget | undefined,
  jsonOutput: boolean,
  label: string,
  deadlineMs?: number,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly exitCode: number }> {
  const failed = (failure: Failure, failureTarget: VerifiedMachineTarget | undefined, exitCode: number) =>
    ({ ok: false as const, exitCode: emit(jsonOutput, failure, failureTarget, exitCode) });
  let response: Response;
  try {
    const init: RequestInit = { method: "POST", body: JSON.stringify(body) };
    response = await call(route, deadlineMs === undefined ? init : longRequestInit(init, deadlineMs), target);
  } catch (error: unknown) {
    return failed({
      code: "SERVER_UNREACHABLE",
      message: `could not reach the wolfpack server at ${baseUrl(target)}: ${error instanceof Error ? error.message : String(error)}`,
    }, undefined, SESSION_EXIT.GENERAL);
  }
  if (response.status === 401) {
    return failed({ code: "AUTH_REQUIRED", message: "auth required; set WOLFPACK_JWT_SECRET and re-run" }, target, SESSION_EXIT.AUTH);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return failed({ code: "INVALID_RESPONSE", message: `wolfpack server returned invalid JSON (HTTP ${response.status})` }, target, SESSION_EXIT.GENERAL);
  }
  if (!response.ok) {
    const { error, code, ...details } = (value ?? {}) as { error?: unknown; code?: unknown };
    return failed({
      code: typeof code === "string" ? code : `HTTP_${response.status}`,
      message: typeof error === "string" ? error : `${label} failed: HTTP ${response.status}`,
      details,
    }, target, SESSION_EXIT.GENERAL);
  }
  return { ok: true, value };
}

async function readLocalContent(flags: ReadonlyMap<string, string | true>): Promise<Buffer> {
  const from = flags.get("--from");
  if (typeof from === "string") {
    const size = statSync(from).size;
    if (size > REMOTE_FILE_MAX_BYTES) throw new ContentTooLarge(size);
    return readFileSync(from);
  }
  const bytes = Buffer.from(await Bun.stdin.arrayBuffer());
  if (bytes.length > REMOTE_FILE_MAX_BYTES) throw new ContentTooLarge(bytes.length);
  return bytes;
}

class ContentTooLarge extends Error {
  constructor(readonly size: number) {
    super(`content is ${size} bytes; the limit is ${REMOTE_FILE_MAX_BYTES} bytes`);
  }
}

function requestBody(parsed: ParsedFileArgs, path: string, content: Buffer | undefined): Record<string, unknown> {
  if (parsed.action === "read") return { path };
  if (parsed.action === "write") {
    return {
      path,
      encoding: REMOTE_FILE_ENCODING.BASE64,
      content: content!.toString("base64"),
      ...(parsed.flags.has("--create-only") && { createOnly: true }),
    };
  }
  return {
    path,
    old: parsed.flags.get("--old"),
    new: parsed.flags.get("--new"),
    ...(parsed.flags.has("--all") && { all: true }),
  };
}

const ROUTE_BY_ACTION: Readonly<Record<string, string>> = {
  read: REMOTE_FILE_ROUTE.READ,
  write: REMOTE_FILE_ROUTE.WRITE,
  edit: REMOTE_FILE_ROUTE.EDIT,
};

function printResult(action: string, value: unknown): void {
  if (action === "read") {
    const read = value as RemoteFileRead;
    process.stdout.write(read.encoding === REMOTE_FILE_ENCODING.BASE64 ? Buffer.from(read.content, "base64") : read.content);
  } else if (action === "write") {
    const write = value as RemoteFileWrite;
    print(`  ${write.created ? "Created" : "Wrote"} ${write.resolvedPath} (${write.size} bytes).`);
  } else {
    const edit = value as RemoteFileEdit;
    print(`  Replaced ${edit.replacements} occurrence${edit.replacements === 1 ? "" : "s"} in ${edit.resolvedPath}.`);
  }
}

export async function fileCommand(argv: readonly string[], target?: VerifiedMachineTarget): Promise<number> {
  if (argv.length === 0 || (argv.length <= 2 && HELP.has(argv.at(-1)!))) {
    print(FILE_USAGE);
    return 0;
  }
  const jsonOutput = argv.includes("--json");
  let parsed: ParsedFileArgs;
  try {
    parsed = parse(argv);
  } catch (error: unknown) {
    if (!(error instanceof ArgumentError)) throw error;
    return emit(jsonOutput, { code: "INVALID_ARGUMENTS", message: error.message }, undefined, SESSION_EXIT.USAGE);
  }
  if (target && !isAbsolute(parsed.path)) {
    return emit(jsonOutput, { code: "INVALID_ARGUMENTS", message: `with --machine the path must be absolute: ${parsed.path}` }, undefined, SESSION_EXIT.USAGE);
  }
  const path = target ? parsed.path : resolve(process.cwd(), parsed.path);

  let content: Buffer | undefined;
  if (parsed.action === "write") {
    try {
      content = await readLocalContent(parsed.flags);
    } catch (error: unknown) {
      if (error instanceof ContentTooLarge) {
        return emit(jsonOutput, {
          code: REMOTE_FILE_ERROR.FILE_TOO_LARGE,
          message: error.message,
          details: { size: error.size, maxBytes: REMOTE_FILE_MAX_BYTES },
        }, undefined, SESSION_EXIT.GENERAL);
      }
      return emit(jsonOutput, { code: "LOCAL_READ_FAILED", message: `could not read local content: ${error instanceof Error ? error.message : String(error)}` }, undefined, SESSION_EXIT.GENERAL);
    }
  }

  const posted = await post(ROUTE_BY_ACTION[parsed.action]!, requestBody(parsed, path, content), target, jsonOutput, `file ${parsed.action}`);
  if (!posted.ok) return posted.exitCode;
  if (jsonOutput) printApiJson(posted.value, target);
  else printResult(parsed.action, posted.value);
  return 0;
}

export const EXEC_USAGE = `Usage: wolfpack [--machine <short-name-or-fqdn>] exec --cwd <dir> [--timeout <seconds>] [--json] -- <command> [args...]

Runs one command on the server machine as the wolfpack server user, behind the
ordinary API auth. The arguments after -- go to the command verbatim; there is no
shell. With --machine, --cwd must be absolute. The command gets the server's
environment and a closed stdin. --timeout defaults to 120 and is at most ${REMOTE_EXEC_MAX_TIMEOUT_SECONDS} seconds;
a timeout kills the command's process group. stdout and stderr keep the first
${REMOTE_EXEC_OUTPUT_MAX_BYTES} bytes each.
Without --json, the output goes to stdout and stderr and wolfpack exits with the
command's exit code (124 on timeout, 128 + n for signal n).
With --json, wolfpack prints the result and exits 0 when the command ran.`;

/** Exit code of `timeout(1)` for a command that ran out of time. */
const TIMEOUT_EXIT = 124;
const SIGNAL_EXIT_BASE = 128;
const EXEC_SEPARATOR = "--";
const EXEC_VALUE_FLAGS = new Set(["--cwd", "--timeout"]);

interface ParsedExecArgs {
  readonly cwd: string;
  readonly timeoutSeconds: number | undefined;
  readonly json: boolean;
  readonly argv: readonly string[];
}

function parseExec(options: readonly string[], command: readonly string[] | undefined): ParsedExecArgs {
  const flags = new Map<string, string>();
  let json = false;
  for (let index = 0; index < options.length; index++) {
    const arg = options[index]!;
    if (arg === "--json") {
      if (json) throw new ArgumentError("--json given more than once");
      json = true;
    } else if (EXEC_VALUE_FLAGS.has(arg)) {
      if (flags.has(arg)) throw new ArgumentError(`${arg} given more than once`);
      const value = options[++index];
      if (value === undefined) throw new ArgumentError(`${arg} requires a value`);
      flags.set(arg, value);
    } else {
      throw new ArgumentError(`unknown exec argument before --: ${arg}`);
    }
  }
  const cwd = flags.get("--cwd");
  if (!cwd) throw new ArgumentError("exec requires --cwd <dir>");
  if (!command) throw new ArgumentError("exec requires -- before the command");
  if (command.length === 0 || command[0] === "") throw new ArgumentError("exec requires a command after --");
  const timeout = flags.get("--timeout");
  let timeoutSeconds: number | undefined;
  if (timeout !== undefined) {
    timeoutSeconds = /^\d+$/.test(timeout) ? Number(timeout) : Number.NaN;
    if (!(timeoutSeconds >= 1 && timeoutSeconds <= REMOTE_EXEC_MAX_TIMEOUT_SECONDS)) {
      throw new ArgumentError(`--timeout must be a whole number of seconds from 1 to ${REMOTE_EXEC_MAX_TIMEOUT_SECONDS}`);
    }
  }
  return { cwd, timeoutSeconds, json, argv: command };
}

function outputBytes(content: string, encoding: string): Buffer {
  return encoding === REMOTE_FILE_ENCODING.BASE64 ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
}

/** Mirror the command's exit: its code, 124 on timeout, or 128 + the signal number. */
function commandExitCode(result: RemoteExecResult): number {
  if (result.timedOut) return TIMEOUT_EXIT;
  if (result.exitCode !== null) return result.exitCode;
  const signal = result.signal === null ? undefined : osConstants.signals[result.signal as NodeJS.Signals];
  return signal === undefined ? SESSION_EXIT.GENERAL : SIGNAL_EXIT_BASE + signal;
}

function printExecResult(result: RemoteExecResult): void {
  process.stdout.write(outputBytes(result.stdout, result.stdoutEncoding));
  process.stderr.write(outputBytes(result.stderr, result.stderrEncoding));
  const notes: string[] = [];
  if (result.stdoutTruncated) notes.push(`stdout truncated: kept ${REMOTE_EXEC_OUTPUT_MAX_BYTES} of ${result.stdoutBytes} bytes`);
  if (result.stderrTruncated) notes.push(`stderr truncated: kept ${REMOTE_EXEC_OUTPUT_MAX_BYTES} of ${result.stderrBytes} bytes`);
  if (result.timedOut) notes.push(`timed out after ${result.durationMs} ms; the process group was killed`);
  for (const note of notes) printError(red(`  wolfpack exec: ${note}`));
}

export async function execCommand(argv: readonly string[], target?: VerifiedMachineTarget): Promise<number> {
  const separator = argv.indexOf(EXEC_SEPARATOR);
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const command = separator < 0 ? undefined : argv.slice(separator + 1);
  if (argv.length === 0 || (command === undefined && options.length === 1 && HELP.has(options[0]!))) {
    print(EXEC_USAGE);
    return 0;
  }
  const jsonOutput = options.includes("--json");
  let parsed: ParsedExecArgs;
  try {
    parsed = parseExec(options, command);
  } catch (error: unknown) {
    if (!(error instanceof ArgumentError)) throw error;
    return emit(jsonOutput, { code: "INVALID_ARGUMENTS", message: error.message }, undefined, SESSION_EXIT.USAGE);
  }
  if (target && !isAbsolute(parsed.cwd)) {
    return emit(jsonOutput, { code: "INVALID_ARGUMENTS", message: `with --machine --cwd must be absolute: ${parsed.cwd}` }, undefined, SESSION_EXIT.USAGE);
  }
  const cwd = target ? parsed.cwd : resolve(process.cwd(), parsed.cwd);
  const body = { argv: parsed.argv, cwd, ...(parsed.timeoutSeconds !== undefined && { timeoutSeconds: parsed.timeoutSeconds }) };
  const deadlineMs = (parsed.timeoutSeconds ?? REMOTE_EXEC_DEFAULT_TIMEOUT_SECONDS) * 1000 + LONG_REQUEST_GRACE_MS;
  const posted = await post(REMOTE_EXEC_ROUTE, body, target, jsonOutput, "exec", deadlineMs);
  if (!posted.ok) return posted.exitCode;
  if (jsonOutput) {
    printApiJson(posted.value, target);
    return 0;
  }
  const result = posted.value as RemoteExecResult;
  printExecResult(result);
  return commandExitCode(result);
}
