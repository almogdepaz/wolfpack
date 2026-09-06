import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { AGENT_KIND } from "../agent-kind.js";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { SessionInspectionResult } from "../session-status-contract.js";
import type { RelayEndpoint } from "../task-relay/domain.js";
import {
  SESSION_TASK_WORKER_CLEANUP_TIMEOUT_MS,
  SESSION_TASK_WORKER_DEFAULT_READINESS_TIMEOUT_MS,
  SESSION_TASK_WORKER_MAX_READINESS_TIMEOUT_MS,
} from "../session-open-contract.js";

export const TASK_WORKER_DEFAULT_READINESS_TIMEOUT_MS = SESSION_TASK_WORKER_DEFAULT_READINESS_TIMEOUT_MS;
export const TASK_WORKER_MAX_READINESS_TIMEOUT_MS = SESSION_TASK_WORKER_MAX_READINESS_TIMEOUT_MS;
export const TASK_WORKER_CLEANUP_TIMEOUT_MS = SESSION_TASK_WORKER_CLEANUP_TIMEOUT_MS;
export const TASK_WORKER_READINESS_POLL_MS = 100;
export const TASK_WORKER_MAX_PATH_LENGTH = 4_096;

export const TASK_WORKER_ERROR = {
  PREFLIGHT_FAILED: "TASK_WORKER_PREFLIGHT_FAILED",
  NOT_READY: "TASK_WORKER_NOT_READY",
} as const;

export type TaskWorkerErrorCode = typeof TASK_WORKER_ERROR[keyof typeof TASK_WORKER_ERROR];
export type TaskWorkerCleanup = "completed" | "unconfirmed";

export interface TaskWorkerLaunch {
  readonly executable: string;
  readonly extension: string;
}

export interface TaskWorkerCreatedSession {
  readonly session: string;
  readonly sessionId: string;
}

export class TaskWorkerReadinessError extends Error {
  readonly code: TaskWorkerErrorCode;
  readonly createdSession: TaskWorkerCreatedSession | undefined;
  readonly cleanup: TaskWorkerCleanup | undefined;

  constructor(
    code: TaskWorkerErrorCode,
    message: string,
    createdSession: TaskWorkerCreatedSession | undefined = undefined,
    cleanup: TaskWorkerCleanup | undefined = undefined,
  ) {
    super(message);
    this.name = "TaskWorkerReadinessError";
    this.code = code;
    this.createdSession = createdSession;
    this.cleanup = cleanup;
  }
}

export interface TaskWorkerReadinessBackend {
  inspectSession?(selector: string): Promise<SessionInspectionResult>;
  killSessionById?(sessionId: string): Promise<void>;
}

interface WaitForTaskWorkerReadinessInput {
  readonly backend: TaskWorkerReadinessBackend;
  readonly endpointForSession: (sessionId: string) => Promise<RelayEndpoint | undefined>;
  readonly sessionId: string;
  readonly session?: string;
  readonly projectDir: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly cleanupTimeoutMs?: number;
}

type BoundedResult<TValue> =
  | { readonly completed: true; readonly value: TValue }
  | { readonly completed: false };

function configuredPath(
  value: string | undefined,
  fallback: string,
  name: string,
): string {
  const path = value?.trim() || fallback;
  if (
    !path
    || path.length > TASK_WORKER_MAX_PATH_LENGTH
    || path.includes("\0")
    || !isAbsolute(path)
  ) {
    throw new TaskWorkerReadinessError(
      TASK_WORKER_ERROR.PREFLIGHT_FAILED,
      `${name} must be an absolute path`,
    );
  }
  return path;
}

function executableFromPath(pathValue: string | undefined): string {
  if (pathValue === undefined) {
    throw new TaskWorkerReadinessError(
      TASK_WORKER_ERROR.PREFLIGHT_FAILED,
      "pi executable is not available on PATH",
    );
  }
  for (const entry of pathValue.split(delimiter)) {
    if (!entry) continue;
    const candidate = resolve(entry, "pi");
    if (isExecutableFile(candidate)) return candidate;
  }
  throw new TaskWorkerReadinessError(
    TASK_WORKER_ERROR.PREFLIGHT_FAILED,
    "pi executable is not available on PATH",
  );
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isReadableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves only the executable and extension that the task-worker launch actually uses. */
export function prepareTaskWorkerLaunch(env: Readonly<Record<string, string | undefined>>): TaskWorkerLaunch {
  const executable = env.WOLFPACK_TASK_WORKER_PI_EXECUTABLE === undefined
    ? executableFromPath(env.PATH)
    : configuredPath(
      env.WOLFPACK_TASK_WORKER_PI_EXECUTABLE,
      "",
      "WOLFPACK_TASK_WORKER_PI_EXECUTABLE",
    );
  if (!isExecutableFile(executable)) {
    throw new TaskWorkerReadinessError(
      TASK_WORKER_ERROR.PREFLIGHT_FAILED,
      "task-worker Pi executable is missing or not executable",
    );
  }

  const agentDirectory = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const extension = configuredPath(
    env.WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION,
    join(agentDirectory, "npm", "node_modules", "@sgtbeatdown", "pi-tasks", "src", "extension.ts"),
    "WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION",
  );
  if (!isReadableFile(extension)) {
    throw new TaskWorkerReadinessError(
      TASK_WORKER_ERROR.PREFLIGHT_FAILED,
      "task-worker Pi Tasks extension is missing or unreadable",
    );
  }
  return { executable, extension };
}

function readySession(
  inspection: SessionInspectionResult,
  sessionId: string,
  projectDir: string,
): boolean {
  return inspection.ok
    && inspection.sessionId === sessionId
    && inspection.projectPath === projectDir
    && inspection.harness === AGENT_KIND.PI.id
    && inspection.alive;
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function boundOperation<TValue>(
  operation: () => Promise<TValue>,
  deadline: number,
): Promise<BoundedResult<TValue>> {
  const remaining = remainingMilliseconds(deadline);
  if (remaining === 0) return { completed: false };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation().then((value) => ({ completed: true, value }) as const),
      new Promise<BoundedResult<TValue>>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout({ completed: false }), remaining);
        timeout.unref?.();
      }),
    ]);
    return result.completed && remainingMilliseconds(deadline) === 0
      ? { completed: false }
      : result;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function cleanupConfirmed(
  inspection: SessionInspectionResult,
  sessionId: string,
): boolean {
  if (!inspection.ok) return inspection.code === "NOT_FOUND";
  return inspection.sessionId === sessionId && !inspection.alive;
}

