export type TerminalLoadVisualState =
  | "cached"
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
  cached: "restoring cached snapshot",
  "prefill-loading": "loading terminal snapshot",
  hydrating: "hydrating terminal",
  reconnecting: "reconnecting terminal",
  "viewer-conflict": "active on another device",
  displaced: "control moved to another viewer",
  live: "terminal connected",
  ended: "terminal ended",
  failed: "terminal unavailable",
};

export interface SlowPathIndicator {
  start(label?: string): void;
  stop(): void;
}

export function setTerminalLoadVisualState(el: HTMLElement | null, state: TerminalLoadVisualState): void {
  if (!el) return;
  for (const name of Array.from(el.classList)) {
    if (name.startsWith(STATE_CLASS_PREFIX)) el.classList.remove(name);
  }
  el.classList.add(STATE_CLASS_PREFIX + state);
  el.dataset.terminalLoadState = state;
  el.dataset.terminalLoadLabel = STATE_LABELS[state];
  if (typeof el.setAttribute === "function") {
    el.setAttribute("aria-label", STATE_LABELS[state]);
  }
  const inlineStatus = el.querySelector<HTMLElement>(".grid-cell-loading");
  if (inlineStatus) inlineStatus.dataset.terminalLoadLabel = STATE_LABELS[state];
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
