/**
 * Pure peer-health tracking. When a remote wolfpack peer fails repeatedly, we
 * shorten its request timeout so a dead peer doesn't dominate UI refresh time.
 * On success the counter resets — a recovered peer is treated as healthy again
 * on the next success.
 */

export type PeerHealthMap = Record<string, { failures: number }>;

export const FAILING_TIMEOUT_MS = 1500;
export const HEALTHY_TIMEOUT_MS = 5000;
export const FAILURE_THRESHOLD = 2;

export function recordFailure(state: PeerHealthMap, url: string): PeerHealthMap {
  const cur = state[url]?.failures ?? 0;
  return { ...state, [url]: { failures: cur + 1 } };
}

export function recordSuccess(state: PeerHealthMap, url: string): PeerHealthMap {
  if (!state[url]) return state;
  const next = { ...state };
  delete next[url];
  return next;
}

export function fetchTimeoutMs(state: PeerHealthMap, url: string): number {
  const failures = state[url]?.failures ?? 0;
  // Every fourth failed attempt gets a full-budget recovery probe (~20s at
  // the browser repair cadence), so a healthy but slower peer can recover.
  return failures >= FAILURE_THRESHOLD && (failures - FAILURE_THRESHOLD) % 4 !== 3
    ? FAILING_TIMEOUT_MS : HEALTHY_TIMEOUT_MS;
}
