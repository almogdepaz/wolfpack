export const API_REQUEST_TIMEOUT_MS = 15_000;

export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** True for a deadline expiry before headers (`RequestTimeoutError`) or while reading the body (`TimeoutError`). */
export function isRequestTimeout(error: unknown): boolean {
  return error instanceof RequestTimeoutError || (error instanceof DOMException && error.name === "TimeoutError");
}

/**
 * Fetch with a hard deadline while preserving an optional caller abort signal.
 * The combined signal stays attached to the response, so the deadline and caller
 * cancellation also bound body consumption.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = API_REQUEST_TIMEOUT_MS,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  try {
    return await fetchImpl(input, { ...init, signal });
  } catch (error: unknown) {
    if (deadline.aborted) throw new RequestTimeoutError(timeoutMs);
    throw error;
  }
}
