export const TAILNET_DISCOVERY_REFRESH_INTERVAL_MS = 60_000;

export type TailnetDiscoveryRefresh = () => Promise<void>;
export type TailnetDiscoverySetInterval = (callback: () => void, ms: number) => unknown;
export type TailnetDiscoveryClearInterval = (handle: unknown) => void;

export interface TailnetDiscoveryAutoRefreshOptions {
  readonly refresh: TailnetDiscoveryRefresh;
  readonly isVisible: () => boolean;
  readonly setInterval?: TailnetDiscoverySetInterval;
  readonly clearInterval?: TailnetDiscoveryClearInterval;
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface TailnetDiscoveryAutoRefresh {
  readonly sync: (refreshNow?: boolean) => void;
  readonly requestRefresh: () => Promise<void>;
  readonly stop: () => void;
}

export function createTailnetDiscoveryAutoRefresh(
  options: TailnetDiscoveryAutoRefreshOptions,
): TailnetDiscoveryAutoRefresh {
  const setIntervalFn = options.setInterval ?? ((callback, ms) => window.setInterval(callback, ms));
  const clearIntervalFn = options.clearInterval ?? ((handle) => window.clearInterval(handle as number));
  const intervalMs = options.intervalMs ?? TAILNET_DISCOVERY_REFRESH_INTERVAL_MS;
  let timer: unknown;
  let inFlight: Promise<void> | undefined;
  let refreshAfterCurrent = false;

  const requestRefresh = (): Promise<void> => {
    if (!options.isVisible()) return Promise.resolve();
    if (inFlight) {
      refreshAfterCurrent = true;
      return inFlight;
    }
    inFlight = (async () => {
      do {
        refreshAfterCurrent = false;
        await options.refresh();
      } while (refreshAfterCurrent && options.isVisible());
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const stop = (): void => {
    if (timer === undefined) return;
    clearIntervalFn(timer);
    timer = undefined;
  };

  return {
    sync(refreshNow = false): void {
      stop();
      if (!options.isVisible()) return;
      if (refreshNow) void requestRefresh().catch(options.onError);
      timer = setIntervalFn(() => { void requestRefresh().catch(options.onError); }, intervalMs);
    },
    requestRefresh,
    stop,
  };
}
