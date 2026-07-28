export interface HydrationElement {
  readonly classList: Pick<DOMTokenList, "add" | "remove">;
}

export interface HydrationTerminal {
  scrollToBottom(): void;
  focus(): void;
}

export interface InitialHydrationController {
  readonly pending: boolean;
  start(): void;
  scheduleFinish(): void;
  notifyData(): void;
  finish(): void;
  forceFinish(): void;
  cancel(): void;
}

export interface InitialHydrationControllerOptions {
  readonly getElement: () => HydrationElement | null;
  readonly getTerm: () => HydrationTerminal | null;
  readonly shouldFocus: () => boolean;
  readonly isInitialContentComplete?: () => boolean;
  readonly canFinish?: () => boolean;
  readonly onReveal?: () => void;
  readonly onDiagnostic?: (kind: string, fields?: Record<string, unknown>) => void;
  readonly scheduleFrame?: (callback: FrameRequestCallback) => number;
  readonly timeoutMs?: number;
  readonly settleMs?: number;
  readonly maxPendingMs?: number;
  readonly minPendingMs?: number;
  readonly silenceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_SETTLE_MS = 80;
const DEFAULT_MAX_PENDING_MS = 4000;

/**
 * Coordinates the initial terminal reveal so prefill and post-attach redraw
 * writes are complete before the canvas becomes visible.
 */
export function createInitialHydrationController(
  options: InitialHydrationControllerOptions,
): InitialHydrationController {
  let pending = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let startedAt = 0;
  let lastDataAt = 0;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const settleMs = options.settleMs || DEFAULT_SETTLE_MS;
  const maxPendingMs = options.maxPendingMs || DEFAULT_MAX_PENDING_MS;
  const minPendingMs = options.minPendingMs || 0;
  const silenceMs = options.silenceMs || 0;

  function diagnostic(kind: string, fields?: Record<string, unknown>): void {
    options.onDiagnostic?.(kind, fields);
  }

  function finish(force = false): void {
    if (!pending) return;
    const elapsed = Date.now() - startedAt;
    if (!force && minPendingMs > 0 && elapsed < minPendingMs) {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, Math.max(settleMs, minPendingMs - elapsed));
      diagnostic("hydration.holdMinPending", { elapsed, minPendingMs });
      return;
    }
    if (!force && silenceMs > 0 && lastDataAt > 0) {
      const sinceLastData = Date.now() - lastDataAt;
      if (sinceLastData < silenceMs && elapsed < maxPendingMs) {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(finish, silenceMs - sinceLastData);
        diagnostic("hydration.holdSilence", { sinceLastData, silenceMs });
        return;
      }
    }
    if (!force && options.isInitialContentComplete && !options.isInitialContentComplete()) {
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      diagnostic("hydration.holdInitialContent", { elapsed });
      return;
    }
    if (!force && options.canFinish && !options.canFinish()) {
      if (elapsed >= maxPendingMs) {
        diagnostic("hydration.maxPendingHit", { elapsed });
      } else {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(finish, settleMs);
        diagnostic("hydration.holdCanFinish", { elapsed });
        return;
      }
    }
    pending = false;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    const term = options.getTerm();
    if (term) {
      try {
        term.scrollToBottom();
      } catch {}
    }
    diagnostic("hydration.finish", { elapsed });
    (options.scheduleFrame ?? requestAnimationFrame)(() => {
      if (pending) return;
      const element = options.getElement();
      if (element) {
        element.classList.remove("hydrating");
        element.classList.add("hydrated");
      }
      if (term && options.shouldFocus()) term.focus();
      options.onReveal?.();
      diagnostic("hydration.reveal");
    });
  }

  function start(): void {
    pending = true;
    startedAt = Date.now();
    if (fallbackTimer) clearTimeout(fallbackTimer);
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    fallbackTimer = setTimeout(finish, timeoutMs);
    diagnostic("hydration.start", { minPendingMs, silenceMs, timeoutMs });
  }

  function scheduleFinish(): void {
    if (!pending) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(finish, settleMs);
  }

  function notifyData(): void {
    lastDataAt = Date.now();
    if (pending && settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, settleMs);
    }
  }

  function forceFinish(): void {
    finish(true);
  }

  function cancel(): void {
    pending = false;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  }

  return {
    get pending(): boolean {
      return pending;
    },
    start,
    scheduleFinish,
    notifyData,
    finish,
    forceFinish,
    cancel,
  };
}
