export const TAILNET_DISCOVERY_REFRESH_INTERVAL_MS = 60_000;

type TailnetDiscoveryRefresh = () => Promise<void>;
type TailnetDiscoverySetInterval = (callback: () => void, ms: number) => unknown;
type TailnetDiscoveryClearInterval = (handle: unknown) => void;

interface TailnetDiscoveryAutoRefreshOptions {
  readonly refresh: TailnetDiscoveryRefresh;
  readonly isVisible: () => boolean;
  readonly setInterval?: TailnetDiscoverySetInterval;
  readonly clearInterval?: TailnetDiscoveryClearInterval;
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

interface TailnetDiscoveryAutoRefresh {
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

  const drainRefreshRequests = async (): Promise<void> => {
    let lastRefreshError: unknown;
    let lastRefreshFailed = false;
    do {
      refreshAfterCurrent = false;
      try {
        await options.refresh();
        lastRefreshFailed = false;
      } catch (error: unknown) {
        lastRefreshError = error;
        lastRefreshFailed = true;
      }
    } while (refreshAfterCurrent && options.isVisible());
    if (lastRefreshFailed) throw lastRefreshError;
  };

  const requestRefresh = (): Promise<void> => {
    if (!options.isVisible()) return Promise.resolve();
    if (inFlight) {
      refreshAfterCurrent = true;
      return inFlight;
    }
    inFlight = drainRefreshRequests().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const stop = (): void => {
    if (timer === undefined) return;
    clearIntervalFn(timer);
    timer = undefined;
  };

  const handleBackgroundError = options.onError ?? (() => undefined);
  const requestBackgroundRefresh = (): void => {
    void requestRefresh().catch(handleBackgroundError);
  };

  return {
    sync(refreshNow = false): void {
      stop();
      if (!options.isVisible()) return;
      if (refreshNow) requestBackgroundRefresh();
      timer = setIntervalFn(requestBackgroundRefresh, intervalMs);
    },
    requestRefresh,
    stop,
  };
}
