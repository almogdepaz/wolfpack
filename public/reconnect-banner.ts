/**
 * The single-terminal `#conn-status` reconnect banner. It speaks only for the
 * terminal that reported the status and stops once that terminal is no longer
 * current. The countdown is visual only: the live region's accessible text
 * changes when the cause or attempt changes, not every second.
 */
import {
  createReconnectStatusTicker,
  type ReconnectStatus,
  type ReconnectStatusTickerRuntime,
  type ReconnectView,
} from "../src/connection-status";

export interface ReconnectBannerDeps<Owner> {
  getElement(): HTMLElement | null;
  /** True while `owner` is still the visible terminal the banner speaks for. */
  isCurrentOwner(owner: Owner): boolean;
  createIcon(): HTMLElement;
  createCountdown(): HTMLElement;
  runtime?: ReconnectStatusTickerRuntime;
}

export interface ReconnectBanner<Owner> {
  show(owner: Owner, status: ReconnectStatus, machineLabel: string | undefined): void;
  stop(): void;
}

export function createReconnectBanner<Owner>(deps: ReconnectBannerDeps<Owner>): ReconnectBanner<Owner> {
  let owner: { readonly value: Owner } | null = null;
  let countdown: HTMLElement | null = null;

  function render(view: ReconnectView): void {
    const element = deps.getElement();
    if (!element || !owner || element.dataset.connState !== "reconnecting" || !deps.isCurrentOwner(owner.value)) {
      stop();
      return;
    }
    const countdownText = `, ${view.countdown}`;
    if (countdown && element.dataset.reconnectLead === view.lead) {
      if (countdown.textContent !== countdownText) countdown.textContent = countdownText;
      return;
    }
    countdown = deps.createCountdown();
    countdown.setAttribute("aria-hidden", "true");
    countdown.textContent = countdownText;
    element.replaceChildren(deps.createIcon(), view.lead, countdown, ")");
    element.dataset.reconnectLead = view.lead;
    element.dataset.reconnectCause = view.state;
  }

  const ticker = createReconnectStatusTicker(render, deps.runtime);

  function stop(): void {
    ticker.stop();
    owner = null;
    countdown = null;
    const element = deps.getElement();
    if (element) {
      delete element.dataset.reconnectLead;
      delete element.dataset.reconnectCause;
    }
  }

  return {
    show(nextOwner, status, machineLabel) {
      owner = { value: nextOwner };
      ticker.update(status, machineLabel);
    },
    stop,
  };
}
