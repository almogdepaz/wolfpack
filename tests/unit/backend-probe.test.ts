import { describe, expect, test } from "bun:test";
import { probeBackendStatus } from "../../public/backend-probe";

const never = <T>(): Promise<T> => new Promise<T>(() => {});

function stalledBodyResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"brokerReady":')); },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("probeBackendStatus", () => {
  test("a network failure is unreachable", async () => {
    expect(await probeBackendStatus("/api/backend", async () => { throw new TypeError("failed to fetch"); }, 50))
      .toEqual({ kind: "unreachable" });
  });

  test("no response before the deadline is unreachable and aborts the request", async () => {
    let signal: AbortSignal | undefined;
    const result = await probeBackendStatus("/api/backend", (_url, init) => { signal = init.signal; return never(); }, 30);
    expect(result).toEqual({ kind: "unreachable" });
    expect(signal?.aborted).toBe(true);
  });

  test("a body that stalls past the deadline still counts as a responding server", async () => {
    let signal: AbortSignal | undefined;
    const startedAt = Date.now();
    const result = await probeBackendStatus("/api/backend", async (_url, init) => { signal = init.signal; return stalledBodyResponse(); }, 30);
    expect(result).toEqual({ kind: "responded" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(signal?.aborted).toBe(true);
  });

  test("reads broker readiness from a complete answer", async () => {
    const result = await probeBackendStatus(
      "/api/backend",
      async () => Response.json({ error: "broker unavailable", brokerReady: false }, { status: 503 }),
      1_000,
    );
    expect(result).toEqual({ kind: "responded", brokerReady: false });
  });
});
