import { describe, expect, test } from "bun:test";
import {
  DEFAULT_QUIET_ALERT_POLICY,
  isQuietAlertFact,
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

describe("quiet alert kinds and suppression", () => {
  const quietAt = (state: Parameters<typeof reduceQuietAlertPolicy>[0], offsetMs: number, overrides: Partial<Parameters<typeof reduceQuietAlertPolicy>[1]> = {}) =>
    reduceQuietAlertPolicy(state, observation({
      observedAtMs: ACTIVITY_AT_MS + offsetMs,
      renderedActivityAt: undefined,
      episodeId: undefined,
      ...overrides,
    }));

  test("emits a needs-input alert once per episode and keeps its kind while the episode lasts", () => {
    const active = reduceQuietAlertPolicy(undefined, observation());
    const needsInput = quietAt(active.state, 30_000, { alert: { kind: "needs-input", inputKind: "permission" } });
    const repeated = quietAt(needsInput.state, 60_000);

    expect(needsInput.event).toEqual({ kind: "needs-input", episodeId: "episode-one", inputKind: "permission" });
    expect(needsInput.fact).toEqual({
      kind: "needs-input",
      inputKind: "permission",
      sessionId: SESSION_ID,
      episodeId: "episode-one",
      eligibleAtMs: ACTIVITY_AT_MS + 30_000,
      observedAtMs: ACTIVITY_AT_MS + 30_000,
    });
    expect(isQuietAlertFact(needsInput.fact)).toBe(true);
    expect(repeated.event).toBeUndefined();
    expect(repeated.fact).toEqual({ ...needsInput.fact!, observedAtMs: ACTIVITY_AT_MS + 60_000 });
  });

  test("a suppressed eligible episode stays open and fires once suppression lifts", () => {
    const active = reduceQuietAlertPolicy(undefined, observation());
    const suppressed = quietAt(active.state, 30_000, { suppressed: true });
    const stillSuppressed = quietAt(suppressed.state, 45_000, { suppressed: true });
    const released = quietAt(stillSuppressed.state, 50_000);

    expect(suppressed.event).toBeUndefined();
    expect(suppressed.fact).toBeUndefined();
    expect(suppressed.state).toMatchObject({ episodeId: "episode-one", emitted: false });
    expect(stillSuppressed.event).toBeUndefined();
    expect(released.event).toEqual({ kind: "quiet", episodeId: "episode-one" });
    expect(released.fact?.observedAtMs).toBe(ACTIVITY_AT_MS + 50_000);
  });

  test("needs-input wins over suppression", () => {
    const active = reduceQuietAlertPolicy(undefined, observation());
    const needsInput = quietAt(active.state, 30_000, { suppressed: true, alert: { kind: "needs-input", inputKind: undefined } });

    expect(needsInput.event).toEqual({ kind: "needs-input", episodeId: "episode-one" });
    expect(needsInput.fact?.kind).toBe("needs-input");
    expect(needsInput.fact).not.toHaveProperty("inputKind");
  });

  test("validates alert facts by kind", () => {
    const base = {
      sessionId: SESSION_ID,
      episodeId: "episode-one",
      eligibleAtMs: ACTIVITY_AT_MS,
      observedAtMs: ACTIVITY_AT_MS,
    };
    expect(isQuietAlertFact({ ...base, kind: "quiet" })).toBe(true);
    expect(isQuietAlertFact({ ...base, kind: "needs-input" })).toBe(true);
    expect(isQuietAlertFact({ ...base, kind: "needs-input", inputKind: "question" })).toBe(true);
    expect(isQuietAlertFact({ ...base, kind: "needs-input", inputKind: "coffee" })).toBe(false);
    expect(isQuietAlertFact({ ...base, kind: "quiet", inputKind: "question" })).toBe(false);
    expect(isQuietAlertFact({ ...base, kind: "waiting-on-child" })).toBe(false);
    expect(isQuietAlertFact({ ...base, kind: "needs-input", extra: true })).toBe(false);
  });
});
