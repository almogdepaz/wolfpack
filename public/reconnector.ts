export const RECONNECT_BUDGET_MS = 2 * 60 * 1000;
export const RECONNECT_BASE_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 5000;

export interface ReconnectorOpts {
  shouldReconnect?: () => boolean;
  onReconnecting?: () => void;
  onExhausted?: () => void;
}

export interface ReconnectorRuntime {
  now(): number;
  random(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface Reconnector {
  schedule(connectFn: () => void): void;
  cancel(): void;
  reset(): void;
  block(): void;
  connected(): boolean;
  readonly isBlocked: boolean;
  readonly pending: boolean;
}

const browserRuntime: ReconnectorRuntime = {
  now: Date.now,
  random: Math.random,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Exponential reconnect budget. Call connected() only at protocol readiness. */
export function createReconnector(
  opts: ReconnectorOpts = {},
  runtime: ReconnectorRuntime = browserRuntime,
): Reconnector {
  let timer: unknown = null;
  let delay = RECONNECT_BASE_DELAY_MS;
  let startedAt = 0;
  let blocked = false;

  function schedule(connectFn: () => void): void {
    if (timer !== null || blocked || (opts.shouldReconnect && !opts.shouldReconnect())) return;
    const now = runtime.now();
    if (!startedAt) startedAt = now;
    const remaining = RECONNECT_BUDGET_MS - (now - startedAt);
    if (remaining <= 0) {
      blocked = true;
      opts.onExhausted?.();
      return;
    }
    opts.onReconnecting?.();
    const jitterMs = Math.floor(runtime.random() * 200);
    const delayMs = Math.min(delay + jitterMs, RECONNECT_MAX_DELAY_MS, remaining);
    timer = runtime.setTimer(() => {
      timer = null;
      if (opts.shouldReconnect && !opts.shouldReconnect()) return;
      connectFn();
    }, delayMs);
    delay = Math.min(Math.floor(delay * 1.8), RECONNECT_MAX_DELAY_MS);
  }

  function cancel(): void {
    if (timer !== null) {
      runtime.clearTimer(timer);
      timer = null;
    }
  }

  function reset(): void {
    blocked = false;
    startedAt = 0;
    delay = RECONNECT_BASE_DELAY_MS;
  }

  function connected(): boolean {
    const wasReconnecting = startedAt > 0;
    reset();
    return wasReconnecting;
  }

  return {
    schedule,
    cancel,
    reset,
    block: () => { blocked = true; },
    connected,
    get isBlocked() { return blocked; },
    get pending() { return timer !== null; },
  };
}
