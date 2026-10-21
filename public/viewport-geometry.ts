export interface VisualViewportGeometry {
  readonly height: number;
  readonly offsetTop: number;
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
