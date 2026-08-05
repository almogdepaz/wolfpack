/**
 * Touch scroll handler for mobile terminal — momentum scrolling, long-press
 * text selection with drag-extend and clipboard copy.
 */
import { haptic } from "./app-state";

export function setupTouchScrollHandler(container, term, sendInput, canAcceptInput, dismissKeyboard) {
  let lastTouchY = 0;
  let scrollAccum = 0;
  let velocityY = 0;
  let momentumId = null;
  let tracking = false;
  let dragStarted = false;
  const DEFAULT_SCROLL_THRESHOLD_PX = 17;
  const FRICTION = 0.95;
  const MIN_VELOCITY = 0.5;
  const MAX_LINES_PER_EVENT = 5;
  const velocitySamples = [];
  const MAX_SAMPLES = 5;
  const encoder = new TextEncoder();

  // ── Long-press text selection state ──
  const LONGPRESS_MS = 500;
  const LONGPRESS_MOVE_TOLERANCE = 10;
  let longPressTimer = null;
  let selecting = false;
  let selStartX = 0, selStartY = 0;
  let selAnchorRow = -1, selAnchorCol = -1;
  let selEndRow = -1, selEndCol = -1;

  function touchToCell(clientX, clientY) {
    const canvas = container.querySelector("canvas");
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const cellW = rect.width / term.cols;
    const cellH = rect.height / term.rows;
    return {
      col: Math.max(0, Math.min(term.cols - 1, Math.floor(x / cellW))),
      row: Math.max(0, Math.min(term.rows - 1, Math.floor(y / cellH))),
    };
  }

  function syncTerminalSelection() {
    let startRow = selAnchorRow;
    let startCol = selAnchorCol;
    let endRow = selEndRow;
    let endCol = selEndCol;
    if (startRow > endRow || (startRow === endRow && startCol > endCol)) {
      [startRow, startCol, endRow, endCol] = [endRow, endCol, startRow, startCol];
    }
    const length = (endRow - startRow) * term.cols + endCol - startCol + 1;
    term.select(startCol, startRow, length);
  }

  async function copyTerminalSelection(): Promise<boolean> {
    const text = term.getSelection();
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const textarea = term.textarea;
      if (!textarea) return false;
      const activeElement = document.activeElement;
      textarea.value = text;
      textarea.focus({ preventScroll: true });
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      const copied = document.execCommand("copy");
      if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true });
      return copied;
    }
  }

  function clearSelection() {
    selecting = false;
    selAnchorRow = selAnchorCol = selEndRow = selEndCol = -1;
    term.clearSelection();
  }

  function cancelLongPress() {
    if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null; }
  }

  function sendScroll(deltaY) {
    let hasMouse = false;
    try { hasMouse = term.getMode(1000) || term.getMode(1002) || term.getMode(1003); } catch {}
    const metrics = term.renderer?.getMetrics?.();
    const scrollThreshold = metrics?.height > 0 ? metrics.height : DEFAULT_SCROLL_THRESHOLD_PX;
    scrollAccum += deltaY;
    const lines = Math.trunc(scrollAccum / scrollThreshold);
    if (lines === 0) return;
    scrollAccum -= lines * scrollThreshold;
    if (hasMouse) {
      const btn = lines > 0 ? 65 : 64;
      const seq = encoder.encode(`\x1b[<${btn};1;1M`);
      const count = Math.min(Math.abs(lines), MAX_LINES_PER_EVENT);
      for (let i = 0; i < count; i++) { if (canAcceptInput()) sendInput(seq); }
    } else {
      term.scrollLines(lines);
    }
  }

  function cancelMomentum() { if (momentumId !== null) { cancelAnimationFrame(momentumId); momentumId = null; } }

  function computeVelocity() {
    if (velocitySamples.length < 2) return 0;
    let totalV = 0, totalW = 0;
    for (let i = 1; i < velocitySamples.length; i++) {
      const dt = velocitySamples[i].t - velocitySamples[i - 1].t;
      if (dt <= 0) continue;
      const v = (velocitySamples[i].y - velocitySamples[i - 1].y) / dt;
      const w = i;
      totalV += v * w; totalW += w;
    }
    return totalW > 0 ? totalV / totalW : 0;
  }

  function momentumTick() {
    velocityY *= FRICTION;
    if (Math.abs(velocityY) < MIN_VELOCITY) { momentumId = null; return; }
    sendScroll(velocityY * 16);
    momentumId = requestAnimationFrame(momentumTick);
  }

  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    cancelMomentum();
    clearSelection();
    tracking = true;
    dragStarted = false;
    const touch = e.touches[0];
    lastTouchY = touch.clientY;
    selStartX = touch.clientX;
    selStartY = touch.clientY;
    scrollAccum = 0;
    velocitySamples.length = 0;
    velocitySamples.push({ y: touch.clientY, t: performance.now() });

    cancelLongPress();
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      const cell = touchToCell(selStartX, selStartY);
      if (!cell) return;
      selecting = true;
      tracking = false;
      selAnchorRow = selEndRow = cell.row;
      selAnchorCol = selEndCol = cell.col;
      haptic(30);
    }, LONGPRESS_MS);
  }

  function onTouchMove(e) {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];

    if (selecting) {
      e.preventDefault();
      const cell = touchToCell(touch.clientX, touch.clientY);
      if (!cell) return;
      if (cell.row === selAnchorRow) {
        // Same row: char-level selection
        selEndRow = cell.row;
        selEndCol = cell.col;
      } else {
        // Cross-row: line-level selection
        selEndRow = cell.row;
        selEndCol = cell.row > selAnchorRow ? term.cols - 1 : 0;
      }
      syncTerminalSelection();
      return;
    }

    if (!tracking) return;

    // Cancel long-press if finger moved beyond tolerance
    const dx = touch.clientX - selStartX;
    const dy = touch.clientY - selStartY;
    if (Math.sqrt(dx * dx + dy * dy) > LONGPRESS_MOVE_TOLERANCE) {
      cancelLongPress();
      if (!dragStarted) {
        dragStarted = true;
        dismissKeyboard();
      }
    }

    e.preventDefault();
    const deltaY = lastTouchY - touch.clientY;
    lastTouchY = touch.clientY;
    velocitySamples.push({ y: touch.clientY, t: performance.now() });
    if (velocitySamples.length > MAX_SAMPLES) velocitySamples.shift();
    sendScroll(deltaY);
  }

  function onTouchEnd() {
    cancelLongPress();
    // Ghostty focuses its textarea from the canvas touchend handler before
    // this container listener runs. Reassert the closed state after a drag.
    if (dragStarted) dismissKeyboard();

    if (selecting) {
      syncTerminalSelection();
      selecting = false;
      void copyTerminalSelection().then((copied) => {
        if (copied) haptic([10, 30, 10]);
        else console.debug("[clipboard] mobile terminal copy failed");
      });
      return;
    }

    if (!tracking) return;
    tracking = false;
    velocityY = -computeVelocity();
    if (Math.abs(velocityY) > MIN_VELOCITY) { momentumId = requestAnimationFrame(momentumTick); }
  }

  const keyboardButton = document.getElementById("kb-open-btn");
  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: false });
  container.addEventListener("touchend", onTouchEnd, { passive: true });
  container.addEventListener("touchcancel", onTouchEnd, { passive: true });
  keyboardButton?.addEventListener("click", cancelMomentum, true);

  return function cleanup() {
    cancelMomentum();
    cancelLongPress();
    clearSelection();
    container.removeEventListener("touchstart", onTouchStart);
    container.removeEventListener("touchmove", onTouchMove);
    container.removeEventListener("touchend", onTouchEnd);
    container.removeEventListener("touchcancel", onTouchEnd);
    keyboardButton?.removeEventListener("click", cancelMomentum, true);
  };
}
