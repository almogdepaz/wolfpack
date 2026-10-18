import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { fetchWithTimeout, isRequestTimeout, RequestTimeoutError } from "../../public/fetch-timeout";

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

async function withStalledBody(check: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"sessions":[');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test listener");
  try {
    await check(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function expectBodyAbort(response: Response): Promise<unknown> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      response.text().then(() => ({ kind: "completed" }), (error: unknown) => ({ kind: "aborted", error })),
      new Promise<{ kind: string }>(resolve => { watchdog = setTimeout(() => resolve({ kind: "stalled" }), 500); }),
    ]);
    expect(outcome.kind).toBe("aborted");
    return "error" in outcome ? outcome.error : undefined;
  } finally {
    clearTimeout(watchdog);
  }
}

describe("fetchWithTimeout", () => {
  test("deadline remains active while consuming a stalled response body", async () => {
    await withStalledBody(async url => {
      const response = await fetchWithTimeout(url, {}, 50);
      expect(response.status).toBe(200);
      expect(isRequestTimeout(await expectBodyAbort(response))).toBe(true);
    });
  });

  test("caller cancellation reaches the body after headers arrive", async () => {
    await withStalledBody(async url => {
      const caller = new AbortController();
      const response = await fetchWithTimeout(url, { signal: caller.signal }, 5_000);
      caller.abort(new Error("navigation changed"));
      expect(isRequestTimeout(await expectBodyAbort(response))).toBe(false);
    });
  });
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
