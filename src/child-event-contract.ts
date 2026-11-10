/**
 * Child-event wire contract (`wolfpack.child_event/v1`). The server derives
 * these events from observation and lineage; they reach the parent inbox, the
 * `child_event` SSE kind and, in later phases, relay envelopes. Shared by the
 * server and the CLI. Optional fields may be added; existing fields keep their
 * names and meaning.
 */
import type { AgentStatusAuthority, AgentStatusState } from "./agent-status-contract.js";
import type { ProgramStatusKind } from "./program-status-contract.js";

export const CHILD_EVENT_PAYLOAD_KIND = "wolfpack.child_event/v1";

/**
 * A relay endpoint that lists this number in its connect `protocolVersions`
 * decodes `wolfpack.child_event/v1` payloads. It is a capability marker, not an
 * envelope version: envelopes keep the relay wire version. The server sends
 * child events by relay only to such endpoints, because an adapter that cannot
 * decode a payload rejects its whole inbox page.
 */
export const CHILD_EVENT_RELAY_PROTOCOL = 1001;

export const CHILD_EVENT = {
  BLOCKED: "blocked",
  ERROR: "error",
  DONE: "done",
  EXITED: "exited",
  MESSAGE: "message",
} as const;

export const CHILD_EVENTS = [
  CHILD_EVENT.BLOCKED,
  CHILD_EVENT.ERROR,
  CHILD_EVENT.DONE,
  CHILD_EVENT.EXITED,
  CHILD_EVENT.MESSAGE,
] as const;

export type ChildEventName = typeof CHILD_EVENTS[number];

/** Bounds keep an event inside the parent inbox entry limits (message ≤ 500 code points). */
export const CHILD_EVENT_LIMITS = {
  MESSAGE_CODE_POINTS: 500,
  LAST_LINES: 5,
  LAST_LINE_CODE_POINTS: 200,
} as const;

export interface ChildEventPayload {
  readonly kind: typeof CHILD_EVENT_PAYLOAD_KIND;
  /** Stable per event: child session id, server boot and parent inbox sequence. */
  readonly eventId: string;
  /** The server process that assigned `seq`; a new boot restarts sequences. */
  readonly bootId: string;
  /** The parent inbox sequence of this event (monotonic per parent within one boot). */
  readonly seq: number;
  readonly childSessionId: string;
  readonly childName: string;
  readonly parentSessionId: string;
  readonly event: ChildEventName;
  /** The child's runtime state when the event was derived. */
  readonly state: AgentStatusState;
  readonly inputKind?: ProgramStatusKind;
  /** Program status text, or the `notify-parent` message for `message` events. */
  readonly message?: string;
  /** Last observed screen lines, newest last; only on `exited`. */
  readonly lastLines?: readonly string[];
  readonly observedAt: string;
  /** Which status authority produced `state`. */
  readonly authority?: AgentStatusAuthority;
  /** `exited` only: `exit` or `killed`. */
  readonly reason?: "exit" | "killed";
  readonly exitCode?: number;
  readonly signal?: number;
}

/** Drop control characters and cap length by code points. */
export function boundedChildEventText(value: string, maximum: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  const codePoints = [...cleaned];
  return codePoints.length <= maximum ? cleaned : codePoints.slice(0, maximum).join("");
}

/** One-line inbox text for an event; the inbox `from` field names the child. */
export function childEventSummary(payload: Pick<ChildEventPayload, "event" | "state" | "inputKind" | "message" | "reason" | "exitCode" | "signal">): string {
  let text: string;
  switch (payload.event) {
    case CHILD_EVENT.MESSAGE:
      text = payload.message ?? "";
      break;
    case CHILD_EVENT.BLOCKED:
      text = `blocked${payload.inputKind ? ` (${payload.inputKind})` : ""}${payload.message ? `: ${payload.message}` : ""}`;
      break;
    case CHILD_EVENT.ERROR:
      text = `error${payload.message ? `: ${payload.message}` : ""}`;
      break;
    case CHILD_EVENT.DONE:
      text = `done${payload.message ? `: ${payload.message}` : ""}`;
      break;
    case CHILD_EVENT.EXITED: {
      const detail = payload.exitCode !== undefined
        ? ` (exit code ${payload.exitCode})`
        : payload.signal !== undefined ? ` (signal ${payload.signal})` : "";
      text = `${payload.reason === "killed" ? "killed" : "exited"}${detail}`;
      break;
    }
  }
  return boundedChildEventText(text, CHILD_EVENT_LIMITS.MESSAGE_CODE_POINTS);
}

/** `agent wait --children`: `any` returns on the first new event; `all` when every live child is settled. */
export const CHILD_WAIT_MODE = {
  ANY: "any",
  ALL: "all",
} as const;

export const CHILD_WAIT_MODES = [CHILD_WAIT_MODE.ANY, CHILD_WAIT_MODE.ALL] as const;

export type ChildWaitMode = typeof CHILD_WAIT_MODES[number];

/**
 * Why a child wait returned. `timeout` is a check-in, not a failure: the
 * caller looks at the children and waits again with the returned cursor.
 */
export const CHILD_WAIT_OUTCOME = {
  EVENTS: "events",
  SETTLED: "settled",
  NO_CHILDREN: "no_children",
  TIMEOUT: "timeout",
} as const;

export const CHILD_WAIT_OUTCOMES = [
  CHILD_WAIT_OUTCOME.EVENTS,
  CHILD_WAIT_OUTCOME.SETTLED,
  CHILD_WAIT_OUTCOME.NO_CHILDREN,
  CHILD_WAIT_OUTCOME.TIMEOUT,
] as const;

export type ChildWaitOutcome = typeof CHILD_WAIT_OUTCOMES[number];

export const CHILD_WAIT_LIMITS = {
  DEFAULT_TIMEOUT_MS: 180_000,
  MAX_TIMEOUT_MS: 600_000,
  /** `all` re-checks child states at this interval: a state can settle without an event. */
  RECHECK_MS: 1_000,
  /** Concurrent waits per server process. */
  WAITERS: 32,
  /** Extra time the CLI allows past the server timeout before it gives up on the response. */
  CLIENT_GRACE_MS: 30_000,
} as const;
