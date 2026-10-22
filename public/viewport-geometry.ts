export interface VisualViewportGeometry {
  readonly height: number;
  readonly offsetTop: number;
}

/** Native keyboard bounds are CSS layout-viewport coordinates. The fixed
 * frame, not visualViewport.height or the inset view, maps their top to bottom.
 * An empty/invalid native rect means closed even if vv still reports a loss.
 */
export function virtualKeyboardViewportLayout(
  frame: { readonly parentTop: number; readonly fixedHeight: number },
  rect: Pick<DOMRectReadOnly, "top" | "width" | "height">,
  offsetTop: number,
): { readonly open: boolean; readonly inset: number; readonly top: number } {
  const top = Math.max(0, Number.isFinite(frame.parentTop) ? frame.parentTop : 0, Number.isFinite(offsetTop) ? offsetTop : 0);
  const open = [frame.fixedHeight, rect.top, rect.width, rect.height].every(Number.isFinite)
    && frame.fixedHeight > 0 && rect.width > 0 && rect.height > 0 && rect.top < frame.fixedHeight;
  const bottom = Math.max(0, Math.min(frame.fixedHeight, rect.top));
  return { open, inset: open ? frame.fixedHeight - bottom : 0, top: open ? Math.min(top, bottom) : top };
}

/** Pixels covered in the actual positioning frame below the visual viewport. */
export function keyboardOcclusionHeight(frameHeight: number, viewport: VisualViewportGeometry): number {
  if (!Number.isFinite(frameHeight) || !Number.isFinite(viewport.height) || !Number.isFinite(viewport.offsetTop)) return 0;
  return Math.max(0, Math.round(frameHeight - viewport.height - viewport.offsetTop));
}

/** Fixed positioning uses the native layout viewport height, not the absolute
 * parent's bottom (a shorter body can make these differ). Parent top only keeps
 * content below app chrome. Presence uses height loss without subtracting pan:
 * a large keyboard can leave only a small inset.
 */
export function keyboardViewportLayout(
  innerHeight: number,
  frame: { readonly parentTop: number; readonly fixedHeight: number },
  viewport: VisualViewportGeometry,
): { readonly open: boolean; readonly inset: number; readonly top: number } {
  return {
    open: keyboardOcclusionHeight(innerHeight, { height: viewport.height, offsetTop: 0 }) > 150,
    inset: keyboardOcclusionHeight(frame.fixedHeight, viewport),
    top: Math.max(frame.parentTop, viewport.offsetTop),
  };
}
