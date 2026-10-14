import { PROGRAM_STATUS_KINDS } from "./program-status-contract.js";
import type { ProgramStatusKind } from "./program-status-contract.js";

export const QUIET_ALERT_MODE = {
  QUIET_AFTER_ACTIVITY: "quiet-after-activity",
  DISABLED: "disabled",
} as const;

export type QuietAlertMode = (typeof QUIET_ALERT_MODE)[keyof typeof QUIET_ALERT_MODE];

export const QUIET_ALERT_MIN_SECONDS = 5;
export const QUIET_ALERT_MAX_SECONDS = 3_600;

export interface QuietAlertPolicy {
  readonly mode: QuietAlertMode;
  readonly quietAfterSeconds: number;
}

export const DEFAULT_QUIET_ALERT_POLICY: QuietAlertPolicy = {
  mode: QUIET_ALERT_MODE.QUIET_AFTER_ACTIVITY,
  quietAfterSeconds: 30,
};

/**
 * `quiet`: rendered output went quiet. `needs-input`: it went quiet while the
 * program's own status said it waits on the user. Servers that predate
 * `needs-input` reject it as an unknown fact, so their relays drop it.
 */
export const QUIET_ALERT_KIND = {
  QUIET: "quiet",
  NEEDS_INPUT: "needs-input",
} as const;

export type QuietAlertKind = (typeof QUIET_ALERT_KIND)[keyof typeof QUIET_ALERT_KIND];

/** What an episode alerts as; `inputKind` only accompanies `needs-input`. */
export type QuietAlertKindFields =
  | { readonly kind: typeof QUIET_ALERT_KIND.QUIET }
  | { readonly kind: typeof QUIET_ALERT_KIND.NEEDS_INPUT; readonly inputKind?: ProgramStatusKind };

export type QuietAlertEvent = QuietAlertKindFields & {
  readonly episodeId: string;
};

export type QuietAlertFact = QuietAlertEvent & {
  readonly sessionId: string;
  readonly eligibleAtMs: number;
  readonly observedAtMs: number;
};

export const QUIET_SUPPRESSION_REASON = {
  WAITING_ON_CHILD: "waiting-on-child",
} as const;

/** Why a due quiet alert is withheld; recomputed every observation, never alerted. */
export interface QuietSuppression {
  readonly reason: typeof QUIET_SUPPRESSION_REASON.WAITING_ON_CHILD;
  /** The nearest busy descendant. */
  readonly sessionId: string;
  readonly session: string;
}

export interface QuietAlertPolicyState {
  readonly episodeId: string;
  readonly renderedActivityAtMs: number;
  readonly eligibleAtMs: number;
  readonly emitted: boolean;
  /** Fixed when the episode emits, so later observations repeat the same alert. */
  readonly alert?: QuietAlertKindFields;
}

export interface QuietAlertPolicyObservation {
  readonly sessionId: string;
  readonly observedAtMs: number;
  readonly continuity: "fresh" | "lost";
  readonly renderedActivityAt: number | undefined;
  readonly episodeId: string | undefined;
  readonly policy: QuietAlertPolicy | undefined;
  /** How an episode that becomes due now would alert; defaults to `quiet`. */
  readonly alert?: QuietAlertKindFields;
  /** Withhold a due `quiet` alert and keep the episode open; `needs-input` is never withheld. */
  readonly suppressed?: boolean;
}

export interface QuietAlertPolicyReduction {
  readonly state: QuietAlertPolicyState | undefined;
  readonly event: QuietAlertEvent | undefined;
  readonly fact: QuietAlertFact | undefined;
}

const OPAQUE_ID_MAX_LENGTH = 128;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f-\x9f]/;

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= OPAQUE_ID_MAX_LENGTH
    && !CONTROL_CHARACTER_PATTERN.test(value);
}

function validObservedAt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isQuietAlertPolicy(value: unknown): value is QuietAlertPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 2
    && (candidate.mode === QUIET_ALERT_MODE.QUIET_AFTER_ACTIVITY || candidate.mode === QUIET_ALERT_MODE.DISABLED)
    && Number.isInteger(candidate.quietAfterSeconds)
    && (candidate.quietAfterSeconds as number) >= QUIET_ALERT_MIN_SECONDS
    && (candidate.quietAfterSeconds as number) <= QUIET_ALERT_MAX_SECONDS;
}

