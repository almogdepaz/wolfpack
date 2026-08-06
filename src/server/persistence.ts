import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export type PersistenceReadFailure = "unreadable" | "malformed";

export class PersistenceReadError extends Error {
  readonly path: string;
  readonly failure: PersistenceReadFailure;

  constructor(
    label: string,
    path: string,
    failure: PersistenceReadFailure,
    cause?: unknown,
  ) {
    super(`${label} persistence is ${failure}: ${path}`, { cause });
    this.name = "PersistenceReadError";
    this.path = path;
    this.failure = failure;
  }
}

export function readValidatedJsonFile<T>(
  path: string,
  label: string,
  validate: (value: unknown) => value is T,
): T | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PersistenceReadError(label, path, "unreadable", error);
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new PersistenceReadError(label, path, "malformed", error);
  }
  if (!validate(value)) {
    throw new PersistenceReadError(label, path, "malformed");
  }
  return value;
}


/** Atomic, owner-only JSON persistence with file and best-effort directory durability. */
export function writePrivateJsonFile(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}
`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    try {
      const dirFd = openSync(directory, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch { /* directory fsync is not supported on every platform */ }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
  }
}
