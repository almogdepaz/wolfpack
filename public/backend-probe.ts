/**
 * Reconnect cause probe of `GET /api/backend`. One deadline covers both the
 * request and the body read, so a stalled answer cannot leave it pending.
 */
import { backendProbeResultFromBody, type BackendProbeResult } from "../src/connection-status";

export type ProbeFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

const EXPIRED = Symbol("expired");

export async function probeBackendStatus(url: string, fetchImpl: ProbeFetch, timeoutMs: number): Promise<BackendProbeResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(EXPIRED);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([fetchImpl(url, { signal: controller.signal }).catch(() => null), expired]);
    if (response === null || response === EXPIRED) return { kind: "unreachable" };
    // Headers arrived, so the server is reachable even if the body never completes.
    const body = await Promise.race([response.json().catch(() => null), expired]);
    return backendProbeResultFromBody(body === EXPIRED ? null : body);
  } finally {
    clearTimeout(timer);
  }
}
