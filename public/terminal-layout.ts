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
  resize?(cols: number, rows: number): void;
  scrollToLine(line: number): void;
}

export interface TerminalFitAddon {
  proposeDimensions?(): TerminalDimensions | undefined;
  fit(): void;
}

export interface TerminalResizeClient {
  readonly supportsOrderedResize: boolean;
  sendResize(cols: number, rows: number): Promise<void>;
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

/** Commits broker-acknowledged dimensions while preserving scroll position. */
export function commitTerminalResizePreservingScroll(
  term: TerminalLayoutTerm | null,
  dimensions: TerminalDimensions,
): boolean {
  if (!term || dimensions.cols < 1 || dimensions.rows < 1 || !term.resize) return false;
  const before = { cols: term.cols, rows: term.rows };
  if (before.cols === dimensions.cols && before.rows === dimensions.rows) return false;

  const viewportY = term.viewportY ?? 0;
  const oldScrollbackLength = term.getScrollbackLength?.() ?? 0;
  const wasAtBottom = viewportY === 0;
  term.resize(dimensions.cols, dimensions.rows);

  if (!wasAtBottom && viewportY > 0) {
    const newScrollbackLength = term.getScrollbackLength?.() ?? oldScrollbackLength;
    const target = Math.max(0, newScrollbackLength - (oldScrollbackLength - viewportY));
    try { term.scrollToLine(target); } catch {}
  }
  return true;
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

/** Fits, repaints when needed, and resolves after the active resize settles. */
export function syncTerminalLayout(options: SyncTerminalLayoutOptions): Promise<void> {
  const { term, fitAddon } = options;
  if (!term || !fitAddon) return Promise.resolve();

  const before = { cols: term.cols, rows: term.rows };
  const proposed = options.ptyClient?.supportsOrderedResize
    ? fitAddon.proposeDimensions?.()
    : undefined;
  if (options.ptyClient && proposed) {
    const dimensionsChanged = shouldSendResizeAfterGridFit(before, proposed);
    return dimensionsChanged
      ? options.ptyClient.sendResize(proposed.cols, proposed.rows)
      : Promise.resolve();
  }

  const after = fitTerminalPreservingScroll(options);
  if (!after) return Promise.resolve();

  if (shouldForceRepaintAfterFit(before, after, options.repaint)) {
    forceTerminalRepaint(term);
  }

  const dimensionsChanged = shouldSendResizeAfterGridFit(before, after);
  if (dimensionsChanged) options.onDimensionsChanged?.();
  return options.ptyClient && dimensionsChanged
    ? options.ptyClient.sendResize(after.cols, after.rows)
    : Promise.resolve();
}
