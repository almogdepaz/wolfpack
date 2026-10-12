/**
 * Program Status Protocol (OSC 7501) records as reported by the broker.
 *
 * The broker validates, sanitizes and stores records per session; this module
 * only checks the wire shape and maps the protocol's states onto Wolfpack's
 * existing agent status vocabulary. Spec:
 * https://www.superlogical.com/rex/docs/build/program-status
 */
import { AGENT_STATUS_STATE } from "./agent-status-contract.js";
import type { AgentStatusState } from "./agent-status-contract.js";

export const PROGRAM_STATUS_STATE = {
  IDLE: "idle",
  WORKING: "working",
  DONE: "done",
  BLOCKED: "blocked",
  ERROR: "error",
} as const;

export type ProgramStatusState = typeof PROGRAM_STATUS_STATE[keyof typeof PROGRAM_STATUS_STATE];

export const PROGRAM_STATUS_KIND = {
  PERMISSION: "permission",
  QUESTION: "question",
  AUTH: "auth",
} as const;

export type ProgramStatusKind = typeof PROGRAM_STATUS_KIND[keyof typeof PROGRAM_STATUS_KIND];

export const PROGRAM_STATUS_KINDS = Object.values(PROGRAM_STATUS_KIND) as readonly ProgramStatusKind[];

/** UTF-8 byte bounds from the spec; the broker enforces the same limits. */
export const PROGRAM_STATUS_LIMITS = {
  ID_BYTES: 128,
  APP_BYTES: 32,
  TITLE_BYTES: 192,
  MESSAGE_BYTES: 2048,
  PROGRESS_MAX: 100,
} as const;

export interface ProgramStatusRecord {
  /** Empty for the root record (the program itself). */
  readonly id: string;
  readonly state: ProgramStatusState;
  readonly kind?: ProgramStatusKind;
  readonly progress?: number;
  readonly app?: string;
  readonly title?: string;
  readonly message?: string;
  /** Broker wall clock when the record's content last changed. */
  readonly updatedAtMs: number;
}

const PROGRAM_STATUS_AGENT_STATE: Record<ProgramStatusState, AgentStatusState> = {
  [PROGRAM_STATUS_STATE.IDLE]: AGENT_STATUS_STATE.IDLE,
  [PROGRAM_STATUS_STATE.WORKING]: AGENT_STATUS_STATE.WORKING,
  [PROGRAM_STATUS_STATE.DONE]: AGENT_STATUS_STATE.DONE,
  [PROGRAM_STATUS_STATE.BLOCKED]: AGENT_STATUS_STATE.NEEDS_INPUT,
  [PROGRAM_STATUS_STATE.ERROR]: AGENT_STATUS_STATE.FAILED,
};

const PROGRAM_STATUS_STATE_SET: ReadonlySet<string> = new Set(Object.values(PROGRAM_STATUS_STATE));
const PROGRAM_STATUS_KIND_SET: ReadonlySet<string> = new Set(PROGRAM_STATUS_KINDS);
const utf8 = new TextEncoder();

export function programStatusAgentState(state: ProgramStatusState): AgentStatusState {
  return PROGRAM_STATUS_AGENT_STATE[state];
}

function boundedText(value: unknown, maxBytes: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || utf8.encode(value).length > maxBytes) return null;
  return value;
}

/** Parse one broker `ProgramStatusRecord` (snake_case JSON); undefined when malformed. */
export function parseBrokerProgramStatusRecord(raw: unknown): ProgramStatusRecord | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.state !== "string" || !PROGRAM_STATUS_STATE_SET.has(obj.state)) return undefined;
  if (obj.kind !== undefined && (typeof obj.kind !== "string" || !PROGRAM_STATUS_KIND_SET.has(obj.kind))) return undefined;
  if (obj.progress !== undefined && !(
    Number.isInteger(obj.progress)
    && (obj.progress as number) >= 0
    && (obj.progress as number) <= PROGRAM_STATUS_LIMITS.PROGRESS_MAX
  )) return undefined;
  if (!Number.isSafeInteger(obj.updated_at_ms) || (obj.updated_at_ms as number) < 0) return undefined;
  const id = boundedText(obj.id, PROGRAM_STATUS_LIMITS.ID_BYTES);
  const app = boundedText(obj.app, PROGRAM_STATUS_LIMITS.APP_BYTES);
  const title = boundedText(obj.title, PROGRAM_STATUS_LIMITS.TITLE_BYTES);
  const message = boundedText(obj.message, PROGRAM_STATUS_LIMITS.MESSAGE_BYTES);
  if (typeof id !== "string" || app === null || title === null || message === null) return undefined;
  return {
    id,
    state: obj.state as ProgramStatusState,
    ...(obj.kind !== undefined && { kind: obj.kind as ProgramStatusKind }),
    ...(obj.progress !== undefined && { progress: obj.progress as number }),
    ...(app !== undefined && { app }),
    ...(title !== undefined && { title }),
    ...(message !== undefined && { message }),
    updatedAtMs: obj.updated_at_ms as number,
  };
}
