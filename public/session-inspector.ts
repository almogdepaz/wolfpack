import { SESSION_SNAPSHOT_FRESHNESS } from "../src/session-snapshot-contract.js";
import type { SessionSnapshotFreshness } from "../src/session-snapshot-contract.js";

export interface SessionSnapshot {
  readonly session: string;
  readonly sessionId: string;
  readonly text: string;
  readonly capturedAt: string;
  readonly cols: number;
  readonly rows: number;
  readonly truncated: boolean;
  readonly freshness: SessionSnapshotFreshness;
}

export interface SessionInspectorTarget {
  readonly session: string;
  readonly sessionId: string;
  readonly machine: string | undefined;
}

export interface SessionInspectorOptions {
  readonly requestSnapshot: (sessionId: string, machine: string | undefined, signal: AbortSignal) => Promise<SessionSnapshot>;
  readonly isMachineReady: (machine: string | undefined) => boolean;
}

const REFRESH_INTERVAL_MS = 2_000;

export interface SessionInspector {
  open(target: SessionInspectorTarget, invoker: HTMLElement): void;
}

export function createSessionInspector(options: SessionInspectorOptions): SessionInspector {
  const dialog = requiredElement<HTMLDialogElement>("session-inspector-dialog");
  const title = requiredElement<HTMLElement>("session-inspector-title");
  const status = requiredElement<HTMLElement>("session-inspector-status");
  const metadata = requiredElement<HTMLElement>("session-inspector-metadata");
  const output = requiredElement<HTMLElement>("session-inspector-output");
  const closeButton = requiredElement<HTMLButtonElement>("session-inspector-close");
  const retryButton = requiredElement<HTMLButtonElement>("session-inspector-retry");
  let target: SessionInspectorTarget | null = null;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let lastSnapshot: SessionSnapshot | null = null;
  let returnFocus: HTMLElement | null = null;

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const isActive = (expectedGeneration: number): boolean => target !== null
    && generation === expectedGeneration
    && dialog.open;
  const renderMetadata = (snapshot: SessionSnapshot): void => {
    metadata.textContent = `${snapshot.cols} × ${snapshot.rows} · captured ${captureAge(snapshot.capturedAt)}${snapshot.truncated ? " · truncated" : ""}`;
  };
  const renderUnavailable = (): void => {
    if (lastSnapshot) renderMetadata(lastSnapshot);
    status.textContent = lastSnapshot
      ? "Inspection unavailable; showing stale text. Retry in a moment."
      : "Inspection unavailable. Retry in a moment.";
  };
  const scheduleRefresh = (expectedGeneration: number): void => {
    if (!isActive(expectedGeneration) || document.visibilityState !== "visible") return;
    clearTimer();
    let scheduledTimer!: ReturnType<typeof setTimeout>;
    scheduledTimer = setTimeout(() => {
      if (timer === scheduledTimer) timer = null;
      void refresh(expectedGeneration);
    }, REFRESH_INTERVAL_MS);
    timer = scheduledTimer;
  };
  const close = (): void => {
    generation++;
    clearTimer();
    controller?.abort();
    controller = null;
    target = null;
    lastSnapshot = null;
    const invoker = returnFocus;
    returnFocus = null;
    if (dialog.open) dialog.close();
    if (invoker?.isConnected) invoker.focus({ preventScroll: true });
  };
  const renderSnapshot = (snapshot: SessionSnapshot): void => {
    title.textContent = `Inspect ${snapshot.session}`;
    output.textContent = snapshot.text || "(visible screen is empty)";
    renderMetadata(snapshot);
    status.textContent = snapshot.freshness === SESSION_SNAPSHOT_FRESHNESS.CACHED ? "Snapshot cached; not live." : "Snapshot; not live.";
  };
  const refresh = async (expectedGeneration: number): Promise<void> => {
    if (!isActive(expectedGeneration)) return;
    clearTimer();
    if (document.visibilityState !== "visible") {
      status.textContent = "Paused while this page is hidden.";
      return;
    }
    const activeTarget = target!;
    if (!options.isMachineReady(activeTarget.machine)) {
      controller?.abort();
      controller = null;
      renderUnavailable();
      scheduleRefresh(expectedGeneration);
      return;
    }
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    status.textContent = lastSnapshot ? "Refreshing snapshot…" : "Loading snapshot…";
    try {
      const snapshot = await options.requestSnapshot(activeTarget.sessionId, activeTarget.machine, requestController.signal);
      if (!isActive(expectedGeneration) || controller !== requestController || target?.sessionId !== activeTarget.sessionId) return;
      if (!options.isMachineReady(activeTarget.machine) || snapshot.sessionId !== activeTarget.sessionId) {
        renderUnavailable();
        return;
      }
      lastSnapshot = snapshot;
      renderSnapshot(snapshot);
    } catch (error: unknown) {
      if (requestController.signal.aborted || controller !== requestController || !isActive(expectedGeneration)) return;
      renderUnavailable();
    } finally {
      if (controller !== requestController || !isActive(expectedGeneration)) return;
      controller = null;
      if (document.visibilityState === "visible") scheduleRefresh(expectedGeneration);
    }
  };

  closeButton.addEventListener("click", close);
  retryButton.addEventListener("click", () => { void refresh(generation); });
  dialog.addEventListener("close", () => {
    generation++;
    clearTimer();
    controller?.abort();
    controller = null;
    target = null;
    returnFocus = null;
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  document.addEventListener("visibilitychange", () => {
    if (!target || !dialog.open) return;
    if (document.visibilityState === "visible") void refresh(generation);
    else {
      clearTimer();
      controller?.abort();
      status.textContent = "Paused while this page is hidden.";
    }
  });

  return {
    open(nextTarget, invoker): void {
      generation++;
      clearTimer();
      controller?.abort();
      target = nextTarget;
      returnFocus = invoker;
      lastSnapshot = null;
      title.textContent = `Inspect ${nextTarget.session}`;
      status.textContent = options.isMachineReady(nextTarget.machine)
        ? "Loading snapshot…"
        : "Inspection unavailable: machine is not ready.";
      metadata.textContent = "";
      output.textContent = "";
      if (!dialog.open) dialog.showModal();
      void refresh(generation);
    },
  };
}

function requiredElement<TElement extends HTMLElement>(id: string): TElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`missing required session inspector element: ${id}`);
  return element as TElement;
}

function captureAge(capturedAt: string): string {
  const capturedAtMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedAtMs)) return "at unknown time";
  const seconds = Math.max(0, Math.floor((Date.now() - capturedAtMs) / 1_000));
  return seconds === 0 ? "just now" : `${seconds}s ago`;
}
