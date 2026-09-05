import { describe, expect, test } from "bun:test";
import { formatSessionActivityDisplay, reduceActivityObservation } from "../../src/session-activity";

describe("session activity observation", () => {
  test("formats bounded activity ages from explicit observation times", () => {
    expect(formatSessionActivityDisplay("2026-01-01T00:02:00.000Z", "2026-01-01T00:00:00.000Z", "active")).toBe("active 2m");
    expect(formatSessionActivityDisplay("2026-01-01T00:00:00.000Z", "not-a-timestamp", "quiet")).toBe("activity unobserved");
  });

  test("starts quiet continuity at the first successful rendered observation", () => {
    const baseline = reduceActivityObservation(undefined, {
      alive: true,
      observedAt: "2026-01-01T00:00:01.000Z",
      rendered: "baseline",
    });
    const quiet = reduceActivityObservation(baseline.history, {
      alive: true,
      observedAt: "2026-01-01T00:00:02.000Z",
      rendered: "baseline",
    });
    const changed = reduceActivityObservation(quiet.history, {
      alive: true,
      observedAt: "2026-01-01T00:00:03.000Z",
      rendered: "changed",
    });
    const quietAgain = reduceActivityObservation(changed.history, {
      alive: true,
      observedAt: "2026-01-01T00:05:03.000Z",
      rendered: "changed",
    });

    expect(baseline.activity.display).toBe("activity unobserved");
    expect(quiet.activity).toMatchObject({ quietSince: "2026-01-01T00:00:01.000Z", display: "quiet now" });
    expect(changed.activity).toMatchObject({
      lastRenderedActivityAt: "2026-01-01T00:00:03.000Z",
      display: "active now",
    });
    expect(quietAgain.activity).toMatchObject({
      quietSince: "2026-01-01T00:00:03.000Z",
      display: "quiet 5m",
    });

    const unavailable = reduceActivityObservation(quietAgain.history, {
      alive: false,
      observedAt: "2026-01-01T00:02:04.000Z",
    });
    expect(unavailable.activity.display).toBe("activity unavailable");
  });
});
