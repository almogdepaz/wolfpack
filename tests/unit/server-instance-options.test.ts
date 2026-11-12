import { expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { createServerContext } from "../../src/server/context.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";
import { createServerInstance } from "../../src/server/index.ts";
import { readLocalTailscaleStatus } from "../../src/server/tailscale-status.ts";

for (const allowLocalOrigins of [undefined, true]) {
  test(`local origins are ${allowLocalOrigins ? "explicitly allowed" : "restricted by default"}`, async () => {
    const ctx = createServerContext({ backend: new MockBackend(), config: null });
    const { server, wss } = createServerInstance(ctx, { allowLocalOrigins });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/info`, {
        headers: { Origin: "http://127.0.0.1:54321" },
      });
      expect(response.status).toBe(allowLocalOrigins ? 200 : 403);
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      wss.close(); await ctx.close();
    }
  });
}

test("context status reader defaults to the real cache and routes use an explicit reader", async () => {
  const defaultContext = createServerContext({ backend: new MockBackend(), config: null });
  expect(defaultContext.readTailscaleStatus).toBe(readLocalTailscaleStatus);
  const reads: boolean[] = [];
  const ctx = createServerContext({ backend: new MockBackend(), config: null,
    readTailscaleStatus: async (selfOnly = false) => {
      reads.push(selfOnly);
      return { Self: { ID: "n-explicit", DNSName: "explicit.example.ts.net.", HostName: "explicit" }, Peer: {} };
    },
  });
  const { server, wss } = createServerInstance(ctx);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/api/machine`)).status).toBe(200);
    expect((await fetch(`${base}/api/tailnet/v1/candidates`)).status).toBe(200);
    expect(reads).toContain(true);
    expect(reads).toContain(false);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    wss.close(); await ctx.close(); await defaultContext.close();
  }
});

test("instance quotas do not share maps or reservations", () => {
  const ctx = createServerContext({ backend: new MockBackend(), config: null });
  const first = createServerInstance(ctx), second = createServerInstance(ctx);
  try {
    for (let i = 0; i < 10; i++) expect(first.pollRateLimiter.allow("client")).toBe(true);
    expect(first.pollRateLimiter.allow("client")).toBe(false);
    expect(second.pollRateLimiter.allow("client")).toBe(true);
    for (let i = 0; i < 32; i++) expect(first.reserveWsConnection("client")).toBe(true);
    expect(first.reserveWsConnection("client")).toBe(false);
    expect(second.reserveWsConnection("client")).toBe(true);
    expect(second.wsConnectionsByIp.get("client")).toBe(1);
  } finally { first.wss.close(); second.wss.close(); }
});
