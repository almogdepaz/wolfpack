import type { ProgramStatusRecord } from "./program-status-contract.js";
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
 * OSC 7501 root status was seen `idle` and then moved to another state the
 * broker stamped after the write, within the observation window;
 * `pasted_not_submitted` means the text arrived (output appeared) while an idle
 * status stayed untouched.
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
  /** The observation window ran out before the write could start. */
  TIMED_OUT: SESSION_PROMPT_OUTCOME.TIMED_OUT,
} as const;

export type SessionSendFailureReason =
  (typeof SESSION_SEND_FAILURE_REASON)[keyof typeof SESSION_SEND_FAILURE_REASON];

/**
 * Decides, right before one write, whether that write may happen. It gets the
 * session's root program status, read fresh after earlier writes to the session
 * finished, or undefined when the read failed.
 */
export type SessionSendWriteGuard = (rootStatus: ProgramStatusRecord | undefined) => boolean;

export interface SessionSendObservationOptions {
  readonly text: string;
  readonly noEnter: boolean;
  /** Bounds each observed write: status reads, subscribe and write included. */
  readonly observeMs: number;
  /** Re-send one `\r` when the first write reads as `pasted_not_submitted`. */
  readonly ensureSubmitted: boolean;
  readonly sessionName?: string;
  /**
   * Runs once a text and its Enter are written, before the observation
   * returns. Not called for `noEnter` or a write that failed.
   */
  readonly onSubmitWritten?: () => void;
  /**
   * Automated senders only (typed child-event notes). Checked before each write:
   * the text, its separate Enter and the `ensureSubmitted` retry Enter. A false
   * result writes nothing more and sets `writeRefused` on the result.
   */
  readonly writeGuard?: SessionSendWriteGuard;
}

export interface SessionSendObservationResult {
  readonly delivery: SessionSendDelivery;
  readonly outcome: SessionSendOutcome;
  /** Milliseconds observed after the write(s); 0 when nothing was written. */
  readonly observedMs: number;
  /** The `ensureSubmitted` retry actually wrote its `\r`. */
  readonly retried?: true;
  /** Present exactly when `delivery` is `not_delivered`. */
  readonly reason?: SessionSendFailureReason;
  /**
   * The `writeGuard` refused a write; nothing was written after that. With
   * `not_delivered` nothing was written at all (`reason` is `target_unavailable`).
   */
  readonly writeRefused?: true;
}

/** `ok` for a send response: the caller's intent was met or cannot be disproven. */
export function sessionSendOk(noEnter: boolean, outcome: SessionSendOutcome): boolean {
  if (outcome === SESSION_SEND_OUTCOME.UNVERIFIED) return true;
  return noEnter
    ? outcome === SESSION_SEND_OUTCOME.DELIVERED
    : outcome === SESSION_SEND_OUTCOME.SUBMITTED;
}
