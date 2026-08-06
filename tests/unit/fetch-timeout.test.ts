import { describe, expect, test } from "bun:test";
import { fetchWithTimeout, RequestTimeoutError } from "../../public/fetch-timeout";

function abortAwareFetch(signalSeen: (signal: AbortSignal) => void): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    signalSeen(signal);
    const rejectAbort = (): void => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  })) as typeof fetch;
}

describe("fetchWithTimeout", () => {
  test("aborts a hung request at its deadline with a typed error", async () => {
    const seen: { signal: AbortSignal | null } = { signal: null };
    const request = fetchWithTimeout("/api/sessions", {}, 5, abortAwareFetch(signal => { seen.signal = signal; }));

    await expect(request).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(seen.signal?.aborted).toBe(true);
  });

  test("preserves caller cancellation instead of reporting a timeout", async () => {
    const caller = new AbortController();
    const request = fetchWithTimeout("/api/sessions", { signal: caller.signal }, 1_000, abortAwareFetch(() => {}));
    caller.abort(new Error("navigation changed"));

    await expect(request).rejects.toHaveProperty("name", "AbortError");
  });
});
