import { describe, expect, test } from "bun:test";
import { createAttachDimensionRetryState } from "../../src/attach-dimension-retry.ts";

describe("attach dimension retry lifecycle", () => {
  test("clear cancels a pending retry and resets attempts", () => {
    const pendingTimers = new Map<number, () => void>();
    const clearedTimers = new Set<number>();
    let nextTimer = 1;
    let fired = 0;
    const retry = createAttachDimensionRetryState<number>({
      setTimeout: (callback) => {
        const id = nextTimer++;
        pendingTimers.set(id, callback);
        return id;
      },
      clearTimeout: (id) => {
        clearedTimers.add(id);
      },
    });

    retry.setAttempt(7);
    retry.schedule(() => { fired++; }, 50);
    expect(retry.hasPendingTimer).toBe(true);

    retry.clear();
    expect(retry.attempt).toBe(0);
    expect(retry.hasPendingTimer).toBe(false);

    for (const [id, callback] of pendingTimers) {
      if (!clearedTimers.has(id)) callback();
    }
    expect(fired).toBe(0);
  });

  test("marks retry timer idle before invoking the retry callback", () => {
    const scheduledCallbacks: Array<() => void> = [];
    const retry = createAttachDimensionRetryState<number>({
      setTimeout: (scheduled) => {
        scheduledCallbacks.push(scheduled);
        return 1;
      },
      clearTimeout: () => {},
    });

    retry.schedule(() => {
      expect(retry.hasPendingTimer).toBe(false);
    }, 50);

    expect(retry.hasPendingTimer).toBe(true);
    const scheduledCallback = scheduledCallbacks[0];
    if (!scheduledCallback) throw new Error("retry callback was not scheduled");
    scheduledCallback();
    expect(retry.hasPendingTimer).toBe(false);
  });
});
