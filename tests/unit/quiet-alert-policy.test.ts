import { describe, expect, test } from "bun:test";
import {
  DEFAULT_QUIET_ALERT_POLICY,
  QUIET_ALERT_MODE,
  reduceQuietAlertPolicy,
} from "../../src/quiet-alert-policy.ts";

const SESSION_ID = "7fda2c35-2dc7-4f2a-a933-117d02c50fd0";
const ACTIVITY_AT_MS = Date.parse("2026-09-07T12:00:00.000Z");

function observation(overrides: Partial<Parameters<typeof reduceQuietAlertPolicy>[1]> = {}) {
  return {
    sessionId: SESSION_ID,
    observedAtMs: ACTIVITY_AT_MS,
    continuity: "fresh" as const,
    renderedActivityAt: ACTIVITY_AT_MS,
    episodeId: "episode-one",
    policy: undefined,
    ...overrides,
  };
}

describe("quiet alert policy", () => {
  test("defaults to a 30-second host-wide rendered-activity policy", () => {
    expect(DEFAULT_QUIET_ALERT_POLICY).toEqual({
      mode: QUIET_ALERT_MODE.QUIET_AFTER_ACTIVITY,
      quietAfterSeconds: 30,
    });
  });

  test("requires a rendered activity episode and continuous quiet at the exact threshold", () => {
    const active = reduceQuietAlertPolicy(undefined, observation());
    const belowThreshold = reduceQuietAlertPolicy(active.state, observation({
      observedAtMs: ACTIVITY_AT_MS + 29_999,
      renderedActivityAt: undefined,
      episodeId: undefined,
    }));
    const atThreshold = reduceQuietAlertPolicy(belowThreshold.state, observation({
      observedAtMs: ACTIVITY_AT_MS + 30_000,
      renderedActivityAt: undefined,
      episodeId: undefined,
    }));

    expect(active.event).toBeUndefined();
    expect(belowThreshold.event).toBeUndefined();
    expect(atThreshold.event).toEqual({ kind: "quiet", episodeId: "episode-one" });
    expect(atThreshold.fact).toEqual({
      kind: "quiet",
      sessionId: SESSION_ID,
      episodeId: "episode-one",
      eligibleAtMs: ACTIVITY_AT_MS + 30_000,
      observedAtMs: ACTIVITY_AT_MS + 30_000,
    });
  });

  test("does not treat initial idle, a stable redraw, or a continuity loss as a quiet episode", () => {
    const initialIdle = reduceQuietAlertPolicy(undefined, observation({
      renderedActivityAt: undefined,
      episodeId: undefined,
    }));
    const stable = reduceQuietAlertPolicy(initialIdle.state, observation({
      observedAtMs: ACTIVITY_AT_MS + 60_000,
      renderedActivityAt: undefined,
      episodeId: undefined,
    }));
    const continuityLost = reduceQuietAlertPolicy(stable.state, observation({
      observedAtMs: ACTIVITY_AT_MS + 120_000,
      continuity: "lost",
      renderedActivityAt: undefined,
      episodeId: undefined,
    }));
    const recovered = reduceQuietAlertPolicy(continuityLost.state, observation({
      observedAtMs: ACTIVITY_AT_MS + 180_000,
      renderedActivityAt: undefined,
      episodeId: undefined,
    }));

    expect(initialIdle.event).toBeUndefined();
    expect(stable.event).toBeUndefined();
    expect(continuityLost.state).toBeUndefined();
    expect(recovered.event).toBeUndefined();
  });

  test("reevaluates a pending episode when the configured duration changes", () => {
    const shortenedStart = reduceQuietAlertPolicy(undefined, observation({
      policy: { mode: QUIET_ALERT_MODE.QUIET_AFTER_ACTIVITY, quietAfterSeconds: 60 },
    }));
    const shortened = reduceQuietAlertPolicy(shortenedStart.state, observation({
      observedAtMs: ACTIVITY_AT_MS + 5_000,
      renderedActivityAt: undefined,
      episodeId: undefined,
      policy: { mode: QUIET_ALERT_MODE.QUIET_AFTER_ACTIVITY, quietAfterSeconds: 5 },
    }));
    const lengthenedStart = reduceQuietAlertPolicy(undefined, observation({
      policy: { mode: QUIET_ALERT_MODE.QUIET_AFTER_ACTIVITY, quietAfterSeconds: 5 },
    }));
    const lengthened = reduceQuietAlertPolicy(lengthenedStart.state, observation({
      observedAtMs: ACTIVITY_AT_MS + 5_000,
      renderedActivityAt: undefined,
      episodeId: undefined,
      policy: { mode: QUIET_ALERT_MODE.QUIET_AFTER_ACTIVITY, quietAfterSeconds: 60 },
    }));

    expect(shortened.event).toEqual({ kind: "quiet", episodeId: "episode-one" });
    expect(shortened.fact).toMatchObject({ eligibleAtMs: ACTIVITY_AT_MS + 5_000 });
    expect(lengthened.event).toBeUndefined();
    expect(lengthened.state).toMatchObject({ eligibleAtMs: ACTIVITY_AT_MS + 60_000 });
  });

  test("emits once per activity episode, rearms after new rendered activity, and never replays a disabled episode", () => {
    const firstActivity = reduceQuietAlertPolicy(undefined, observation());
    const firstQuiet = reduceQuietAlertPolicy(firstActivity.state, observation({
      observedAtMs: ACTIVITY_AT_MS + 30_000,
      renderedActivityAt: undefined,
      episodeId: undefined,
    }));
    const repeatedQuiet = reduceQuietAlertPolicy(firstQuiet.state, observation({
      observedAtMs: ACTIVITY_AT_MS + 60_000,
      renderedActivityAt: undefined,
      episodeId: undefined,
    }));
    const secondActivity = reduceQuietAlertPolicy(repeatedQuiet.state, observation({
      observedAtMs: ACTIVITY_AT_MS + 61_000,
      renderedActivityAt: ACTIVITY_AT_MS + 61_000,
      episodeId: "episode-two",
    }));
    const disabled = reduceQuietAlertPolicy(secondActivity.state, observation({
      observedAtMs: ACTIVITY_AT_MS + 91_000,
      renderedActivityAt: undefined,
      episodeId: undefined,
      policy: { mode: QUIET_ALERT_MODE.DISABLED, quietAfterSeconds: 30 },
    }));
    const reenabled = reduceQuietAlertPolicy(disabled.state, observation({
      observedAtMs: ACTIVITY_AT_MS + 121_000,
      renderedActivityAt: undefined,
      episodeId: undefined,
    }));

    expect(firstQuiet.event).toEqual({ kind: "quiet", episodeId: "episode-one" });
    expect(repeatedQuiet.event).toBeUndefined();
    expect(disabled.state).toBeUndefined();
    expect(reenabled.event).toBeUndefined();
  });
});
