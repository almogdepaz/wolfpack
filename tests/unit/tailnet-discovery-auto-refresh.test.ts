import { describe, expect, test } from "bun:test";
import {
  TAILNET_DISCOVERY_REFRESH_INTERVAL_MS,
  createTailnetDiscoveryAutoRefresh,
} from "../../src/tailnet-discovery-auto-refresh.ts";

function createVisibleAutoRefresh(
  refresh: () => Promise<void>,
): ReturnType<typeof createTailnetDiscoveryAutoRefresh> {
  return createTailnetDiscoveryAutoRefresh({
    refresh,
    isVisible: () => true,
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
}

describe("tailnet discovery auto-refresh", () => {
  test("refreshes on the visible cadence and isolates scheduled failures", async () => {
    const refreshError = new Error("candidate enumeration unavailable");
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => { unhandledRejections.push(reason); };
    let visible = false;
    let refreshes = 0;
    const intervals: Array<{ readonly ms: number; readonly callback: () => void }> = [];
    const cleared: unknown[] = [];
    const autoRefresh = createTailnetDiscoveryAutoRefresh({
      refresh: () => {
        refreshes++;
        return refreshes === 2 ? Promise.reject(refreshError) : Promise.resolve();
      },
      isVisible: () => visible,
      setInterval: (callback, ms) => {
        const handle = { callback, ms };
        intervals.push(handle);
        return handle;
      },
      clearInterval: (handle) => { cleared.push(handle); },
    });

    autoRefresh.sync(true);

    expect(refreshes).toBe(0);
    expect(intervals).toEqual([]);

    visible = true;
    autoRefresh.sync(true);

    expect(refreshes).toBe(1);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.ms).toBe(TAILNET_DISCOVERY_REFRESH_INTERVAL_MS);

    await new Promise<void>((resolve) => setImmediate(resolve));
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      intervals[0]?.callback();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(refreshes).toBe(2);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    autoRefresh.sync(false);

    expect(cleared).toHaveLength(1);
    expect(intervals).toHaveLength(2);
  });

  test("settles queued recovery and rejects final refresh failures", async () => {
    const recoveryError = new Error("temporary Tailnet failure");
    let refreshes = 0;
    const recoveringAutoRefresh = createVisibleAutoRefresh(() => {
      refreshes++;
      return refreshes === 1 ? Promise.reject(recoveryError) : Promise.resolve();
    });

    const first = recoveringAutoRefresh.requestRefresh();
    const queued = recoveringAutoRefresh.requestRefresh();

    await expect(first).resolves.toBeUndefined();
    await expect(queued).resolves.toBeUndefined();
    expect(refreshes).toBe(2);

    const finalError = new Error("candidate enumeration unavailable");
    const failingAutoRefresh = createVisibleAutoRefresh(() => Promise.reject(finalError));
    await expect(failingAutoRefresh.requestRefresh()).rejects.toThrow(finalError.message);
  });

  test("coalesces refresh requests while one discovery pass is running", async () => {
    let release: (() => void) | undefined;
    let refreshes = 0;
    const autoRefresh = createVisibleAutoRefresh(() => {
      refreshes++;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const first = autoRefresh.requestRefresh();
    void autoRefresh.requestRefresh();
    void autoRefresh.requestRefresh();

    expect(refreshes).toBe(1);

    release?.();
    await Promise.resolve();

    expect(refreshes).toBe(2);

    release?.();
    await first;
    expect(refreshes).toBe(2);
  });
});
