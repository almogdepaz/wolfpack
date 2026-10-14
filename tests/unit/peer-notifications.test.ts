import { expect, test } from "bun:test";
import { buildMachineHandshake } from "../../src/tailnet-machine-contract.ts";
const origin = "https://peer.test.ts.net";
const handshake = buildMachineHandshake({ tailscaleHostname: "peer.test.ts.net", tailscaleNodeId: "n123", installationId: "12345678-1234-4234-8234-123456789abc", displayName: "peer", version: "1.0.0" });
const topology = { origin: "https://home.test.ts.net", nodeId: "home", peers: new Map([[origin, "n123"]]) };

test("ready trusted peers expose only their reported facts with authenticated canonical requests", async () => {
  const { observePeerNotifications } = await import("../../src/server/peer-notifications.ts");
  const calls: string[] = [];
  const result = await observePeerNotifications({ topology: async () => topology, jwt: () => "token", fetch: async (input, init) => {
    calls.push(String(input));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
    expect(init?.redirect).toBe("error");
    return Response.json(String(input).endsWith("/api/machine") ? handshake : { sessions: [{ name: "agent", identity: { wolfpackSessionId: "id" } }] });
  } });
  expect(calls).toEqual([origin + "/api/machine", origin + "/api/sessions"]);
  expect(result).toHaveLength(1);
  expect(result[0].machine.identity).toBe("n123:12345678-1234-4234-8234-123456789abc");
  expect(result[0].sessions[0].quietAlert).toBeUndefined();
});

test("offline peers are not fetched and failures/timeouts do not discard healthy peers", async () => {
  const { observePeerNotifications } = await import("../../src/server/peer-notifications.ts");
  expect(await observePeerNotifications({ topology: async () => ({ ...topology, peers: new Map() }), fetch: async () => { throw new Error("offline must not fetch"); } })).toEqual([]);
  const peers = new Map([["https://bad.test.ts.net", "bad"], ...topology.peers]);
  const result = await observePeerNotifications({ topology: async () => ({ ...topology, peers }), timeoutMs: 10, fetch: async input => {
    if (String(input).includes("bad.test")) return new Promise(() => {});
    return Response.json(String(input).endsWith("/api/machine") ? handshake : { sessions: [] });
  } });
  expect(result).toHaveLength(1);
});

test("topology replacement during a fetch fails closed", async () => {
  const { observePeerNotifications } = await import("../../src/server/peer-notifications.ts");
  let reads = 0;
  const result = await observePeerNotifications({ topology: async () => (++reads === 1 ? topology : { ...topology, peers: new Map() }), fetch: async input => Response.json(String(input).endsWith("/api/machine") ? handshake : { sessions: [] }) });
  expect(result).toEqual([]);
});

test("a peer cannot replace the topology-authorized machine identity", async () => {
  const { observePeerNotifications } = await import("../../src/server/peer-notifications.ts");
  let sessionRequests = 0;
  const result = await observePeerNotifications({ topology: async () => topology, fetch: async input => {
    if (String(input).endsWith("/api/sessions")) sessionRequests++;
    return Response.json({ ...handshake, machine: { ...handshake!.machine, tailnetNodeId: "other" } });
  } });
  expect(result).toEqual([]);
  expect(sessionRequests).toBe(0);
});

test("peer reads use at most four concurrent requests", async () => {
  const { observePeerNotifications } = await import("../../src/server/peer-notifications.ts");
  const peers = new Map(Array.from({ length: 9 }, (_, i) => [`https://peer${i}.test.ts.net`, `n${i}`]));
  let active = 0, maximum = 0;
  const result = await observePeerNotifications({ topology: async () => ({ ...topology, peers }), fetch: async input => {
    active++; maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
    const url = new URL(input);
    return Response.json(url.pathname === "/api/machine" ? buildMachineHandshake({ tailscaleHostname: url.hostname, tailscaleNodeId: peers.get(url.origin), installationId: handshake!.machine.installationId, displayName: "peer", version: "1.0.0" }) : { sessions: [] });
  } });
  expect(result).toHaveLength(9);
  expect(maximum).toBeLessThanOrEqual(4);
  expect(maximum).toBeGreaterThan(1);
});
