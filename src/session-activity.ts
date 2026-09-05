// "activity unavailable" and the largest valid minute display are both 20 characters.
export const SESSION_ACTIVITY_DISPLAY_MAX_LENGTH = 20;

export interface SessionActivityObservation {
  readonly freshness: "fresh" | "unknown";
  readonly observedAt: string;
  readonly display: string;
  readonly lastRenderedActivityAt?: string;
  readonly quietSince?: string;
}

export interface SessionActivityHistory {
  readonly rendered: string;
  readonly continuitySince: string;
  readonly lastRenderedActivityAt?: string;
}

export interface SessionActivityObservationInput {
  readonly alive: boolean;
  readonly observedAt: string;
  readonly rendered?: string;
}

export interface SessionActivityReduction {
  readonly history: SessionActivityHistory | undefined;
  readonly activity: SessionActivityObservation;
}

export function formatSessionActivityDisplay(
  observedAt: string,
  activityAt: string | undefined,
  state: "active" | "quiet",
): string {
  if (activityAt === undefined) return "activity unobserved";
  const ageMs = Date.parse(observedAt) - Date.parse(activityAt);
  if (!Number.isFinite(ageMs)) return "activity unobserved";
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  return minutes ? `${state} ${minutes}m` : "";
}

export function reduceActivityObservation(
  previous: SessionActivityHistory | undefined,
  input: SessionActivityObservationInput,
): SessionActivityReduction {
  if (!input.alive || input.rendered === undefined) {
    return {
      history: undefined,
      activity: { freshness: "unknown", observedAt: input.observedAt, display: "activity unavailable" },
    };
  }
  if (previous === undefined) {
    return {
      history: { rendered: input.rendered, continuitySince: input.observedAt },
      activity: { freshness: "fresh", observedAt: input.observedAt, display: "activity unobserved" },
    };
  }
  if (previous.rendered !== input.rendered) {
    return {
      history: {
        rendered: input.rendered,
        continuitySince: input.observedAt,
        lastRenderedActivityAt: input.observedAt,
      },
      activity: {
        freshness: "fresh",
        observedAt: input.observedAt,
        display: formatSessionActivityDisplay(input.observedAt, input.observedAt, "active"),
        lastRenderedActivityAt: input.observedAt,
      },
    };
  }
  const quietSince = previous.continuitySince;
  return {
    history: {
      rendered: input.rendered,
      continuitySince: quietSince,
      ...(previous.lastRenderedActivityAt && { lastRenderedActivityAt: previous.lastRenderedActivityAt }),
    },
    activity: {
      freshness: "fresh",
      observedAt: input.observedAt,
      display: formatSessionActivityDisplay(input.observedAt, quietSince, "quiet"),
      ...(previous.lastRenderedActivityAt && { lastRenderedActivityAt: previous.lastRenderedActivityAt }),
      quietSince,
    },
  };
}
