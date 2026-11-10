/**
 * Remote file operations: read, atomic write and exact-text edit of any path the
 * server user can access. Symlinks are followed like a shell follows them; the
 * resolved path is reported. Writes go to a temp file in the target's directory,
 * are synced, and then replace the target in one rename (or one link for
 * create-only), so a failure leaves the old file intact.
 */
import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { link, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  REMOTE_FILE_ENCODING,
  REMOTE_FILE_ERROR,
  REMOTE_FILE_MAX_BYTES,
  type RemoteFileEdit,
  type RemoteFileErrorCode,
  type RemoteFileRead,
  type RemoteFileWrite,
} from "../remote-ops-contract.js";

export class RemoteFileError extends Error {
  constructor(
    readonly code: RemoteFileErrorCode,
    message: string,
    readonly details: { readonly size?: number; readonly maxBytes?: number; readonly matches?: number } = {},
  ) {
    super(message);
    this.name = "RemoteFileError";
  }
}

function errnoCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Map a filesystem error to a remote file error. The message names the path, never content. */
function fsError(error: unknown, path: string): RemoteFileError {
  if (error instanceof RemoteFileError) return error;
  switch (errnoCode(error)) {
    case "ENOENT": return new RemoteFileError(REMOTE_FILE_ERROR.NOT_FOUND, `no such file or directory: ${path}`);
    case "ENOTDIR": return new RemoteFileError(REMOTE_FILE_ERROR.NOT_FOUND, `a path component is not a directory: ${path}`);
    case "EACCES":
    case "EPERM": return new RemoteFileError(REMOTE_FILE_ERROR.PERMISSION_DENIED, `permission denied: ${path}`);
    case "EISDIR": return new RemoteFileError(REMOTE_FILE_ERROR.NOT_A_FILE, `not a regular file: ${path}`);
    case "ELOOP": return new RemoteFileError(REMOTE_FILE_ERROR.SYMLINK_LOOP, `too many levels of symbolic links: ${path}`);
    case "EEXIST": return new RemoteFileError(REMOTE_FILE_ERROR.FILE_EXISTS, `file exists: ${path}`);
    default: return new RemoteFileError(REMOTE_FILE_ERROR.IO_FAILED, `file operation failed (${errnoCode(error) ?? "unknown"}): ${path}`);
  }
}

function tooLarge(size: number): RemoteFileError {
  return new RemoteFileError(
    REMOTE_FILE_ERROR.FILE_TOO_LARGE,
    `file is ${size} bytes; the limit is ${REMOTE_FILE_MAX_BYTES} bytes`,
    { size, maxBytes: REMOTE_FILE_MAX_BYTES },
  );
}

function notAFile(path: string): RemoteFileError {
  return new RemoteFileError(REMOTE_FILE_ERROR.NOT_A_FILE, `not a regular file: ${path}`);
}

export function assertAbsolutePath(path: string): void {
  if (!isAbsolute(path)) throw new RemoteFileError(REMOTE_FILE_ERROR.PATH_NOT_ABSOLUTE, `path must be absolute: ${path}`);
}

/** The text of bytes that round-trip through UTF-8 unchanged and hold no NUL; null for binary content. */
export function utf8Text(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

/** Read a regular file of at most the cap, by its resolved path. */
async function readCapped(resolvedPath: string): Promise<Buffer> {
  // O_NONBLOCK: opening a FIFO must not wait for a writer before the type check.
  const handle = await open(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
    .catch((error: unknown) => { throw fsError(error, resolvedPath); });
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw notAFile(resolvedPath);
    if (stats.size > REMOTE_FILE_MAX_BYTES) throw tooLarge(stats.size);
    // The file can grow after the stat: read at most cap + 1 bytes.
    const buffer = Buffer.alloc(Math.min(stats.size, REMOTE_FILE_MAX_BYTES) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > REMOTE_FILE_MAX_BYTES) throw tooLarge(length);
    return buffer.subarray(0, length);
  } catch (error: unknown) {
    throw fsError(error, resolvedPath);
  } finally {
    await handle.close();
  }
}

interface ResolvedTarget {
  readonly resolvedPath: string;
  /** The existing regular file, or null when the path names a new file. */
  readonly existing: Stats | null;
}

/** Resolve a write target like a shell: follow symlinks; a new file resolves through its parent directory. */
async function resolveTarget(path: string): Promise<ResolvedTarget> {
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(path);
  } catch (error: unknown) {
    if (errnoCode(error) !== "ENOENT") throw fsError(error, path);
    const entry = await lstat(path).catch((lstatError: unknown) => {
      if (errnoCode(lstatError) === "ENOENT") return null;
      throw fsError(lstatError, path);
    });
    if (entry?.isSymbolicLink()) {
      throw new RemoteFileError(REMOTE_FILE_ERROR.DANGLING_SYMLINK, `symbolic link target does not exist: ${path}`);
    }
    const parent = await realpath(dirname(path)).catch((parentError: unknown) => { throw fsError(parentError, dirname(path)); });
    return { resolvedPath: join(parent, basename(path)), existing: null };
  }
  const existing = await lstat(resolvedPath).catch((error: unknown) => { throw fsError(error, resolvedPath); });
  if (!existing.isFile()) throw notAFile(resolvedPath);
  return { resolvedPath, existing };
}

