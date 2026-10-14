import { SESSION_PROMPT_OUTCOME } from "./session-prompt-contract.js";

export const SESSION_SEND_DEFAULT_OBSERVE_MS = 1_500;
export const SESSION_SEND_MAX_OBSERVE_MS = 10_000;

/** Whether the bytes reached the session, judged from output or program status after the write. */
export const SESSION_SEND_DELIVERY = {
  DELIVERED: "delivered",
  NOT_DELIVERED: "not_delivered",
  UNVERIFIED: "unverified",
} as const;

export type SessionSendDelivery = (typeof SESSION_SEND_DELIVERY)[keyof typeof SESSION_SEND_DELIVERY];

/**
 * What the send achieved. Without `noEnter`, `submitted` means the program's
 * OSC 7501 status left `idle` after the write, and `pasted_not_submitted` means
 * the text arrived (output appeared) while an idle status stayed untouched.
 * With `noEnter` nothing is submitted, so the outcome mirrors `delivery`.
 */
export const SESSION_SEND_OUTCOME = {
  SUBMITTED: "submitted",
  PASTED_NOT_SUBMITTED: "pasted_not_submitted",
  DELIVERED: "delivered",
  NOT_DELIVERED: "not_delivered",
  UNVERIFIED: "unverified",
} as const;

export type SessionSendOutcome = (typeof SESSION_SEND_OUTCOME)[keyof typeof SESSION_SEND_OUTCOME];

/** Why nothing was written; spelled like the matching prompt outcomes. */
export const SESSION_SEND_FAILURE_REASON = {
  TARGET_UNAVAILABLE: SESSION_PROMPT_OUTCOME.TARGET_UNAVAILABLE,
  TARGET_REPLACED: SESSION_PROMPT_OUTCOME.TARGET_REPLACED,
  TARGET_EXITED: SESSION_PROMPT_OUTCOME.TARGET_EXITED,
  REPLAY_GAP: SESSION_PROMPT_OUTCOME.REPLAY_GAP,
  BACKEND_UNAVAILABLE: SESSION_PROMPT_OUTCOME.BACKEND_UNAVAILABLE,
} as const;

export type SessionSendFailureReason =
  (typeof SESSION_SEND_FAILURE_REASON)[keyof typeof SESSION_SEND_FAILURE_REASON];

export interface SessionSendObservationOptions {
  readonly text: string;
  readonly noEnter: boolean;
  /** Bounds each observed write, subscribe included. */
  readonly observeMs: number;
  /** Re-send one `\r` when the first write reads as `pasted_not_submitted`. */
  readonly ensureSubmitted: boolean;
  readonly sessionName?: string;
}

export interface SessionSendObservationResult {
  readonly delivery: SessionSendDelivery;
  readonly outcome: SessionSendOutcome;
  /** Milliseconds observed after the write(s); 0 when nothing was written. */
  readonly observedMs: number;
  readonly retried?: true;
  /** Present exactly when `delivery` is `not_delivered`. */
  readonly reason?: SessionSendFailureReason;
}

/** `ok` for a send response: the caller's intent was met or cannot be disproven. */
export function sessionSendOk(noEnter: boolean, outcome: SessionSendOutcome): boolean {
  if (outcome === SESSION_SEND_OUTCOME.UNVERIFIED) return true;
  return noEnter
    ? outcome === SESSION_SEND_OUTCOME.DELIVERED
    : outcome === SESSION_SEND_OUTCOME.SUBMITTED;
}
