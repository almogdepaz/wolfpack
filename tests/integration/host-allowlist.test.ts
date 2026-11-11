import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const priorEnv = {
  WOLFPACK_TEST: process.env.WOLFPACK_TEST,
  WOLFPACK_JWT_SECRET: process.env.WOLFPACK_JWT_SECRET,
  WOLFPACK_TAILSCALE_STATUS_JSON: process.env.WOLFPACK_TAILSCALE_STATUS_JSON,
};
process.env.WOLFPACK_TEST = "1";
delete process.env.WOLFPACK_JWT_SECRET;
process.env.WOLFPACK_TAILSCALE_STATUS_JSON = JSON.stringify({
  Self: {
    ID: "n-host",
    DNSName: "workstation.tailnet.ts.net.",
    HostName: "Workstation",
    TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"],
  },
  Peer: {},
});

const root = mkdtempSync(join(tmpdir(), "wolfpack-host-allowlist-"));
const { getJwtAuthConfig } = await import("../../src/auth.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
const { EventBus } = await import("../../src/event-bus.ts");
const { createServerContext } = await import("../../src/server/context.ts");
const { classifyRequestClient } = await import("../../src/server/operability.ts");

const {
  createServerInstance, __globalRateLimiter, __wsUpgradeRateLimiter,
  __wsConnectionsByIp, MAX_WS_CONNECTIONS_PER_IP,
} = await import("../../src/server/index.ts");
const context = createServerContext({ jwtAuthConfig: getJwtAuthConfig(),
  backend: new MockBackend({ sessions: [] }),
  events: new EventBus(),
  config: null,
  taskRoot: join(root, "tasks"),
  taskRelayRoot: join(root, "task-relay"),
});
const { server, wss } = createServerInstance(context);
let port = 0;

beforeAll(async () => {
  __globalRateLimiter._map.clear();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  wss.close();
  __globalRateLimiter._map.clear();
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(priorEnv)) {
    if (key === "WOLFPACK_TEST") continue;
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  if (priorEnv.WOLFPACK_TEST === undefined) delete process.env.WOLFPACK_TEST;
  else process.env.WOLFPACK_TEST = priorEnv.WOLFPACK_TEST;
});

function rawRequest(request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let received = "";
    socket.setTimeout(2000, () => socket.destroy(new Error("HTTP response timed out")));
    socket.once("connect", () => socket.write(request));
    socket.on("data", chunk => { received += chunk.toString(); });
    socket.once("end", () => resolve(received));
    socket.once("error", reject);
  });
}

describe("Host allowlist", () => {
  test("rejects a foreign Host without Origin", async () => {
    const response = await rawRequest("GET /api/info HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n");
    expect(response).toMatch(/^HTTP\/1\.1 403 /);
    expect(response).toContain(JSON.stringify({ error: "host not allowed" }));
  });

  test.each([
    "localhost", "workstation.tailnet.ts.net", "Workstation.tailnet.ts.net.", "workstation",
    "100.64.0.1", "[fd7a:115c:a1e0::1]", "[FD7A:115C:A1E0:0:0:0:0:1]:443", "[::1]",
  ])("accepts the local Host %s", async host => {
    const response = await rawRequest(`GET /api/info HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    expect(response).toMatch(/^HTTP\/1\.1 200 /);
  });

  test("accepts the loopback address with the listening port", async () => {
    const response = await rawRequest(`GET /api/info HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    expect(response).toMatch(/^HTTP\/1\.1 200 /);
  });

  test("rejects a missing Host on HTTP/1.0", async () => {
    const response = await rawRequest("GET /api/info HTTP/1.0\r\n\r\n");
    expect(response).toMatch(/^HTTP\/1\.[01] 403 /);
    expect(response).toContain(JSON.stringify({ error: "host not allowed" }));
  });

  test("rejects a foreign WebSocket Host before reserving a connection slot", async () => {
    const clientKey = classifyRequestClient({ remoteAddress: "127.0.0.1", tailscaleUserLogin: undefined }).clientKey;
    const priorConnections = __wsConnectionsByIp.get(clientKey);
    __wsUpgradeRateLimiter._map.clear();
    __wsConnectionsByIp.set(clientKey, MAX_WS_CONNECTIONS_PER_IP);
    try {
      const response = await rawRequest(
        "GET /ws/pty?session=x HTTP/1.1\r\nHost: evil.example\r\n"
        + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
      expect(response).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
      expect(__wsConnectionsByIp.get(clientKey)).toBe(MAX_WS_CONNECTIONS_PER_IP);
    } finally {
      if (priorConnections === undefined) __wsConnectionsByIp.delete(clientKey);
      else __wsConnectionsByIp.set(clientKey, priorConnections);
      __wsUpgradeRateLimiter._map.clear();
    }
  });
});
