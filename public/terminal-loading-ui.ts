export type TerminalLoadVisualState =
  | "prefill-loading"
  | "hydrating"
  | "reconnecting"
  | "viewer-conflict"
  | "displaced"
  | "live"
  | "ended"
  | "failed";

export const TERMINAL_SLOW_LOAD_THRESHOLD_MS = 1200;

const STATE_CLASS_PREFIX = "terminal-load-state-";

const STATE_LABELS: Record<TerminalLoadVisualState, string> = {
  "prefill-loading": "loading terminal",
  hydrating: "preparing terminal",
  reconnecting: "reconnecting terminal",
  "viewer-conflict": "take control to view",
  displaced: "opened elsewhere",
  live: "terminal connected",
  ended: "terminal ended",
  failed: "terminal unavailable",
};

export function terminalLoadLabelFor(state: TerminalLoadVisualState): string {
  return STATE_LABELS[state];
}

export interface SlowPathIndicator {
  start(label?: string): void;
  stop(): void;
}

export interface CancelableTerminalHydration {
  cancel(): void;
}

export function revealTerminalConflict(
  el: HTMLElement | null,
  hydration: CancelableTerminalHydration | null | undefined,
): void {
  hydration?.cancel();
  if (!el) return;
  el.classList.remove("hydrating");
  el.classList.add("hydrated");
}

export function setTerminalLoadVisualState(el: HTMLElement | null, state: TerminalLoadVisualState): void {
  if (!el) return;
  for (const name of Array.from(el.classList)) {
    if (name.startsWith(STATE_CLASS_PREFIX)) el.classList.remove(name);
  }
  el.classList.add(STATE_CLASS_PREFIX + state);
  el.dataset.terminalLoadState = state;
  const label = terminalLoadLabelFor(state);
  el.dataset.terminalLoadLabel = label;
  if (typeof el.setAttribute === "function") {
    el.setAttribute("aria-label", label);
  }
  const inlineStatus = el.querySelector<HTMLElement>(".grid-cell-loading");
  if (inlineStatus) inlineStatus.dataset.terminalLoadLabel = label;
  if (state === "live" || state === "ended" || state === "failed" || state === "viewer-conflict" || state === "displaced") {
    clearTerminalSlowPath(el);
  }
}

export function createTerminalSlowPathIndicator(
  el: HTMLElement | null,
  thresholdMs = TERMINAL_SLOW_LOAD_THRESHOLD_MS,
): SlowPathIndicator {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function stop(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    clearTerminalSlowPath(el);
  }

  function start(label = "still loading terminal"): void {
    if (!el) return;
    stop();
    timer = setTimeout(() => {
      timer = null;
      el.classList.add("terminal-load-slow");
      el.dataset.terminalSlowLabel = label;
    }, thresholdMs);
  }

  return { start, stop };
}

export function clearTerminalSlowPath(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.remove("terminal-load-slow");
  delete el.dataset.terminalSlowLabel;
}