const PROGRAM_STATUS_KIND_SET: ReadonlySet<unknown> = new Set(PROGRAM_STATUS_KINDS);

function validAlertKind(candidate: Record<string, unknown>): boolean {
  if (candidate.kind === QUIET_ALERT_KIND.QUIET) return Object.keys(candidate).length === 5;
  if (candidate.kind !== QUIET_ALERT_KIND.NEEDS_INPUT) return false;
  if (candidate.inputKind === undefined) return Object.keys(candidate).length === 5;
  return Object.keys(candidate).length === 6 && PROGRAM_STATUS_KIND_SET.has(candidate.inputKind);
}

export function isQuietAlertFact(value: unknown): value is QuietAlertFact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return validAlertKind(candidate)
    && isOpaqueId(candidate.sessionId)
    && isOpaqueId(candidate.episodeId)
    && validObservedAt(candidate.eligibleAtMs as number)
    && validObservedAt(candidate.observedAtMs as number)
    && (candidate.eligibleAtMs as number) <= (candidate.observedAtMs as number);
}

/** Drops an absent `inputKind` key so the emitted fact keeps its exact key count. */
function alertKindFields(alert: QuietAlertKindFields | undefined): QuietAlertKindFields {
  if (alert?.kind !== QUIET_ALERT_KIND.NEEDS_INPUT) return { kind: QUIET_ALERT_KIND.QUIET };
  return {
    kind: QUIET_ALERT_KIND.NEEDS_INPUT,
    ...(alert.inputKind !== undefined && { inputKind: alert.inputKind }),
  };
}

function factFor(
  sessionId: string,
  state: QuietAlertPolicyState,
  observedAtMs: number,
): QuietAlertFact | undefined {
  if (!isOpaqueId(sessionId) || !validObservedAt(observedAtMs)) return undefined;
  return {
    ...(state.alert ?? { kind: QUIET_ALERT_KIND.QUIET }),
    sessionId,
    episodeId: state.episodeId,
    eligibleAtMs: state.eligibleAtMs,
    observedAtMs,
  };
}

/**
 * Reduces rendered-activity observations into a single quiet episode. Episode
 * ids are opaque, observation-owned values so continuity resets cannot collide
 * with a browser's previously seen delivery identity.
 */
export function reduceQuietAlertPolicy(
  previous: QuietAlertPolicyState | undefined,
  observation: QuietAlertPolicyObservation,
): QuietAlertPolicyReduction {
  const policy = observation.policy ?? DEFAULT_QUIET_ALERT_POLICY;
  if (!isQuietAlertPolicy(policy) || observation.continuity !== "fresh" || !validObservedAt(observation.observedAtMs)) {
    return { state: undefined, event: undefined, fact: undefined };
  }
  if (policy.mode === QUIET_ALERT_MODE.DISABLED) {
    return { state: undefined, event: undefined, fact: undefined };
  }

  if (observation.renderedActivityAt !== undefined) {
    if (!validObservedAt(observation.renderedActivityAt) || !isOpaqueId(observation.episodeId)) {
      return { state: undefined, event: undefined, fact: undefined };
    }
    const state = {
      episodeId: observation.episodeId,
      renderedActivityAtMs: observation.renderedActivityAt,
      eligibleAtMs: observation.renderedActivityAt + policy.quietAfterSeconds * 1_000,
      emitted: false,
    } as const;
    return { state, event: undefined, fact: undefined };
  }

  if (!previous) return { state: undefined, event: undefined, fact: undefined };
  if (previous.emitted) {
    return { state: previous, event: undefined, fact: factFor(observation.sessionId, previous, observation.observedAtMs) };
  }

  const state = {
    ...previous,
    eligibleAtMs: previous.renderedActivityAtMs + policy.quietAfterSeconds * 1_000,
  } as const;
  const alert = alertKindFields(observation.alert);
  if (
    observation.observedAtMs < state.eligibleAtMs
    || (observation.suppressed === true && alert.kind === QUIET_ALERT_KIND.QUIET)
  ) {
    return { state, event: undefined, fact: undefined };
  }

  const emitted = { ...state, emitted: true, alert } as const;
  return {
    state: emitted,
    event: { ...alert, episodeId: emitted.episodeId },
    fact: factFor(observation.sessionId, emitted, observation.observedAtMs),
  };
}
