import { describe, expect, test } from "bun:test";
import { createHydrationWriteTracker } from "../../src/hydration-write-tracker.ts";

describe("hydration write tracker", () => {
  test("counts only writes from the active connection epoch", () => {
    const tracker = createHydrationWriteTracker();
    const first = tracker.beginWrite();
    const second = tracker.beginWrite();

    expect(tracker.pending).toBe(2);
    expect(tracker.finishWrite(first)).toBe(true);
    expect(tracker.pending).toBe(1);
    expect(tracker.finishWrite(second)).toBe(true);
    expect(tracker.pending).toBe(0);
  });

  test("invalidates old write callbacks after reconnect or dispose", () => {
    const tracker = createHydrationWriteTracker();
    const staleWrite = tracker.beginWrite();

    tracker.advanceEpoch();
    expect(tracker.pending).toBe(0);
    expect(tracker.finishWrite(staleWrite)).toBe(false);
    expect(tracker.pending).toBe(0);
  });
});
