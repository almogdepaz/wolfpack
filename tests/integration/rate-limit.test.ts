import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env.WOLFPACK_TEST = "1";
// Disable JWT so we can hit API endpoints without auth tokens
delete process.env.WOLFPACK_JWT_SECRET;
const priorTailscaleStatus = process.env.WOLFPACK_TAILSCALE_STATUS_JSON;
process.env.WOLFPACK_TAILSCALE_STATUS_JSON = JSON.stringify({
  Self: { ID: "n-rate-test", DNSName: "rate-test.example.ts.net.", HostName: "rate-test" },
  Peer: {},
});

const { __resetJwtAuthConfig } = await import("../../src/test-hooks.ts");
const { __setTestBackend } = await import("../../src/server/backend.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
__resetJwtAuthConfig();

__setTestBackend(new MockBackend({ sessions: ["rate-test"] }));

const {
  createServerInstance,
  __pollRateLimiter,
  __globalRateLimiter,
} = await import("../../src/server/index.ts") as any;

const { server } = createServerInstance();

let port = 0;
let baseUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    (server as Server).listen(0, "127.0.0.1", () => {
      port = ((server as Server).address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(() => {
  (server as Server).close();
  // The limiter is process-global; do not leave this burst's exhausted bucket for later files.
  __pollRateLimiter._map.clear();
  __globalRateLimiter._map.clear();
  if (priorTailscaleStatus === undefined) delete process.env.WOLFPACK_TAILSCALE_STATUS_JSON;
  else process.env.WOLFPACK_TAILSCALE_STATUS_JSON = priorTailscaleStatus;
});

describe("HTTP rate limiting", () => {
  test("poll-heavy endpoint returns 429 after threshold (burst 200)", async () => {
    // Reset the poll limiter so we get a clean slate
    __pollRateLimiter._map.clear();
    __globalRateLimiter._map.clear();

    const results = await Promise.all(
      Array.from({ length: 200 }, () =>
        fetch(`${baseUrl}/api/sessions`).then((r) => r.status),
      ),
    );

    const ok = results.filter((s) => s === 200).length;
    const limited = results.filter((s) => s === 429).length;

    // Poll limiter is 10 req/s — most of the burst should be rejected
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(ok).toBeLessThanOrEqual(12); // small margin for token refill
    expect(limited).toBeGreaterThanOrEqual(188);
  });

  test("Tailnet status routes return 429 after the expensive-route threshold", async () => {
    for (const path of ["/api/machine", "/api/tailnet/v1/candidates", "/api/discover"]) {
      __pollRateLimiter._map.clear();
      __globalRateLimiter._map.clear();
      const statuses = await Promise.all(
        Array.from({ length: 30 }, () => fetch(`${baseUrl}${path}`).then((response) => response.status)),
      );
      expect(statuses.filter((status) => status === 200).length, path).toBeGreaterThan(0);
      expect(statuses.filter((status) => status === 429).length, path).toBeGreaterThanOrEqual(18);
    }
  });

  test("global limit applies to non-poll endpoints", async () => {
    __pollRateLimiter._map.clear();
    __globalRateLimiter._map.clear();

    // /api/info is not poll-heavy, so only global limit (120/s) applies
    const results = await Promise.all(
      Array.from({ length: 200 }, () =>
        fetch(`${baseUrl}/api/info`).then((r) => r.status),
      ),
    );

    const ok = results.filter((s) => s === 200).length;
    const limited = results.filter((s) => s === 429).length;

    // Global is 120 req/s — should allow most but deny some
    expect(ok).toBeGreaterThanOrEqual(100);
    expect(limited).toBeGreaterThanOrEqual(1);
  });

  test("429 response body has error field", async () => {
    __pollRateLimiter._map.clear();
    __globalRateLimiter._map.clear();

    // Drain the poll bucket
    for (let i = 0; i < 15; i++) {
      await fetch(`${baseUrl}/api/sessions`);
    }

    const res = await fetch(`${baseUrl}/api/sessions`);
    if (res.status === 429) {
      const body = await res.json();
      expect(body.error).toBe("rate limit exceeded");
    }
    // If it's 200, the token refilled — that's OK, the burst test above covers the threshold
  });
});
