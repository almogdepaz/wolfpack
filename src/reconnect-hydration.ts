/**
 * Pure decision functions for reconnect hydration.
 * Used by both the browser frontend (via wolfpack-lib.js bundle)
 * and unit tests (via direct import).
 */

/**
 * Determine whether an opened socket replaces content already shown by this
 * controller. Auto-reconnects always replace. A fresh client created by a
 * manual retry replaces only after initial hydration and only when its attach
 * carries an authoritative prefill (`full` or `viewport`).
 */
export function shouldRehydrate(
  wasReconnect: boolean,
  hydrationStarted: boolean,
  hasAuthoritativePrefill: boolean,
): boolean {
  return wasReconnect || (hydrationStarted && hasAuthoritativePrefill);
}