/**
 * Replace (or, with createOnly, create) the resolved target in one step. A new
 * file gets the default mode under the server umask; an existing one keeps its mode.
 */
async function atomicReplace(target: ResolvedTarget, bytes: Buffer, createOnly: boolean): Promise<void> {
  const { resolvedPath, existing } = target;
  const temp = join(dirname(resolvedPath), `.${basename(resolvedPath)}.wolfpack-${randomUUID()}.tmp`);
  let tempCreated = false;
  try {
    const handle = await open(temp, "wx", existing ? 0o600 : 0o666);
    tempCreated = true;
    try {
      await handle.writeFile(bytes);
      if (existing) await handle.chmod(existing.mode & 0o7777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (createOnly) {
      // link fails with EEXIST when the target appeared after the check.
      await link(temp, resolvedPath);
      await unlink(temp);
    } else {
      await rename(temp, resolvedPath);
    }
    tempCreated = false;
  } catch (error: unknown) {
    if (tempCreated) await unlink(temp).catch(() => { /* best effort: the temp file may already be gone */ });
    throw fsError(error, resolvedPath);
  }
  await syncDirectory(dirname(resolvedPath));
}

/** Persist the rename. Best effort: some filesystems refuse a directory fsync. */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch { /* best effort: the rename itself is already visible */ }
}

export async function readRemoteFile(path: string): Promise<RemoteFileRead> {
  assertAbsolutePath(path);
  const resolvedPath = await realpath(path).catch((error: unknown) => { throw fsError(error, path); });
  const bytes = await readCapped(resolvedPath);
  const text = utf8Text(bytes);
  return text === null
    ? { ok: true, path, resolvedPath, size: bytes.length, binary: true, encoding: REMOTE_FILE_ENCODING.BASE64, content: bytes.toString("base64") }
    : { ok: true, path, resolvedPath, size: bytes.length, binary: false, encoding: REMOTE_FILE_ENCODING.UTF8, content: text };
}

export async function writeRemoteFile(path: string, bytes: Buffer, options: { readonly createOnly: boolean }): Promise<RemoteFileWrite> {
  assertAbsolutePath(path);
  if (bytes.length > REMOTE_FILE_MAX_BYTES) throw tooLarge(bytes.length);
  const target = await resolveTarget(path);
  if (options.createOnly && target.existing) {
    throw new RemoteFileError(REMOTE_FILE_ERROR.FILE_EXISTS, `file exists: ${target.resolvedPath}`);
  }
  await atomicReplace(target, bytes, options.createOnly);
  return { ok: true, path, resolvedPath: target.resolvedPath, size: bytes.length, created: target.existing === null };
}

export async function editRemoteFile(
  path: string,
  oldText: string,
  newText: string,
  options: { readonly all: boolean },
): Promise<RemoteFileEdit> {
  assertAbsolutePath(path);
  if (oldText.length === 0) throw new RemoteFileError(REMOTE_FILE_ERROR.INVALID_REQUEST, "old text must not be empty");
  const target = await resolveTarget(path);
  if (!target.existing) throw new RemoteFileError(REMOTE_FILE_ERROR.NOT_FOUND, `no such file or directory: ${path}`);
  const text = utf8Text(await readCapped(target.resolvedPath));
  if (text === null) throw new RemoteFileError(REMOTE_FILE_ERROR.BINARY_FILE, `not a UTF-8 text file: ${target.resolvedPath}`);
  // split/join: a literal replacement (String.replace would expand `$&` and similar patterns).
  const parts = text.split(oldText);
  const matches = parts.length - 1;
  if (matches === 0 || (!options.all && matches !== 1)) {
    throw new RemoteFileError(
      REMOTE_FILE_ERROR.EDIT_MATCH_COUNT,
      `old text matched ${matches} times; expected ${options.all ? "at least 1" : "exactly 1"}`,
      { matches },
    );
  }
  const bytes = Buffer.from(parts.join(newText), "utf8");
  if (bytes.length > REMOTE_FILE_MAX_BYTES) throw tooLarge(bytes.length);
  await atomicReplace(target, bytes, false);
  return { ok: true, path, resolvedPath: target.resolvedPath, size: bytes.length, replacements: matches };
}
