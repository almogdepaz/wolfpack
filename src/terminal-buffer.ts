/**
 * Pure functions for terminal buffer operations.
 * Extracted from public/index.html so the scroll-position and serialization
 * logic can be unit-tested against the buffer.active API contract.
 */

/** The subset of terminal.buffer.active we depend on (ghostty-web compat). */
export interface TerminalBuffer {
  readonly viewportY: number;
  readonly baseY: number;
  readonly length: number;
  getLine(index: number): { translateToString(trimRight: boolean): string } | null;
}

/**
 * Capture scroll state before a resize/fit.
 * Used by fitTerminalPreserveScroll() to decide whether to restore position.
 */
export function captureScrollState(buffer: TerminalBuffer) {
  return {
    wasAtBottom: buffer.viewportY >= buffer.baseY,
    distanceFromBottom: Math.max(0, buffer.baseY - buffer.viewportY),
  };
}

/**
 * Compute the line to scroll to after a resize, preserving the user's
 * relative position from the bottom of the scrollback.
 */
export function scrollTargetAfterResize(nextBaseY: number, distanceFromBottom: number): number {
  return Math.max(0, nextBaseY - distanceFromBottom);
}

export interface ResizeRehydrateScrollState {
  readonly oldScrollbackLength: number;
  readonly oldViewportY: number;
  readonly newScrollbackLength: number;
}

export interface TerminalDimensions {
  readonly cols: number;
  readonly rows: number;
}

/**
 * Reflowing existing scrollback requires a reconnect/rehydrate. Only pay that
 * cost when the user is actually looking at scrollback; at bottom, normal PTY
 * resize + repaint is enough and avoids a visible hydration flicker.
 */
export function shouldResizeRehydrate(viewportY: number, userScrolledUp: boolean): boolean {
  return userScrolledUp && viewportY > 0;
}

export function shouldForceRepaintAfterFit(before: TerminalDimensions, after: TerminalDimensions, repaintRequested: boolean): boolean {
  if (!repaintRequested) return false;
  return before.cols === after.cols && before.rows === after.rows;
}

export function shouldSendResizeAfterGridFit(before: TerminalDimensions, after: TerminalDimensions): boolean {
  return before.cols !== after.cols || before.rows !== after.rows;
}

/**
 * Ghostty-web uses viewportY=0 for bottom and positive values for lines up
 * into scrollback. Preserve the same logical line through full rehydrate by
 * keeping the old distance from the scrollback bottom.
 */
export function resizeRehydrateScrollTarget(state: ResizeRehydrateScrollState): number | null {
  if (state.oldViewportY <= 0) return null;
  const distanceFromScrollbackBottom = Math.max(0, state.oldScrollbackLength - state.oldViewportY);
  return Math.max(0, state.newScrollbackLength - distanceFromScrollbackBottom);
}

/**
 * Serialize the last N lines from a terminal buffer into a string.
 * Used for snapshot persistence.
 */
export function serializeBufferTail(buffer: TerminalBuffer, maxLines: number): string {
  const start = Math.max(0, buffer.length - maxLines);
  const lines: string[] = [];
  for (let i = start; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n");
}
