import {
  shouldForceRepaintAfterFit,
  shouldSendResizeAfterGridFit,
} from "../src/terminal-buffer";

export interface TerminalLayoutTerm {
  readonly cols: number;
  readonly rows: number;
  readonly viewportY?: number;
  readonly wasmTerm?: unknown;
  readonly renderer?: {
    readonly render?: (
      wasmTerm: unknown,
      forceAll: boolean,
      viewportY: number | undefined,
      scrollbackProvider: TerminalLayoutTerm,
    ) => void;
  };
  getScrollbackLength?(): number;
  scrollToLine(line: number): void;
}

export interface TerminalFitAddon {
  fit(): void;
}

export interface TerminalResizeClient {
  sendFitResize(options: { readonly force: boolean; readonly fit: boolean }): void;
}

export interface TerminalDimensions {
  readonly cols: number;
  readonly rows: number;
}

export interface FitTerminalOptions {
  readonly term: TerminalLayoutTerm | null;
  readonly fitAddon: TerminalFitAddon | null;
  readonly onFit?: (dimensions: TerminalDimensions) => void;
}

export interface SyncTerminalLayoutOptions extends FitTerminalOptions {
  readonly ptyClient: TerminalResizeClient | null;
  readonly forceSend: boolean;
  readonly repaint: boolean;
  readonly onDimensionsChanged?: () => void;
}

/**
 * Fits while preserving the reader's distance from the scrollback bottom.
 * Ghostty uses `viewportY = 0` for bottom and positive values for history;
 * preserve `scrollbackLength - viewportY` across a reflow.
 */
export function fitTerminalPreservingScroll(
  options: FitTerminalOptions,
): TerminalDimensions | null {
  const { term, fitAddon } = options;
  if (!term || !fitAddon) return null;

  const viewportY = term.viewportY ?? 0;
  const oldScrollbackLength = term.getScrollbackLength?.() ?? 0;
  const wasAtBottom = viewportY === 0;
  fitAddon.fit();

  const dimensions = { cols: term.cols, rows: term.rows };
  options.onFit?.(dimensions);

  if (!wasAtBottom && viewportY > 0) {
    const newScrollbackLength = term.getScrollbackLength?.() ?? oldScrollbackLength;
    const target = Math.max(0, newScrollbackLength - (oldScrollbackLength - viewportY));
    try { term.scrollToLine(target); } catch {}
  }

  return dimensions;
}

/**
 * Forces a renderer pass when a fit keeps the same terminal dimensions.
 * Ghostty's public resize/fit paths skip same-size repaints, so this calls the
 * renderer directly; that private API may drift between Ghostty versions.
 */
export function forceTerminalRepaint(term: TerminalLayoutTerm | null): void {
  if (!term) return;
  try {
    term.renderer?.render?.(term.wasmTerm, true, term.viewportY, term);
  } catch {}
}

/** Fits, repaints when needed, and forwards a changed terminal size to the PTY. */
export function syncTerminalLayout(options: SyncTerminalLayoutOptions): boolean {
  const { term, fitAddon } = options;
  if (!term || !fitAddon) return false;

  const before = { cols: term.cols, rows: term.rows };
  const after = fitTerminalPreservingScroll(options);
  if (!after) return false;

  if (shouldForceRepaintAfterFit(before, after, options.repaint)) {
    forceTerminalRepaint(term);
  }

  const dimensionsChanged = shouldSendResizeAfterGridFit(before, after);
  if (options.ptyClient && dimensionsChanged) {
    options.ptyClient.sendFitResize({ force: options.forceSend, fit: false });
  }
  if (dimensionsChanged) options.onDimensionsChanged?.();

  return dimensionsChanged;
}
