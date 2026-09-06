import { AGENT_KIND } from "../agent-kind.js";
import {
  isOpenableHarness,
  SESSION_OPEN_ERROR,
  SESSION_OPEN_HTTP_STATUS,
} from "../session-open-contract.js";
import type {
  OpenableHarness,
  SessionOpenErrorCode,
} from "../session-open-contract.js";
import { MAX_SESSION_NAME_LENGTH } from "../validation.js";
import {
  TASK_WORKER_DEFAULT_READINESS_TIMEOUT_MS,
  TaskWorkerReadinessError,
  failTaskWorkerReadiness,
  waitForTaskWorkerReadiness,
} from "./task-worker-readiness.js";
import type { TaskWorkerLaunch } from "./task-worker-readiness.js";
import type { RelayEndpoint } from "../task-relay/domain.js";
import { DuplicateSessionError } from "./backend.js";
import type { SessionLaunchOptions } from "./backend.js";
import type {
  ParentSessionIdentity,
  PublicSessionIdentity,
} from "./session-identity.js";

export const SESSION_OPEN_MAX_CREATE_ATTEMPTS = 4;

type SessionOpenAllocationErrorCode = Exclude<
  SessionOpenErrorCode,
  typeof SESSION_OPEN_ERROR.PROJECT_NOT_FOUND
>;

const ERROR_MESSAGE: Record<SessionOpenAllocationErrorCode, string> = {
  INVALID_REQUEST: "invalid session-open request",
  PARENT_SESSION_NOT_FOUND: "parent session not found",
  PARENT_SESSION_CHANGED: "parent session identity changed",
  PARENT_IDENTITY_UNAVAILABLE: "parent session identity unavailable",
  UNSUPPORTED_HARNESS: "parent session is not running a supported agent harness",
  NAME_COLLISION: "could not allocate a sub-agent session name",
  BACKEND_UNAVAILABLE: "backend unavailable",
  TASK_WORKER_PREFLIGHT_FAILED: "task worker preflight failed",
  TASK_WORKER_NOT_READY: "task worker not ready",
};

export class SessionOpenError extends Error {
  readonly code: SessionOpenAllocationErrorCode;
  readonly status: number;

  constructor(code: SessionOpenAllocationErrorCode) {
    super(ERROR_MESSAGE[code]);
    this.name = "SessionOpenError";
    this.code = code;
    this.status = SESSION_OPEN_HTTP_STATUS[code];
  }
}

export interface SessionOpenBackend {
  list(): Promise<string[]>;
  listIdentities(): Promise<Record<string, PublicSessionIdentity>>;
  createSession(
    name: string,
    cwd: string,
    cmd: string | undefined,
    loadSettings: () => { agentCmd: string },
    options?: SessionLaunchOptions,
  ): Promise<PublicSessionIdentity>;
  inspectSession?(selector: string): Promise<import("../session-status-contract.js").SessionInspectionResult>;
  killSessionById?(sessionId: string): Promise<void>;
}

interface ParentState {
  readonly names: readonly string[];
  readonly identity: PublicSessionIdentity;
  readonly harness: OpenableHarness;
}

export interface SessionOpenSuccess {
  readonly ok: true;
  readonly session: string;
  readonly sessionId: string;
  readonly project: string;
  readonly harness: OpenableHarness;
  readonly taskEndpoint?: RelayEndpoint;
}

interface OpenSubSessionInput {
  readonly backend: SessionOpenBackend;
  readonly parentSession: string;
  readonly project: string;
  readonly projectDir: string;
  readonly sessionName?: string;
  readonly model?: string;
  readonly initialPrompt?: string;
  readonly taskWorker?: TaskWorkerLaunch;
  readonly readinessTimeoutMs?: number;
  readonly endpointForSession?: (sessionId: string) => Promise<RelayEndpoint | undefined>;
  readonly notify?: (parent: ParentSessionIdentity, session: string) => void;
}

