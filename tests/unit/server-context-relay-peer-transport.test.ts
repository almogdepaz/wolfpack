import { expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as configModule from "../../src/config.ts";
import { createServerContext, type ServerContext } from "../../src/server/context.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";
import { createVolatileRelayRoutes } from "../../src/server/volatile-relay-routes.ts";
import { RELAY_ID } from "../../src/task-relay/domain.ts";
import { VOLATILE_PEER_PATH, VOLATILE_RELAY_PATH } from "../../src/task-relay/volatile-protocol.ts";
import type { RelayGateway } from "../../src/task-relay/worker-protocol.ts";

const config = { devDir: "/fixture", port: 18899, tailscaleHostname: "one.example.ts.net" };
const epoch = "11111111-1111-4111-8111-111111111111";
const peerBody = { operation: "receivePeer", profile: "volatile-v1", epoch,
  sourceEpoch: "22222222-2222-4222-8222-222222222222", origin: "https://unused.example.ts.net" };
const resolveBody = { profile: "volatile-v1", epoch, callerSession: "caller",
  endpoint: { relay: RELAY_ID, id: epoch }, target: { relay: RELAY_ID, id: epoch }, origin: peerBody.origin };

function inertGateway(): RelayGateway {
  const unexpected = async (): Promise<never> => { throw new Error("unexpected gateway operation"); };
  return {
    root: "/fixture", profile: "volatile-v1", initialize: async () => {}, close: async () => {},
    volatileEpoch: async () => epoch,
    // Route admission only checks owner.ok; transport authorization must fail before dispatch.
    volatile: async () => ({ ok: true, profile: "volatile-v1", epoch, value: { kind: "disconnected" } }),
    volatilePeer: unexpected, volatileTopology: unexpected, hostEnvelope: unexpected,
    registrationsForSessions: unexpected, endpointForSession: unexpected, endpointsForSessions: unexpected,
  };
}

async function serve(context: ServerContext) {
  const routes = createVolatileRelayRoutes(context);
  const server = createServer((req, res) => { void routes[`POST ${req.url}`]!(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    post: (path: string, body: unknown) => fetch(base + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

for (const shared of [false, true]) {
  test(`${shared ? "shared" : "distinct"} gateway contexts use their own relay status reader`, async () => {
    const loadConfig = spyOn(configModule, "loadConfig").mockReturnValue(config);
    const calls = [0, 0];
    const firstGateway = inertGateway();
    const contexts = [firstGateway, shared ? firstGateway : inertGateway()].map((taskRelayGateway, index) =>
      createServerContext({ backend: new MockBackend(), config, taskRelayGateway,
        // Stop before topology authorization can make any network request.
        readTailscaleStatus: async () => { calls[index]!++; throw new Error("reader stop"); },
      }));
    const servers: Awaited<ReturnType<typeof serve>>[] = [];
    try {
      for (const context of contexts) servers.push(await serve(context));
      for (const server of servers) {
        const response = await server.post(VOLATILE_PEER_PATH, peerBody);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: "PEER_POLICY_REQUIRED" } });
      }
      console.log(JSON.stringify({ shared, calls }));
      expect(calls).toEqual([1, 1]);
    } finally {
      for (const server of servers) await server.close();
      for (const context of contexts) await context.close();
      loadConfig.mockRestore();
    }
  });
}

test("same-owner route factories reuse the eight-slot transport bound", async () => {
  const loadConfig = spyOn(configModule, "loadConfig").mockReturnValue(config);
  let reads = 0, release!: () => void, ready!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const admitted = new Promise<void>(resolve => { ready = resolve; });
  const context = createServerContext({ backend: new MockBackend(), config, taskRelayGateway: inertGateway(),
    readTailscaleStatus: async () => {
      if (++reads === 8) ready();
      await blocked;
      throw new Error("reader stop");
    },
  });
  const servers: Awaited<ReturnType<typeof serve>>[] = [];
  const pending: Promise<Response>[] = [];
  try {
    servers.push(await serve(context), await serve(context));
    for (let index = 0; index < 8; index++) {
      pending.push(servers[index % 2]!.post(VOLATILE_RELAY_PATH + "/resolve-peer", resolveBody));
    }
    await admitted;
    const excess = await servers[0]!.post(VOLATILE_PEER_PATH, peerBody);
    expect(excess.status).toBe(503);
    expect(await excess.json()).toMatchObject({ error: { code: "RELAY_CAPACITY" } });
    expect(reads).toBe(8);
    const transport = context.relayPeerTransport;
    expect(context.relayPeerTransport).toBe(transport);
    await expect(transport.forward("https://unused.example.ts.net" + VOLATILE_PEER_PATH, {
      method: "POST", body: JSON.stringify(peerBody),
    })).rejects.toMatchObject({ code: "RELAY_CAPACITY" });
    expect(reads).toBe(8);
    release();
    for (const response of await Promise.all(pending)) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "PEER_POLICY_REQUIRED" } });
    }
    expect(reads).toBe(8);
  } finally {
    release();
    await Promise.all(pending);
    for (const server of servers) await server.close();
    await context.close();
    loadConfig.mockRestore();
  }
});
