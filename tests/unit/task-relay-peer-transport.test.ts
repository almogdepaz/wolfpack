import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { RelayPeerTransport } from "../../src/task-relay/peer-transport.ts";
import { relayPeerTopology } from "../../src/task-relay/peer-topology.ts";
import { trustedRelayClient } from "../../src/server/relay-peer-transport.ts";
import { VOLATILE_PEER_PATH } from "../../src/task-relay/volatile-protocol.ts";
const origin = (id: string) => `https://${id}.tail123.ts.net`;
const node = (id: string, user = 1) => ({ ID: `node-${id}`, DNSName: `${id}.tail123.ts.net.`, Online: true, UserID: user });
const status = () => ({ BackendState: "Running", Self: node("a"), Peer: { b: node("b"), guest: node("guest", 2), tagged: { ...node("tagged"), Tags: ["tag:server"] }, offline: { ...node("offline"), Online: false } } });
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

test("honest Tailnet topology accepts other users/tags, excludes offline and ambiguous routing", () => {
  expect(relayPeerTopology(status(), origin("a")).peers).toEqual(new Map([[origin("b"), "node-b"], [origin("guest"), "node-guest"], [origin("tagged"), "node-tagged"]]));
  for (const Self of [{ ...node("a"), UserID: 0 }, { ...node("a"), Tags: ["tag:server"] }, { ...node("a"), UserID: undefined }]) {
    expect(relayPeerTopology({ ...status(), Self }, origin("a")).peers.size).toBe(3);
  }
  expect(() => relayPeerTopology({ ...status(), Self: { ...node("a"), Online: false } }, origin("a"))).toThrow();
  expect(() => relayPeerTopology(status(), origin("wrong"))).toThrow();
  expect(() => relayPeerTopology({ ...status(), BackendState: "Stopped" }, origin("a"))).toThrow();
  expect(relayPeerTopology({ ...status(), Peer: { ...status().Peer, clone: { ...node("b"), ID: "another-node" } } }, origin("a")).peers.has(origin("b"))).toBe(false);
});

test("network boundary rejects public/Funnel and arbitrary forwarded headers, not ordinary owner APIs", () => {
  for (const address of ["127.0.0.1", "::1", "100.64.0.1", "100.127.255.254", "::ffff:100.100.1.2", "fd7a:115c:a1e0::1"]) expect(trustedRelayClient(address, undefined)).toBe(true);
  for (const address of [undefined, "203.0.113.1", "192.168.1.2", "100.63.255.255", "100.128.0.1", "fd7a:115c:a1e1::1"]) expect(trustedRelayClient(address, "100.100.1.1")).toBe(false);
  expect(trustedRelayClient("127.0.0.1", "100.100.1.2")).toBe(true);
  for (const forwarded of ["203.0.113.1", "100.100.1.1, 127.0.0.1", ["100.100.1.1"], "garbage", ""]) expect(trustedRelayClient("127.0.0.1", forwarded)).toBe(false);
});

