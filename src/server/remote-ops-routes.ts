/**
 * Remote file and command routes (`wolfpack [--machine X] file ...` and
 * `exec`). They sit behind the global API auth gate in `index.ts` like session
 * create; there is no extra authorization layer. Each write, edit and exec is
 * logged at info with the path or cwd, argv[0] and byte counts, never file
 * content, other argv or command output.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "../log.js";
import {
  REMOTE_EXEC_BODY_MAX_BYTES,
  REMOTE_EXEC_DEFAULT_TIMEOUT_SECONDS,
  REMOTE_EXEC_ERROR,
  REMOTE_EXEC_ERROR_STATUS,
  REMOTE_EXEC_MAX_ARGS,
  REMOTE_EXEC_MAX_CONCURRENT,
  REMOTE_EXEC_MAX_TIMEOUT_SECONDS,
  REMOTE_EXEC_ROUTE,
  REMOTE_FILE_EDIT_BODY_MAX_BYTES,
  REMOTE_FILE_ENCODING,
  REMOTE_FILE_ERROR,
  REMOTE_FILE_ERROR_STATUS,
  REMOTE_FILE_MAX_PATH_LENGTH,
  REMOTE_FILE_ROUTE,
  REMOTE_FILE_WRITE_BODY_MAX_BYTES,
  type RemoteExecErrorCode,
  type RemoteExecFailure,
  type RemoteFileErrorCode,
  type RemoteFileFailure,
} from "../remote-ops-contract.js";
import { RemoteExecError, runRemoteCommand } from "./remote-exec.js";
import { hasOnlyKeys, json, parseObjectBody } from "./http.js";
import { editRemoteFile, readRemoteFile, RemoteFileError, writeRemoteFile } from "./remote-files.js";

const log = createLogger("remote-ops");

const READ_KEYS = new Set(["path"]);
const WRITE_KEYS = new Set(["path", "content", "encoding", "createOnly"]);
const EDIT_KEYS = new Set(["path", "old", "new", "all"]);
const EXEC_KEYS = new Set(["argv", "cwd", "timeoutSeconds"]);
/** A read body holds only a path. */
const READ_BODY_MAX_BYTES = 16 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function fail(res: ServerResponse, code: RemoteFileErrorCode, message: string, details: Omit<RemoteFileFailure, "error" | "code"> = {}): void {
  json(res, { error: message, code, ...details } satisfies RemoteFileFailure, REMOTE_FILE_ERROR_STATUS[code]);
}

function failWith(res: ServerResponse, error: unknown): RemoteFileErrorCode {
  if (error instanceof RemoteFileError) {
    fail(res, error.code, error.message, error.details);
    return error.code;
  }
  throw error;
}

function isPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= REMOTE_FILE_MAX_PATH_LENGTH && !value.includes("\0");
}