async function readParentState(
  backend: SessionOpenBackend,
  parentSession: string,
  expectedParentId?: string,
): Promise<ParentState> {
  let names: string[];
  let identities: Record<string, PublicSessionIdentity>;
  try {
    names = await backend.list();
    if (!names.includes(parentSession)) {
      throw new SessionOpenError(SESSION_OPEN_ERROR.PARENT_SESSION_NOT_FOUND);
    }
    identities = await backend.listIdentities();
  } catch (error: unknown) {
    if (error instanceof SessionOpenError) throw error;
    throw new SessionOpenError(SESSION_OPEN_ERROR.BACKEND_UNAVAILABLE);
  }

  const identity = identities[parentSession];
  if (!identity || identity.wolfpackSessionName !== parentSession) {
    throw new SessionOpenError(SESSION_OPEN_ERROR.PARENT_IDENTITY_UNAVAILABLE);
  }
  if (expectedParentId !== undefined && identity.wolfpackSessionId !== expectedParentId) {
    throw new SessionOpenError(SESSION_OPEN_ERROR.PARENT_SESSION_CHANGED);
  }
  if (!isOpenableHarness(identity.agentKind)) {
    throw new SessionOpenError(SESSION_OPEN_ERROR.UNSUPPORTED_HARNESS);
  }
  return { names, identity, harness: identity.agentKind };
}

export function chooseSubAgentSessionName(
  parentSession: string,
  existingNames: readonly string[],
  requestedSessionName?: string,
): string {
  const existing = new Set(existingNames);
  for (let number = 1; ; number++) {
    const suffix = requestedSessionName
      ? (number === 1 ? "" : `-${number}`)
      : (number === 1 ? "-sub-agent" : `-sub-agent-${number}`);
    const base = requestedSessionName ?? parentSession;
    const prefix = base.slice(0, MAX_SESSION_NAME_LENGTH - suffix.length);
    const candidate = `${prefix}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
}

export async function openSubSession(input: OpenSubSessionInput): Promise<SessionOpenSuccess> {
  let parentState = await readParentState(input.backend, input.parentSession);
  const parentIdentity: ParentSessionIdentity = {
    wolfpackSessionId: parentState.identity.wolfpackSessionId,
    wolfpackSessionName: parentState.identity.wolfpackSessionName,
  };

  for (let attempt = 0; attempt < SESSION_OPEN_MAX_CREATE_ATTEMPTS; attempt++) {
    if (
      (input.model !== undefined || input.taskWorker !== undefined)
      && parentState.harness !== AGENT_KIND.PI.id
    ) {
      throw new SessionOpenError(SESSION_OPEN_ERROR.INVALID_REQUEST);
    }
    const session = chooseSubAgentSessionName(
      input.parentSession,
      parentState.names,
      input.sessionName,
    );
    let identity: PublicSessionIdentity;
    try {
      identity = await input.backend.createSession(
        session,
        input.projectDir,
        parentState.harness,
        () => ({ agentCmd: parentState.harness }),
        {
          agentKind: parentState.harness,
          parentSession: parentIdentity,
          ...(input.model !== undefined && { model: input.model }),
          initialPrompt: input.initialPrompt,
          ...(input.taskWorker !== undefined && { taskWorker: input.taskWorker }),
        },
      );
    } catch (error: unknown) {
      if (!(error instanceof DuplicateSessionError)) {
        throw new SessionOpenError(SESSION_OPEN_ERROR.BACKEND_UNAVAILABLE);
      }
      if (attempt + 1 >= SESSION_OPEN_MAX_CREATE_ATTEMPTS) {
        throw new SessionOpenError(SESSION_OPEN_ERROR.NAME_COLLISION);
      }
      parentState = await readParentState(
        input.backend,
        input.parentSession,
        parentIdentity.wolfpackSessionId,
      );
      continue;
    }

    try {
      await readParentState(
        input.backend,
        input.parentSession,
        parentIdentity.wolfpackSessionId,
      );
    } catch (error: unknown) {
      if (input.taskWorker === undefined || error instanceof TaskWorkerReadinessError) throw error;
      return failTaskWorkerReadiness(input.backend, {
        session,
        sessionId: identity.wolfpackSessionId,
      }, error instanceof Error ? error.message : "task worker parent identity check failed");
    }
    const taskEndpoint = input.taskWorker === undefined
      ? undefined
      : await waitForTaskWorkerReadiness({
        backend: input.backend,
        endpointForSession: input.endpointForSession ?? (async () => undefined),
        session,
        sessionId: identity.wolfpackSessionId,
        projectDir: input.projectDir,
        timeoutMs: input.readinessTimeoutMs ?? TASK_WORKER_DEFAULT_READINESS_TIMEOUT_MS,
      });
    if (input.notify) {
      try {
        input.notify(parentIdentity, session);
      } catch {
        // Browser notification is best-effort after successful creation.
      }
    }
    return {
      ok: true,
      session,
      sessionId: identity.wolfpackSessionId,
      project: input.project,
      harness: parentState.harness,
      ...(taskEndpoint && { taskEndpoint }),
    };
  }

  throw new SessionOpenError(SESSION_OPEN_ERROR.NAME_COLLISION);
}
