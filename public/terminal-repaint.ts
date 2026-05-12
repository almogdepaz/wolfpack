/**
 * Feature-detection helpers for ghostty-web private internals.
 *
 * The terminal forceRepaint() path in app.ts pokes ghostty-web private fields
 * (renderer, wasmTerm, viewportY) because no stable repaint API exists upstream.
 * Any ghostty-web bundle update that renames or restructures these fields
 * would silently turn forceRepaint() into a no-op (issue #130). Centralising
 * the shape check here makes it diagnosable (a single console.warn fires) and
 * testable in isolation.
 */

/**
 * Returns true when the ghostty-web Terminal instance exposes the private
 * fields forceRepaint() depends on. False means the upstream contract drifted
 * and the caller must surface a warning + skip the repaint.
 */
export function hasGhosttyRepaintHook(term: unknown): boolean {
  if (!term || typeof term !== "object") return false;
  const t = term as { renderer?: { render?: unknown }; wasmTerm?: unknown; viewportY?: unknown };
  if (!t.renderer || typeof t.renderer.render !== "function") return false;
  if (t.wasmTerm === undefined) return false;
  if (!("viewportY" in t)) return false;
  return true;
}