/** Strict base64: Buffer.from silently drops invalid characters, so require the canonical form. */
function decodeBase64(value: string): Buffer | null {
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function parseBodyWithLimit(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<Record<string, unknown> | null> {
  // REQUEST_TOO_LARGE and INVALID_REQUEST have the same code and status in the file and exec contracts.
  return parseObjectBody(req, res, {
    maxBytes,
    respondOnTooLarge: true,
    tooLargeResponse: {
      envelope: { error: `request body exceeds ${maxBytes} bytes`, code: REMOTE_FILE_ERROR.REQUEST_TOO_LARGE, maxBytes } satisfies RemoteFileFailure,
      status: REMOTE_FILE_ERROR_STATUS.REQUEST_TOO_LARGE,
    },
    invalidResponse: {
      envelope: { error: "JSON object body required", code: REMOTE_FILE_ERROR.INVALID_REQUEST } satisfies RemoteFileFailure,
      status: REMOTE_FILE_ERROR_STATUS.INVALID_REQUEST,
    },
  });
}

function failExec(res: ServerResponse, code: RemoteExecErrorCode, message: string, details: Omit<RemoteExecFailure, "error" | "code"> = {}): void {
  json(res, { error: message, code, ...details } satisfies RemoteExecFailure, REMOTE_EXEC_ERROR_STATUS[code]);
}

function isArgv(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= REMOTE_EXEC_MAX_ARGS
    && value.every(arg => typeof arg === "string" && !arg.includes("\0")) && value[0] !== "";
}

function isTimeout(value: unknown): value is number | undefined {
  return value === undefined || (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= REMOTE_EXEC_MAX_TIMEOUT_SECONDS);
}

const readFile: Handler = async (req, res) => {
  const body = await parseBodyWithLimit(req, res, READ_BODY_MAX_BYTES);
  if (!body) return;
  if (!hasOnlyKeys(body, READ_KEYS) || !isPath(body.path)) {
    return fail(res, REMOTE_FILE_ERROR.INVALID_REQUEST, "path (a nonempty string) required");
  }
  try {
    json(res, await readRemoteFile(body.path));
  } catch (error: unknown) {
    failWith(res, error);
  }
};

const writeFile: Handler = async (req, res) => {
  const body = await parseBodyWithLimit(req, res, REMOTE_FILE_WRITE_BODY_MAX_BYTES);
  if (!body) return;
  const { path, content, encoding, createOnly } = body;
  if (
    !hasOnlyKeys(body, WRITE_KEYS) || !isPath(path) || typeof content !== "string"
    || (encoding !== REMOTE_FILE_ENCODING.UTF8 && encoding !== REMOTE_FILE_ENCODING.BASE64)
    || (createOnly !== undefined && createOnly !== true)
  ) {
    return fail(res, REMOTE_FILE_ERROR.INVALID_REQUEST, "path, content and encoding (utf8 or base64) required; createOnly may only be true");
  }
  const bytes = encoding === REMOTE_FILE_ENCODING.BASE64 ? decodeBase64(content) : Buffer.from(content, "utf8");
  if (!bytes) return fail(res, REMOTE_FILE_ERROR.INVALID_REQUEST, "content is not canonical base64");
  const startedAt = Date.now();
  try {
    const result = await writeRemoteFile(path, bytes, { createOnly: createOnly === true });
    log.info("remote file write", { path: result.resolvedPath, bytes: result.size, created: result.created, durationMs: Date.now() - startedAt });
    json(res, result);
  } catch (error: unknown) {
    const code = failWith(res, error);
    log.info("remote file write failed", { path, bytes: bytes.length, code, durationMs: Date.now() - startedAt });
  }
};

const editFile: Handler = async (req, res) => {
  const body = await parseBodyWithLimit(req, res, REMOTE_FILE_EDIT_BODY_MAX_BYTES);
  if (!body) return;
  const { path, old: oldText, new: newText, all } = body;
  if (
    !hasOnlyKeys(body, EDIT_KEYS) || !isPath(path) || typeof oldText !== "string" || oldText.length === 0
    || typeof newText !== "string" || (all !== undefined && all !== true)
  ) {
    return fail(res, REMOTE_FILE_ERROR.INVALID_REQUEST, "path, old (nonempty) and new text required; all may only be true");
  }
  const startedAt = Date.now();
  try {
    const result = await editRemoteFile(path, oldText, newText, { all: all === true });
    log.info("remote file edit", { path: result.resolvedPath, bytes: result.size, replacements: result.replacements, durationMs: Date.now() - startedAt });
    json(res, result);
  } catch (error: unknown) {
    const code = failWith(res, error);
    log.info("remote file edit failed", { path, code, durationMs: Date.now() - startedAt });
  }
};

const execCommand: Handler = async (req, res) => {
  const body = await parseBodyWithLimit(req, res, REMOTE_EXEC_BODY_MAX_BYTES);
  if (!body) return;
  const { argv, cwd, timeoutSeconds } = body;
  if (!hasOnlyKeys(body, EXEC_KEYS) || !isArgv(argv) || !isPath(cwd) || !isTimeout(timeoutSeconds)) {
    return failExec(res, REMOTE_EXEC_ERROR.INVALID_REQUEST,
      `argv (1 to ${REMOTE_EXEC_MAX_ARGS} strings, the first nonempty) and cwd required; timeoutSeconds is an integer from 1 to ${REMOTE_EXEC_MAX_TIMEOUT_SECONDS}`);
  }
  // A dropped connection (for example a killed CLI) kills the command instead of holding a slot until the timeout.
  const dropped = new AbortController();
  res.on("close", () => { if (!res.writableFinished) dropped.abort(); });
  const command = argv[0]!;
  const startedAt = Date.now();
  try {
    const result = await runRemoteCommand({ argv, cwd, timeoutMs: (timeoutSeconds ?? REMOTE_EXEC_DEFAULT_TIMEOUT_SECONDS) * 1000, signal: dropped.signal });
    log.info("remote exec", {
      cwd, command, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
      stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes, durationMs: result.durationMs,
    });
    json(res, result);
  } catch (error: unknown) {
    if (!(error instanceof RemoteExecError)) throw error;
    log.info("remote exec failed", { cwd, command, code: error.code, durationMs: Date.now() - startedAt });
    failExec(res, error.code, error.message, error.code === REMOTE_EXEC_ERROR.EXEC_BUSY ? { maxConcurrent: REMOTE_EXEC_MAX_CONCURRENT } : {});
  }
};

export function createRemoteOpsRoutes(): Record<string, Handler> {
  return {
    [`POST ${REMOTE_EXEC_ROUTE}`]: execCommand,
    [`POST ${REMOTE_FILE_ROUTE.READ}`]: readFile,
    [`POST ${REMOTE_FILE_ROUTE.WRITE}`]: writeFile,
    [`POST ${REMOTE_FILE_ROUTE.EDIT}`]: editFile,
  };
}
