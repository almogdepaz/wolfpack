import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { RelayPeerAuth, RELAY_PEER_IDENTITY_PATH, RELAY_PEER_SIGNATURE_HEADER } from "../../src/task-relay/peer-auth.ts";
import { relayPeerTopology } from "../../src/task-relay/peer-topology.ts";
import { VOLATILE_PEER_PATH } from "../../src/task-relay/volatile-protocol.ts";

const origin = (id: string) => `https://${id}.tail123.ts.net`;
const node = (id: string, user = 1) => ({ ID: `node-${id}`, DNSName: `${id}.tail123.ts.net.`, Online: true, UserID: user });
function status() { return { BackendState: "Running", Self: node("a"), Peer: { b: node("b"), guest: node("guest", 2), tagged: { ...node("tagged"), Tags: ["tag:server"] }, offline: { ...node("offline"), Online: false } } }; }

test("relay trust comes from local same-user online untagged topology, never merely candidate membership", () => {
  expect(relayPeerTopology(status(), origin("a"))).toEqual({ origin: origin("a"), nodeId: "node-a", peers: new Map([[origin("b"), "node-b"]]) });
  for (const Self of [{ ...node("a"), UserID: 0 }, { ...node("a"), Tags: ["tag:server"] }, { ...node("a"), Online: false }, { ...node("a"), UserID: undefined }]) {
    expect(() => relayPeerTopology({ ...status(), Self }, origin("a"))).toThrow();
  }
  expect(() => relayPeerTopology(status(), origin("wrong"))).toThrow();
  expect(() => relayPeerTopology({ ...status(), BackendState: "Stopped" }, origin("a"))).toThrow();
  const ambiguous = status(); (ambiguous.Peer as any).clone = { ...node("b"), ID: "another-node" };
  expect(relayPeerTopology(ambiguous, origin("a")).peers.has(origin("b"))).toBe(false);
});

function pair() {
  let aEpoch = randomUUID(), bEpoch = randomUUID(), trusted = true;
  const calls: string[] = [], frames: Array<{ raw: string; signature: string }> = [];
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push(url.href);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-jwt");
    if (url.pathname === RELAY_PEER_IDENTITY_PATH) return Response.json(await (url.origin === origin("a") ? a : b).identity());
    expect(url.href).toBe(origin("b") + VOLATILE_PEER_PATH);
    const raw = String(init?.body), signature = new Headers(init?.headers).get(RELAY_PEER_SIGNATURE_HEADER)!;
    frames.push({ raw, signature }); await b.verify(raw, signature);
    return Response.json({ accepted: true });
  }, { preconnect: fetch.preconnect }) as typeof fetch;
  const a = new RelayPeerAuth({ topology: async () => ({ origin: origin("a"), nodeId: "node-a", peers: new Map(trusted ? [[origin("b"), "node-b"]] : []) }), epoch: async () => aEpoch, fetch: fetcher, jwt: () => "fixture-jwt" });
  const b = new RelayPeerAuth({ topology: async () => ({ origin: origin("b"), nodeId: "node-b", peers: new Map(trusted ? [[origin("a"), "node-a"]] : []) }), epoch: async () => bEpoch, fetch: fetcher, jwt: () => "fixture-jwt" });
  const body = () => ({ operation: "receivePeer", profile: "volatile-v1", epoch: bEpoch, sourceEpoch: aEpoch, origin: origin("a"), envelope: { immutable: "opaque" } });
  return { a, b, calls, frames, body, revoke: () => { trusted = false; }, rotateSource: () => { aEpoch = randomUUID(); }, rotateTarget: () => { bEpoch = randomUUID(); } };
}

test("signed raw request binds canonical destination, source epoch/key and exact content; JWT alone is insufficient", async () => {
  const f = pair(), raw = JSON.stringify(f.body());
  expect((await f.a.forward(origin("b") + VOLATILE_PEER_PATH, { method: "POST", body: raw })).status).toBe(200);
  const frame = f.frames[0]!;
  expect(frame.raw).toBe(raw); expect(frame.signature).toHaveLength(86);
  await f.b.verify(raw, frame.signature); // Immutable retry: delivery dedup remains worker-owned.
  await expect(f.b.verify(raw, undefined)).rejects.toMatchObject({ code: "PEER_POLICY_REQUIRED" });
  await expect(f.b.verify(raw.replace("opaque", "changed"), frame.signature)).rejects.toBeDefined();
  await expect(f.b.verify(raw + " ", frame.signature)).rejects.toBeDefined();
  await expect(f.b.verify(raw, "A".repeat(86))).rejects.toBeDefined();
  f.revoke(); const before = f.calls.length;
  await expect(f.b.verify(raw, frame.signature)).rejects.toBeDefined(); expect(f.calls).toHaveLength(before);
});