async function cleanupCreatedWorker(
  backend: TaskWorkerReadinessBackend,
  createdSession: TaskWorkerCreatedSession,
  timeoutMs: number,
): Promise<TaskWorkerCleanup> {
  const killSessionById = backend.killSessionById;
  const inspectSession = backend.inspectSession;
  if (!killSessionById || !inspectSession) return "unconfirmed";
  const deadline = Date.now() + timeoutMs;
  try {
    const kill = await boundOperation(() => killSessionById.call(backend, createdSession.sessionId), deadline);
    if (!kill.completed) return "unconfirmed";
    const inspection = await boundOperation(() => inspectSession.call(backend, createdSession.sessionId), deadline);
    return inspection.completed && cleanupConfirmed(inspection.value, createdSession.sessionId)
      ? "completed"
      : "unconfirmed";
  } catch {
    return "unconfirmed";
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export async function failTaskWorkerReadiness(
  backend: TaskWorkerReadinessBackend,
  createdSession: TaskWorkerCreatedSession,
  message: string,
  cleanupTimeoutMs = TASK_WORKER_CLEANUP_TIMEOUT_MS,
): Promise<never> {
  const cleanup = await cleanupCreatedWorker(backend, createdSession, cleanupTimeoutMs);
  throw new TaskWorkerReadinessError(
    TASK_WORKER_ERROR.NOT_READY,
    message,
    createdSession,
    cleanup,
  );
}

/** Waits only on structured broker identity and lease-valid relay endpoint state. */
export async function waitForTaskWorkerReadiness(
  input: WaitForTaskWorkerReadinessInput,
): Promise<RelayEndpoint> {
  const createdSession: TaskWorkerCreatedSession = {
    session: input.session ?? input.sessionId,
    sessionId: input.sessionId,
  };
  const inspectSession = input.backend.inspectSession?.bind(input.backend);
  const deadline = Date.now() + input.timeoutMs;
  const pollIntervalMs = input.pollIntervalMs ?? TASK_WORKER_READINESS_POLL_MS;
  const cleanupTimeoutMs = input.cleanupTimeoutMs ?? TASK_WORKER_CLEANUP_TIMEOUT_MS;
  let failure = "task worker did not register a live task endpoint before the readiness deadline";

  while (remainingMilliseconds(deadline) > 0) {
    try {
      const inspection = inspectSession === undefined
        ? { completed: false } as const
        : await boundOperation(() => inspectSession(input.sessionId), deadline);
      if (!inspection.completed) {
        failure = "task worker readiness inspection exceeded the readiness deadline";
        break;
      }
      if (!readySession(inspection.value, input.sessionId, input.projectDir)) {
        failure = "task worker session identity, project root, harness, or liveness changed before readiness";
        break;
      }
      const endpoint = await boundOperation(() => input.endpointForSession(input.sessionId), deadline);
      if (!endpoint.completed) {
        failure = "task worker endpoint lookup exceeded the readiness deadline";
        break;
      }
      if (endpoint.value !== undefined) {
        const liveness = inspectSession === undefined
          ? { completed: false } as const
          : await boundOperation(() => inspectSession(input.sessionId), deadline);
        if (!liveness.completed) {
          failure = "task worker liveness check exceeded the readiness deadline";
          break;
        }
        if (!readySession(liveness.value, input.sessionId, input.projectDir)) {
          failure = "task worker exited or changed before endpoint readiness";
          break;
        }
        if (remainingMilliseconds(deadline) === 0) {
          failure = "task worker readiness reached the deadline before endpoint return";
          break;
        }
        return endpoint.value;
      }
    } catch {
      failure = "task worker readiness inspection is unavailable";
      break;
    }
    const remaining = remainingMilliseconds(deadline);
    if (remaining === 0) break;
    await sleep(Math.min(Math.max(0, pollIntervalMs), remaining));
  }

  return failTaskWorkerReadiness(input.backend, createdSession, failure, cleanupTimeoutMs);
}