function pair(jwt?: string) {
  let aEpoch = randomUUID(), bEpoch = randomUUID(), trusted = true;
  const calls: string[] = [], frames: string[] = [];
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push(url.href);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(jwt ? `Bearer ${jwt}` : null);
    expect(new Headers(init?.headers).has("x-wolfpack-relay-signature")).toBe(false);
    if (url.pathname === "/api/task-relay/profile") return Response.json({ ok: true, profile: "volatile-v1", epoch: url.origin === origin("a") ? aEpoch : bEpoch });
    expect(url.href).toBe(origin("b") + VOLATILE_PEER_PATH);
    const raw = String(init?.body); frames.push(raw); await b.verify(raw);
    return Response.json({ accepted: true });
  }, { preconnect: fetch.preconnect }) as typeof fetch;
  const a = new RelayPeerTransport({ topology: async () => ({ origin: origin("a"), nodeId: "node-a", peers: new Map(trusted ? [[origin("b"), "node-b"]] : []) }), epoch: async () => aEpoch, fetch: fetcher, jwt: () => jwt ?? null });
  const b = new RelayPeerTransport({ topology: async () => ({ origin: origin("b"), nodeId: "node-b", peers: new Map(trusted ? [[origin("a"), "node-a"]] : []) }), epoch: async () => bEpoch, fetch: fetcher, jwt: () => jwt ?? null });
  const body = () => ({ operation: "receivePeer", profile: "volatile-v1", epoch: bEpoch, sourceEpoch: aEpoch, origin: origin("a"), envelope: { immutable: "opaque" } });
  return { a, b, body, calls, frames, revoke: () => { trusted = false; }, rotateSource: () => { aEpoch = randomUUID(); }, rotateTarget: () => { bEpoch = randomUUID(); } };
}
for (const jwt of [undefined, "optional-owner-token"]) test(`peer forwarding needs no signature or new JWT scheme (owner auth=${!!jwt})`, async () => {
  const f = pair(jwt), raw = JSON.stringify(f.body());
  expect(await (await f.a.forward(origin("b") + VOLATILE_PEER_PATH, { method: "POST", body: raw })).json()).toEqual({ accepted: true });
  expect(f.frames).toEqual([raw]); expect(f.calls.some(path => path.endsWith("/identity"))).toBe(false);
  f.rotateSource(); expect(await failure(f.b.verify(raw))).toMatchObject({ code: "PEER_POLICY_REQUIRED" });
  f.rotateTarget(); expect(await failure(f.b.verify(raw))).toMatchObject({ code: "PEER_POLICY_REQUIRED" });
});

test("wrong origins, paths, epochs and revoked routes cannot dispatch a peer body", async () => {
  const f = pair(), raw = JSON.stringify(f.body());
  for (const target of [origin("unknown") + VOLATILE_PEER_PATH, origin("b") + "/wrong", origin("b") + VOLATILE_PEER_PATH + "?x", "http://b.tail123.ts.net" + VOLATILE_PEER_PATH]) {
    expect(await failure(f.a.forward(target, { method: "POST", body: raw }))).toMatchObject({ code: "PEER_POLICY_REQUIRED" });
  }
  expect(f.calls).toEqual([]);
  expect(await failure(f.a.forward(origin("b") + VOLATILE_PEER_PATH, { method: "POST", body: JSON.stringify({ ...f.body(), epoch: randomUUID() }) }))).toMatchObject({ code: "PEER_POLICY_REQUIRED" });
  expect(f.frames).toEqual([]); f.revoke();
  expect(await failure(f.a.forward(origin("b") + VOLATILE_PEER_PATH, { method: "POST", body: raw }))).toMatchObject({ code: "PEER_POLICY_REQUIRED" });
});

test("bounded admission and caller abort release slots without fetching after a stalled topology resumes", async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(r => { release = r; }), epoch = randomUUID();
  const transport = new RelayPeerTransport({ topology: async () => { await gate; return { origin: origin("a"), nodeId: "a", peers: new Map([[origin("b"), "b"]]) }; }, epoch: async () => epoch,
    fetch: Object.assign(async () => { calls++; return Response.json({ ok: true, profile: "volatile-v1", epoch }); }, { preconnect: fetch.preconnect }) as typeof fetch });
  const controller = new AbortController();
  const body = JSON.stringify({ operation: "receivePeer", profile: "volatile-v1", origin: origin("a"), sourceEpoch: epoch, epoch });
  const pending = Array.from({ length: 8 }, () => failure(transport.forward(origin("b") + VOLATILE_PEER_PATH, { method: "POST", body, signal: controller.signal })));
  expect(await failure(transport.peer(origin("b")))).toMatchObject({ code: "RELAY_CAPACITY" });
  controller.abort(); expect((await Promise.all(pending)).every(value => value instanceof Error)).toBe(true);
  release(); await new Promise(r => setTimeout(r, 10)); expect(calls).toBe(0);
  expect(await transport.peer(origin("b"))).toEqual({ origin: origin("b"), epoch }); expect(calls).toBe(1);
});
