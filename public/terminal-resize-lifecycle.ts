import { TERMINAL_PREFILL_MODE } from "../src/terminal-prefill";
import type { TerminalPrefillMode } from "../src/terminal-prefill";
import { shouldResizeRehydrate } from "../src/terminal-buffer";

const RESIZE_REHYDRATE_DELAY_MS = 350;
const CONTAINER_RESIZE_SYNC_OPTIONS = {
  forceSend: true,
  repaint: true,
  reason: "container-resize",
} as const;

export interface TerminalResizeLifecycleScheduler {
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

export interface TerminalResizeLifecycleContainer {
  readonly clientWidth: number;
  readonly clientHeight: number;
}

export interface TerminalResizeLifecycleTerm {
  readonly viewportY?: number;
  getScrollbackLength?(): number;
}

export interface TerminalResizeLifecycleClient {
  readonly isOpen: boolean;
  reconnect(): void;
}

export interface ResizeScrollRestore {
  readonly oldScrollbackLength: number;
  readonly oldViewportY: number;
}

export interface TerminalResizeLifecycleOptions {
  readonly prefillMode: TerminalPrefillMode;
  readonly getContainer: () => TerminalResizeLifecycleContainer | null;
  readonly getTerm: () => TerminalResizeLifecycleTerm | null;
  readonly getPtyClient: () => TerminalResizeLifecycleClient | null;
  readonly shouldSuppressContainerResize: () => boolean;
  readonly userRequestedScrollback: () => boolean;
  readonly syncLayout: (options: typeof CONTAINER_RESIZE_SYNC_OPTIONS) => void;
  readonly scheduler: TerminalResizeLifecycleScheduler;
  readonly createResizeObserver: (
    callback: (entries: readonly unknown[]) => void,
  ) => { observe(container: TerminalResizeLifecycleContainer): void; disconnect(): void } | null;
}

export interface TerminalResizeLifecycle {
  observe(container: TerminalResizeLifecycleContainer): void;
  scheduleLayoutSync(): void;
  scheduleResizeRehydrate(): void;
  takePendingScrollRestore(): ResizeScrollRestore | null;
  readonly hasPendingScrollRestore: boolean;
  dispose(): void;
}

export function createTerminalResizeLifecycle(
  options: TerminalResizeLifecycleOptions,
): TerminalResizeLifecycle {
  let layoutSyncFrame: number | null = null;
  let resizeRehydrateTimer: number | null = null;
  let resizeObserver: {
    observe(container: TerminalResizeLifecycleContainer): void;
    disconnect(): void;
  } | null = null;
  let pendingScrollRestore: ResizeScrollRestore | null = null;

  const scheduleLayoutSync = (): void => {
    if (layoutSyncFrame !== null) options.scheduler.cancelFrame(layoutSyncFrame);
    layoutSyncFrame = options.scheduler.requestFrame(() => {
      layoutSyncFrame = null;
      if (options.shouldSuppressContainerResize()) return;
      options.syncLayout(CONTAINER_RESIZE_SYNC_OPTIONS);
    });
  };

  const scheduleResizeRehydrate = (): void => {
    if (options.prefillMode === TERMINAL_PREFILL_MODE.NONE) return;
    const client = options.getPtyClient();
    if (!client?.isOpen || options.shouldSuppressContainerResize()) return;

    if (resizeRehydrateTimer !== null) options.scheduler.clearTimeout(resizeRehydrateTimer);
    resizeRehydrateTimer = options.scheduler.setTimeout(() => {
      resizeRehydrateTimer = null;
      const currentTerm = options.getTerm();
      const currentClient = options.getPtyClient();
      if (!currentTerm || !currentClient?.isOpen || options.shouldSuppressContainerResize()) return;
      const viewportY = currentTerm.viewportY ?? 0;
      if (!shouldResizeRehydrate(viewportY, options.userRequestedScrollback())) return;
      pendingScrollRestore = {
        oldScrollbackLength: currentTerm.getScrollbackLength?.() ?? 0,
        oldViewportY: viewportY,
      };
      currentClient.reconnect();
    }, RESIZE_REHYDRATE_DELAY_MS);
  };

  return {
    observe(container): void {
      if (resizeObserver) return;
      resizeObserver = options.createResizeObserver((entries) => {
        if (entries.length === 0) return;
        const currentContainer = options.getContainer();
        if (!currentContainer || !options.getTerm()) return;
        if (currentContainer.clientWidth === 0 || currentContainer.clientHeight === 0) return;
        if (options.shouldSuppressContainerResize()) return;
        scheduleLayoutSync();
      });
      resizeObserver?.observe(container);
    },
    scheduleLayoutSync,
    scheduleResizeRehydrate,
    takePendingScrollRestore(): ResizeScrollRestore | null {
      const restore = pendingScrollRestore;
      pendingScrollRestore = null;
      return restore;
    },
    get hasPendingScrollRestore(): boolean {
      return pendingScrollRestore !== null;
    },
    dispose(): void {
      if (layoutSyncFrame !== null) options.scheduler.cancelFrame(layoutSyncFrame);
      if (resizeRehydrateTimer !== null) options.scheduler.clearTimeout(resizeRehydrateTimer);
      layoutSyncFrame = null;
      resizeRehydrateTimer = null;
      pendingScrollRestore = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
    },
  };
}
