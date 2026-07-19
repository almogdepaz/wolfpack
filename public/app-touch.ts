/**
 * Touch scroll handler for mobile terminal — momentum scrolling, long-press
 * text selection with drag-extend and clipboard copy.
 */
import { haptic } from "./app-state";

export function setupTouchScrollHandler(container, term, sendInput, canAcceptInput) {
  let lastTouchY = 0;
  let scrollAccum = 0;
  let velocityY = 0;
  let momentumId = null;
  let tracking = false;
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
  let selOverlay = null;

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

  function getSelectedText() {
    if (selAnchorRow < 0 || selEndRow < 0) return "";
    const buf = term.buffer.active;
    const viewportY = Math.max(0, buf.viewportY || 0);
    let r0 = selAnchorRow, c0 = selAnchorCol, r1 = selEndRow, c1 = selEndCol;
    if (r0 > r1 || (r0 === r1 && c0 > c1)) {
      [r0, c0, r1, c1] = [r1, c1, r0, c0];
    }
    const lines: string[] = [];
    for (let r = r0; r <= r1; r++) {
      const lineIndex = Math.max(0, viewportY + r);
      const line = buf.getLine(lineIndex);
      if (!line) continue;
      const start = r === r0 ? c0 : 0;
      const end = r === r1 ? c1 + 1 : term.cols;
      let text = "";
      for (let c = start; c < end; c++) {
        const cell = line.getCell(c);
        text += cell ? cell.getChars() || " " : " ";
      }
      lines.push(text.trimEnd());
    }
    return lines.join("\n");
  }

  let selCopyBtn: HTMLButtonElement | null = null;

  function showSelectionOverlay() {
    if (!selOverlay) {
      selOverlay = document.createElement("div");
      selOverlay.style.cssText = "position:absolute;background:rgba(0,255,65,0.18);pointer-events:none;z-index:10;border-radius:2px;";
      container.appendChild(selOverlay);
    }
    const canvas = container.querySelector("canvas");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    const cellW = rect.width / term.cols;
    const cellH = rect.height / term.rows;
    let r0 = selAnchorRow, c0 = selAnchorCol, r1 = selEndRow, c1 = selEndCol;
    if (r0 > r1 || (r0 === r1 && c0 > c1)) {
      [r0, c0, r1, c1] = [r1, c1, r0, c0];
    }
    const ox = rect.left - cRect.left;
    const oy = rect.top - cRect.top;
    if (r0 === r1) {
      selOverlay.style.left = (ox + c0 * cellW) + "px";
      selOverlay.style.top = (oy + r0 * cellH) + "px";
      selOverlay.style.width = ((c1 - c0 + 1) * cellW) + "px";
      selOverlay.style.height = cellH + "px";
    } else {
      selOverlay.style.left = ox + "px";
      selOverlay.style.top = (oy + r0 * cellH) + "px";
      selOverlay.style.width = (term.cols * cellW) + "px";
      selOverlay.style.height = ((r1 - r0 + 1) * cellH) + "px";
    }
  }

  function showCopyButton() {
    if (selCopyBtn) selCopyBtn.remove();
    const canvas = container.querySelector("canvas");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    const cellH = rect.height / term.rows;
    const r0 = Math.min(selAnchorRow, selEndRow);
    const oy = rect.top - cRect.top;

    selCopyBtn = document.createElement("button");
    selCopyBtn.textContent = "Copy";
    selCopyBtn.className = "sel-copy-btn";
    // Position above the selection
    const btnTop = oy + r0 * cellH - 32;
    selCopyBtn.style.cssText = "position:absolute;z-index:11;left:50%;transform:translateX(-50%);top:" + Math.max(0, btnTop) + "px;background:var(--accent);color:var(--bg-base);border:none;border-radius:6px;padding:4px 14px;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer;pointer-events:auto;box-shadow:0 2px 8px rgba(0,0,0,0.5);";
    selCopyBtn.addEventListener("touchstart", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = getSelectedText();
      if (text && navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
          haptic([10, 30, 10]);
          if (selCopyBtn) selCopyBtn.textContent = "Copied!";
          setTimeout(() => clearSelection(), 600);
        }).catch(() => { clearSelection(); });
      }
    }, { passive: false });
    selCopyBtn.addEventListener("click", (e) => { e.stopPropagation(); });
    container.appendChild(selCopyBtn);
  }

  function clearSelection() {
    selecting = false;
    selAnchorRow = selAnchorCol = selEndRow = selEndCol = -1;
    if (selOverlay) { selOverlay.remove(); selOverlay = null; }
    if (selCopyBtn) { selCopyBtn.remove(); selCopyBtn = null; }
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
    // Blur proxy on terminal touch — keyboard only opens via kb-open-btn.
    // Skip blur if the touch originated on kb-open-btn (or its children),
    // otherwise toggleMobileKeyboard's focus() is immediately undone.
    const target = e.target as HTMLElement;
    const isKbBtn = target.id === "kb-open-btn" || target.closest?.("#kb-open-btn");
    if (!isKbBtn) {
      const proxy = document.getElementById("mobile-kb-proxy");
      if (proxy && document.activeElement === proxy) proxy.blur();
    }
    cancelMomentum();
    clearSelection();
    tracking = true;
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
      showSelectionOverlay();
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
      showSelectionOverlay();
      return;
    }

    if (!tracking) return;

    // Cancel long-press if finger moved beyond tolerance
    const dx = touch.clientX - selStartX;
    const dy = touch.clientY - selStartY;
    if (Math.sqrt(dx * dx + dy * dy) > LONGPRESS_MOVE_TOLERANCE) {
      cancelLongPress();
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

    if (selecting) {
      // Keep selection visible — show copy button for explicit user action.
      // Selection is dismissed on next touchstart (scroll or new selection).
      showCopyButton();
      selecting = false;  // stop extending selection, but keep overlay visible
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
