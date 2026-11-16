import { FOCUS_UI_ACTION as A, FOCUS_UI_BATCH_MAX, type FocusUiCard, type FocusUiEvent } from "../src/focus-ui-log";
import { browserAuthFetch, getBrowserAuthToken } from "./browser-auth";
export type FocusUiPayload = FocusUiEvent extends infer E ? E extends FocusUiEvent ? Omit<E, "visit" | "at"> : never : never;
interface Options {
  target(): string | undefined;
  send?: (url: string, body: string, leaving: boolean) => void | Promise<unknown>;
  now?: () => number;
  elapsed?: () => number;
  id?: () => string;
  schedule?: (fn: () => void) => unknown;
  cancel?: (timer: unknown) => void;
}
/** Best-effort only: bounded memory and requests, no retries, dialogs or awaited UI work. */
export function createFocusUiLog(options: Options) {
  const now = options.now ?? Date.now;
  const elapsed = options.elapsed ?? (() => performance.now());
  const id = options.id ?? (() => crypto.randomUUID());
  const schedule = options.schedule ?? (fn => setTimeout(fn, 800));
  const cancel = options.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const send = options.send ?? ((url: string, body: string, leaving: boolean) => {
    // Beacon cannot carry the owner's Bearer header. Never weaken auth or put tokens in URLs.
    if (leaving && !getBrowserAuthToken(url) && navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) return;
    return browserAuthFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: leaving, signal: AbortSignal.timeout(2000) });
  });
  let visit = "";
  let active = false;
  let activeTarget: string | undefined;
  let start = 0;
  let docked: boolean | undefined;
  let shown = "";
  let queue: FocusUiEvent[] = [];
  let bytes = 0;
  let destination: string | undefined;
  let timer: unknown;
  function flush(leaving = false) {
    try {
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      const events = queue; queue = []; bytes = 0;
      if (!events.length || !destination || destination !== options.target()) return;
      void Promise.resolve(send(destination, JSON.stringify({ events }), leaving)).catch(() => {});
    } catch { /* UX logging never interrupts the page, including unavailable storage/auth APIs. */ }
  }
  function record(payload: FocusUiPayload) {
    try {
      const target = options.target();
      if (!target) return;
      if (!visit) visit = id();
      if (destination !== target) { queue = []; bytes = 0; destination = target; }
      const event = { ...payload, visit, at: new Date(now()).toISOString() } as FocusUiEvent;
      const size = new Blob([JSON.stringify(event)]).size + 1;
      if (size > 48_000) return;
      if (bytes + size > 48_000 || queue.length >= FOCUS_UI_BATCH_MAX) flush();
      queue.push(event); bytes += size;
      if (timer === undefined) timer = schedule(() => { timer = undefined; flush(); });
    } catch { /* best effort; never log content or failures to the console */ }
  }
  function setVisible(visible: boolean, isDocked: boolean) {
    try {
      const target = options.target();
      if (active && activeTarget !== target) { active = false; shown = ""; flush(); }
      const show = visible && !!target;
      if (show && !active) {
        active = true; activeTarget = target; visit = id(); start = elapsed(); shown = ""; docked = undefined;
        record({ action: A.OPEN });
      } else if (!show && active) {
        record({ action: A.LEFT, visibleMs: Math.min(86_400_000, Math.max(0, Math.round(elapsed() - start))) });
        active = false; shown = ""; flush(true);
      }
      if (show && docked !== isDocked) { docked = isDocked; record({ action: A.VIEW, docked: isDocked }); }
    } catch { /* lifecycle bookkeeping is best effort too */ }
  }
  return { record, flush, setVisible,
    shown(cards: FocusUiCard[]) {
      if (!active) return;
      const signature = JSON.stringify(cards);
      if (shown === signature) return;
      shown = signature; record({ action: A.SHOWN, cards });
    },
  };
}
