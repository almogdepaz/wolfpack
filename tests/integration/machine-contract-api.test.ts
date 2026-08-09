import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.WOLFPACK_TEST = "1";
delete process.env.WOLFPACK_JWT_SECRET;

const testRoot = join(tmpdir(), `wolfpack-machine-contract-${process.pid}`);
mkdirSync(testRoot, { recursive: true });
process.env.WOLFPACK_DEV_DIR = testRoot;
process.env.WOLFPACK_SETTINGS_PATH = join(testRoot, "bridge-settings.json");
process.env.WOLFPACK_MACHINE_ID_PATH = join(testRoot, "machine-id");
const priorTailscaleStatus = process.env.WOLFPACK_TAILSCALE_STATUS_JSON;
const defaultTailscaleStatus = JSON.stringify({
  Self: {
    ID: "n-local",
    DNSName: "local.example.ts.net.",
    HostName: "local",
    UserID: 123,
    TailscaleIPs: ["100.64.0.1"],
  },
  Peer: {
    "n-peer": {
      ID: "n-peer",
      DNSName: "peer.example.ts.net.",
      HostName: "peer",
      Online: true,
      TailscaleIPs: ["100.64.0.2"],
    },
    "n-offline": {
      ID: "n-offline",
      DNSName: "offline.example.ts.net.",
      HostName: "offline",
      Online: false,
    },
  },
});
process.env.WOLFPACK_TAILSCALE_STATUS_JSON = defaultTailscaleStatus;

const { __resetJwtAuthConfig, __setDevDir } = await import("../../src/test-hooks.ts");
const { __setTestBackend } = await import("../../src/server/backend.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
__resetJwtAuthConfig();
__setDevDir(testRoot);
__setTestBackend(new MockBackend({ sessions: [] }));

const {
  createServerInstance,
  __globalRateLimiter,
  __pollRateLimiter,
} = await import("../../src/server/index.ts");
const { server } = createServerInstance();
let base = "";

beforeAll(async () => {
  __pollRateLimiter._map.clear();
  __globalRateLimiter._map.clear();
  await new Promise<void>((resolve) => {
    (server as Server).listen(0, "127.0.0.1", () => {
      const port = ((server as Server).address() as AddressInfo).port;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(() => {
  (server as Server).close();
  __pollRateLimiter._map.clear();
  __globalRateLimiter._map.clear();
  if (priorTailscaleStatus === undefined) delete process.env.WOLFPACK_TAILSCALE_STATUS_JSON;
  else process.env.WOLFPACK_TAILSCALE_STATUS_JSON = priorTailscaleStatus;
  rmSync(testRoot, { recursive: true, force: true });
});

describe("direct machine contract routes", () => {
  test("serves a no-store, non-sensitive Tailnet handshake", async () => {
    const response = await fetch(`${base}/api/machine`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const handshake = await response.json();
    expect(handshake).toMatchObject({
      protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
      machine: {
        tailnetNodeId: "n-local",
        displayName: "local",
        origin: "https://local.example.ts.net",
      },
      wolfpack: { version: expect.any(String) },
      capabilities: ["sessions", "terminal-websocket", "push-subscription"],
    });
    expect(handshake.machine.installationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(handshake).not.toHaveProperty("tailscaleIPs");
    expect(handshake).not.toHaveProperty("userId");
    expect(handshake).not.toHaveProperty("sessions");
  });

  test("enumerates only canonical local Tailnet candidate facts without probing peers", async () => {
    const response = await fetch(`${base}/api/tailnet/v1/candidates`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      candidates: [
        {
          hostname: "peer.example.ts.net",
          tailnetNodeId: "n-peer",
          origin: "https://peer.example.ts.net",
          online: true,
        },
        {
          hostname: "offline.example.ts.net",
          tailnetNodeId: "n-offline",
          origin: "https://offline.example.ts.net",
          online: false,
        },
      ],
    });
  });

  test("keeps legacy discovery wire-compatible as an online-only facade", async () => {
    const response = await fetch(`${base}/api/discover`);

    expect(response.status).toBe(200);
    expect(response.headers.get("deprecation")).toBe("true");
    expect(response.headers.get("link")).toContain("</api/tailnet/v1/candidates>; rel=\"successor-version\"");
    expect(await response.json()).toEqual({
      peers: [{
        hostname: "peer.example.ts.net",
        url: "https://peer.example.ts.net",
        name: "peer.example.ts.net",
      }],
    });
  });

  test("reports invalid local Tailnet status but preserves a valid empty peer set", async () => {
    const validSelf = { ID: "n-local", DNSName: "local.example.ts.net." };
    const paths = [
      {
        path: "/api/tailnet/v1/candidates",
        invalid: { candidates: [], error: "failed to query tailscale" },
        empty: { candidates: [] },
      },
      {
        path: "/api/discover",
        invalid: { peers: [], error: "failed to query tailscale" },
        empty: { peers: [] },
      },
    ] as const;
    try {
      for (const status of [
        null,
        {},
        { Self: null, Peer: {} },
        { Self: { ...validSelf, ID: "" }, Peer: {} },
        { Self: validSelf, Peer: [] },
      ]) {
        process.env.WOLFPACK_TAILSCALE_STATUS_JSON = JSON.stringify(status);
        for (const route of paths) {
          const response = await fetch(`${base}${route.path}`);
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual(route.invalid);
        }
        __pollRateLimiter._map.clear();
        __globalRateLimiter._map.clear();
      }

      process.env.WOLFPACK_TAILSCALE_STATUS_JSON = JSON.stringify({ Self: validSelf, Peer: {} });
      for (const route of paths) {
        const response = await fetch(`${base}${route.path}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(route.empty);
      }
    } finally {
      process.env.WOLFPACK_TAILSCALE_STATUS_JSON = defaultTailscaleStatus;
    }
  });
});