test("old signed frames cannot cross relay epochs and fresh identity never preserves a prior key", async () => {
  const f = pair(), oldIdentity = await f.a.identity(), raw = JSON.stringify(f.body());
  await f.a.forward(origin("b") + VOLATILE_PEER_PATH, { method: "POST", body: raw });
  f.rotateSource(); expect((await f.a.identity()).publicKey).not.toBe(oldIdentity.publicKey);
  await expect(f.b.verify(raw, f.frames[0]!.signature)).rejects.toBeDefined();
  await f.a.forward(origin("b") + VOLATILE_PEER_PATH, { method: "POST", body: JSON.stringify(f.body()) });
  f.rotateTarget(); await expect(f.b.verify(f.frames[1]!.raw, f.frames[1]!.signature)).rejects.toBeDefined();
});

test("outbound signing refuses untrusted origins, wrong paths, claims and destination epochs before forwarding", async () => {
  const f = pair();
  for (const [url, body] of [
    ["https://evil.invalid" + VOLATILE_PEER_PATH, f.body()],
    [origin("b") + "/api/session-create", f.body()],
    [origin("b") + VOLATILE_PEER_PATH + "?redirect=1", f.body()],
    [origin("b") + VOLATILE_PEER_PATH, { ...f.body(), sourceEpoch: randomUUID() }],
    [origin("b") + VOLATILE_PEER_PATH, { ...f.body(), epoch: randomUUID() }],
  ] as const) await expect(f.a.forward(url, { method: "POST", body: JSON.stringify(body) })).rejects.toBeDefined();
  expect(f.frames).toHaveLength(0); expect(f.calls.every(call => call === origin("b") + RELAY_PEER_IDENTITY_PATH)).toBe(true);
});

test("identity mismatch, malformed keys, oversized/invalid UTF-8 and redirected handshakes cannot authorize a peer", async () => {
  const f = pair(), good = await f.a.identity();
  for (const response of [
    Response.json({ ...good, nodeId: "other-node" }), Response.json({ ...good, origin: origin("guest") }),
    Response.json({ ...good, publicKey: "A".repeat(59) }), Response.json({ ...good, epoch: "invalid" }),
    new Response("x".repeat(4097)), new Response(new Uint8Array([0xff])), new Response(null, { status: 302 }),
  ]) {
    const b = new RelayPeerAuth({ topology: async () => ({ origin: origin("b"), nodeId: "node-b", peers: new Map([[origin("a"), "node-a"]]) }), epoch: async () => randomUUID(), fetch: Object.assign(async () => response, { preconnect: fetch.preconnect }) as typeof fetch });
    await expect(b.peer(origin("a"))).rejects.toBeDefined();
  }
});

test("cancelled forwarding cannot sign or fetch after a noncooperative topology lookup completes", async () => {
  let release!: (value: any) => void, calls = 0;
  const controller = new AbortController();
  const auth = new RelayPeerAuth({ topology: () => new Promise(resolve => { release = resolve; }), epoch: async () => randomUUID(),
    fetch: Object.assign(async () => { calls++; return Response.json({}); }, { preconnect: fetch.preconnect }) as typeof fetch });
  const result = auth.forward(origin("b") + VOLATILE_PEER_PATH, { method: "POST", body: "{}", signal: controller.signal });
  // Do not invoke Bun's async rejection matcher before firing the cancellation.
  const rejected = result.then(() => "unexpected-success", error => error.code);
  await Promise.resolve(); controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(await Promise.race([rejected, new Promise(resolve => { timer = setTimeout(() => resolve("abort-did-not-settle"), 1000); })])).toBe("PEER_UNREACHABLE");
  } finally { clearTimeout(timer); }
  release({ origin: origin("a"), nodeId: "node-a", peers: new Map([[origin("b"), "node-b"]]) });
  await Promise.resolve(); await Promise.resolve(); expect(calls).toBe(0);
});

test("bounded peer verification reserves independent identity headroom and recovers admission after drain", async () => {
  const epoch = randomUUID(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const auth = new RelayPeerAuth({ topology: async () => { await gate; return { origin: origin("a"), nodeId: "node-a", peers: new Map<string, string>() }; }, epoch: async () => epoch });
  const pending = Array.from({ length: 8 }, () => auth.peer(origin("b")).catch(error => error.code));
  const identity = auth.identity();
  try { await expect(auth.peer(origin("b"))).rejects.toMatchObject({ code: "RELAY_CAPACITY" }); }
  finally { release(); }
  expect(await identity).toMatchObject({ epoch, origin: origin("a") });
  expect(await Promise.all(pending)).toEqual(Array(8).fill("PEER_POLICY_REQUIRED"));
  expect(await auth.identity()).toMatchObject({ epoch });
});

test("revocation during TLS discovery is rechecked before admitting a signed frame", async () => {
  const f = pair(); await f.a.forward(origin("b") + VOLATILE_PEER_PATH, { method: "POST", body: JSON.stringify(f.body()) });
  let checks = 0;
  const b = new RelayPeerAuth({ topology: async () => ({ origin: origin("b"), nodeId: "node-b", peers: new Map(++checks === 1 ? [[origin("a"), "node-a"]] : []) }), epoch: async () => f.body().epoch,
    fetch: Object.assign(async () => Response.json(await f.a.identity()), { preconnect: fetch.preconnect }) as typeof fetch });
  await expect(b.verify(f.frames[0]!.raw, f.frames[0]!.signature)).rejects.toBeDefined(); expect(checks).toBe(2);
});
