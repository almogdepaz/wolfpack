import { describe, expect, test } from "bun:test";
import {
  TAILNET_DISCOVERY_REFRESH_INTERVAL_MS,
  createTailnetDiscoveryAutoRefresh,
} from "../../src/tailnet-discovery-auto-refresh.ts";

describe("tailnet discovery auto-refresh", () => {
  test("only starts the cadence while visible and refreshes immediately on visible sync", () => {
    let visible = false;
    let refreshes = 0;
    const intervals: Array<{ readonly ms: number; readonly callback: () => void }> = [];
    const cleared: unknown[] = [];
    const autoRefresh = createTailnetDiscoveryAutoRefresh({
      refresh: () => { refreshes++; return Promise.resolve(); },
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

    autoRefresh.sync(false);

    expect(cleared).toHaveLength(1);
    expect(intervals).toHaveLength(2);
    expect(refreshes).toBe(1);
  });

  test("coalesces refresh requests while one discovery pass is running", async () => {
    let release: (() => void) | undefined;
    let refreshes = 0;
    const autoRefresh = createTailnetDiscoveryAutoRefresh({
      refresh: () => {
        refreshes++;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      isVisible: () => true,
      setInterval: () => 1,
      clearInterval: () => undefined,
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
