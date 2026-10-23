export interface VisualViewportGeometry {
  readonly height: number;
  readonly offsetTop: number;
}

/** Pixels covered below the visual viewport, including a panned keyboard viewport. */
export function keyboardOcclusionHeight(layoutHeight: number, viewport: VisualViewportGeometry): number {
  if (!Number.isFinite(layoutHeight) || !Number.isFinite(viewport.height) || !Number.isFinite(viewport.offsetTop)) return 0;
  return Math.max(0, Math.round(layoutHeight - viewport.height - viewport.offsetTop));
}
