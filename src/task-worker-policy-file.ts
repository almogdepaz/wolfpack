import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { TASK_WORKER_POLICY_MAX_BYTES } from "./task-worker-policy-contract.js";

export type TaskWorkerPolicyFileErrorCode = "unreadable" | "invalid";

export class TaskWorkerPolicyFileError extends Error {
  readonly code: TaskWorkerPolicyFileErrorCode;

  constructor(code: TaskWorkerPolicyFileErrorCode) {
    super("task-worker policy file unreadable");
    this.name = "TaskWorkerPolicyFileError";
    this.code = code;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isAbsentPath(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error: unknown) {
    return hasErrorCode(error, "ENOENT");
  }
}

/** Returns undefined only when no directory entry exists at path. */
export function readBoundedTaskWorkerPolicyFile(path: string): string | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT") && isAbsentPath(path)) return undefined;
    throw new TaskWorkerPolicyFileError("unreadable");
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > TASK_WORKER_POLICY_MAX_BYTES) {
      throw new TaskWorkerPolicyFileError("invalid");
    }
    const bytes = Buffer.alloc(TASK_WORKER_POLICY_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > TASK_WORKER_POLICY_MAX_BYTES) throw new TaskWorkerPolicyFileError("invalid");
    return bytes.toString("utf8", 0, length);
  } catch (error: unknown) {
    if (error instanceof TaskWorkerPolicyFileError) throw error;
    throw new TaskWorkerPolicyFileError("unreadable");
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      throw new TaskWorkerPolicyFileError("unreadable");
    }
  }
}
