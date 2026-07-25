export const SESSION_TERMINAL_STATUS = {
  READY: "ready",
  DEAD: "dead",
  UNAVAILABLE: "unavailable",
} as const;

export const SESSION_TERMINAL_STATUSES = [
  SESSION_TERMINAL_STATUS.READY,
  SESSION_TERMINAL_STATUS.DEAD,
  SESSION_TERMINAL_STATUS.UNAVAILABLE,
] as const;

export type SessionTerminalStatus = typeof SESSION_TERMINAL_STATUSES[number];

export interface SessionTerminalLiveness {
  readonly exists: boolean;
  readonly alive: boolean;
  readonly status: SessionTerminalStatus;
}

export type SessionInspectionResult =
  | {
    readonly ok: true;
    readonly session: string;
    readonly sessionId: string;
    readonly projectPath: string;
    readonly harness: string;
    readonly alive: boolean;
    readonly parentSession?: {
      readonly session: string;
      readonly sessionId: string;
    };
  }
  | {
    readonly ok: false;
    readonly code: "NOT_FOUND" | "AMBIGUOUS";
  };

export const SESSION_STATUS_ERROR = {
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "SESSION_NOT_FOUND",
  AMBIGUOUS: "AMBIGUOUS_SELECTOR",
  DEAD: "SESSION_DEAD",
  BACKEND_UNAVAILABLE: "BACKEND_UNAVAILABLE",
} as const;

export type SessionStatusErrorCode = typeof SESSION_STATUS_ERROR[keyof typeof SESSION_STATUS_ERROR];

export const SESSION_STATUS_ERROR_MESSAGE: Readonly<Record<SessionStatusErrorCode, string>> = {
  [SESSION_STATUS_ERROR.INVALID_REQUEST]: "missing session selector",
  [SESSION_STATUS_ERROR.NOT_FOUND]: "session not found",
  [SESSION_STATUS_ERROR.AMBIGUOUS]: "ambiguous session selector",
  [SESSION_STATUS_ERROR.DEAD]: "session is not alive",
  [SESSION_STATUS_ERROR.BACKEND_UNAVAILABLE]: "backend unavailable",
};

export const SESSION_STATUS_IDENTITY_MAX_CODE_POINTS = 256;
export const SESSION_STATUS_ERROR_MESSAGE_MAX_CODE_POINTS = 160;

const SESSION_TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(SESSION_TERMINAL_STATUSES);
const SESSION_STATUS_ERROR_SET: ReadonlySet<string> = new Set(Object.values(SESSION_STATUS_ERROR));

export function isSessionTerminalStatus(value: unknown): value is SessionTerminalStatus {
  return typeof value === "string" && SESSION_TERMINAL_STATUS_SET.has(value);
}

export function isSessionStatusErrorCode(value: unknown): value is SessionStatusErrorCode {
  return typeof value === "string" && SESSION_STATUS_ERROR_SET.has(value);
}

export function isBoundedSessionStatusIdentity(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Array.from(value).length <= SESSION_STATUS_IDENTITY_MAX_CODE_POINTS;
}

export function parseSessionTerminalLiveness(value: unknown): SessionTerminalLiveness | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.exists !== "boolean" || typeof candidate.alive !== "boolean") return null;
  if (!isSessionTerminalStatus(candidate.status)) return null;
  return {
    exists: candidate.exists,
    alive: candidate.alive,
    status: candidate.status,
  };
}
