import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { VolatileRelayGateway } from "../../src/task-relay/volatile-gateway.ts";
import type { VolatileGatewayOptions } from "../../src/task-relay/volatile-gateway.ts";
import { MEMORY_RELAY_PROFILE as profile } from "../../src/task-relay/memory-store.ts";
import { BoundedRelayInvestigation } from "../../src/task-relay/investigation.ts";
import { RELAY_ID } from "../../src/task-relay/domain.ts";
import type { RelayEnvelope, RelayEndpoint } from "../../src/task-relay/domain.ts";
import type { VolatileBinding, VolatileResult, VolatileValue } from "../../src/task-relay/volatile-protocol.ts";

const NOW = Date.parse("2026-09-08T00:00:00Z");
const gateways: VolatileRelayGateway[] = [];
afterEach(async () => { await Promise.all(gateways.splice(0).map(g => g.close())); });
function take<K extends VolatileValue["kind"]>(result: VolatileResult, kind: K): Extract<VolatileValue, { kind: K }> {
  expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.code);
  expect(result.value.kind).toBe(kind); return result.value as Extract<VolatileValue, { kind: K }>;
}
function fixture(options: Partial<VolatileGatewayOptions> = {}) {
  let now = NOW, inspections = 0;
  const people = new Map(["alice", "bob", "mallory"].map(name => [name, { id: randomUUID(), alive: true }]));
  const gateway = new VolatileRelayGateway({ now: () => now, inspectSession: async selector => {
    inspections++;
    const found = [...people.entries()].find(([name, person]) => name === selector || person.id === selector);
    return found ? { ok: true, session: found[0], sessionId: found[1].id, projectPath: "/fixture", harness: "pi", alive: found[1].alive }
      : { ok: false, code: "NOT_FOUND" };
  }, ...options }); gateways.push(gateway);
  const connect = async (callerSession: string, generation = "g"): Promise<VolatileBinding> => {
    const result = await gateway.request({ operation: "connect", profile, callerSession, generation, protocolVersions: [2], leaseMs: 300_000 });
    return { profile, epoch: gateway.epoch, callerSession, endpoint: take(result, "connected").endpoint };
  };
  return { gateway, people, connect, advance(ms: number) { now += ms; }, inspections: () => inspections };
}
function envelope(source: RelayEndpoint, target: RelayEndpoint, id = randomUUID()): RelayEnvelope {
  return { envelopeId: id, protocolVersion: 2, source, target, payload: { arbitrary: "opaque" }, createdAt: new Date(NOW).toISOString() };
}

test("profile is mandatory before registration; scopes, identities and inert inputs fail closed", async () => {
  const f = fixture();
  expect(await f.gateway.request({ operation: "connect", callerSession: "alice", generation: "g", protocolVersions: [2] })).toMatchObject({ ok: false, error: { code: "RELAY_PROFILE_REQUIRED" } });
  expect(f.inspections()).toBe(0);
  let calls = 0;
  const trap = { operation: "connect", get profile() { calls++; return profile; } };
  expect(await f.gateway.request(trap)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(await f.gateway.request(new Proxy({}, { ownKeys() { calls++; return []; } }))).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(calls).toBe(0);
  const alice = await f.connect("alice"), bob = await f.connect("bob");
  expect(await f.gateway.request({ ...bob, callerSession: "mallory", operation: "receive", cursor: "0" })).toMatchObject({ ok: false, error: { code: "SOURCE_MISMATCH" } });
  expect(await f.gateway.request({ ...alice, epoch: randomUUID(), operation: "receive", cursor: "0" })).toMatchObject({ ok: false, error: { code: "RELAY_RESET", retryable: false } });
  expect(await f.gateway.request({ ...alice, operation: "send", envelope: envelope(bob.endpoint, alice.endpoint) })).toMatchObject({ ok: false, error: { code: "SOURCE_MISMATCH" } });
  const replaced = await f.connect("alice", "new-generation");
  expect(replaced.endpoint).not.toEqual(alice.endpoint);
  expect(await f.gateway.request({ ...alice, operation: "receive", cursor: "0" })).toMatchObject({ ok: false, error: { code: "REGISTRATION_EXPIRED" } });
  take(await f.gateway.request({ ...replaced, operation: "disconnect" }), "disconnected");
  expect(await f.gateway.request({ ...replaced, operation: "health" })).toMatchObject({ ok: false, error: { code: "REGISTRATION_EXPIRED" } });
});

test("local delivery/ACK exposes real sparse cursors, bounded pages, conflicts and credit recovery", async () => {
  const f = fixture({ limits: { mailboxItems: 3 } }), a = await f.connect("alice"), b = await f.connect("bob");
  const sent = [1, 2, 3, 4].map(() => envelope(a.endpoint, b.endpoint));
  for (const item of sent.slice(0, 3)) take(await f.gateway.request({ ...a, operation: "send", envelope: item }), "accepted");
  expect(await f.gateway.request({ ...a, operation: "send", envelope: sent[3] })).toMatchObject({ ok: false, error: { code: "RELAY_CAPACITY", retryable: true } });
  take(await f.gateway.request({ ...b, operation: "acknowledge", envelopeId: sent[1]!.envelopeId }), "acknowledged");
  const page = take(await f.gateway.request({ ...b, operation: "receive", cursor: "0" }), "page");
  expect(page.deliveries.map(d => d.cursor)).toEqual(["1", "3"]); expect(page.nextCursor).toBe("3");
  const limited = take(await f.gateway.request({ ...b, operation: "receive", cursor: "0", limit: 1 }), "page");
  expect(limited.nextCursor).toBe("1"); expect(limited.hasMore).toBe(true);
  expect(await f.gateway.request({ ...b, operation: "receive", cursor: "99999999999999999999999999" })).toMatchObject({ ok: false, error: { code: "INVALID_CURSOR" } });
  expect(take(await f.gateway.request({ ...a, operation: "send", envelope: sent[1] }), "accepted").duplicate).toBe(true);
  expect(await f.gateway.request({ ...a, operation: "send", envelope: { ...sent[1], payload: { changed: true } } })).toMatchObject({ ok: false, error: { code: "ENVELOPE_CONFLICT" } });
  take(await f.gateway.request({ ...a, operation: "send", envelope: sent[3] }), "accepted");
  expect(take(await f.gateway.request({ ...b, operation: "receive", cursor: "3" }), "page").nextCursor).toBe("4");
});

test("broker liveness and lease checks remain authoritative; fresh start does not alias old binding", async () => {
  const f = fixture(), a = await f.connect("alice"), b = await f.connect("bob");
  f.people.get("bob")!.alive = false;
  expect(await f.gateway.request({ ...a, operation: "send", envelope: envelope(a.endpoint, b.endpoint) })).toMatchObject({ ok: false, error: { code: "TARGET_NOT_REGISTERED" } });
  f.people.get("bob")!.alive = true; f.advance(300_000);
  expect(await f.gateway.request({ ...a, operation: "receive", cursor: "0" })).toMatchObject({ ok: false, error: { code: "REGISTRATION_EXPIRED" } });
  const fresh = fixture();
  expect(await fresh.gateway.request({ ...a, operation: "receive", cursor: "0" })).toMatchObject({ ok: false, error: { code: "RELAY_RESET" } });
});

test("close during inspection cannot publish a late registration", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ inspectSession: async () => { await wait; return { ok: true, session: "alice", sessionId: "alice-id", projectPath: "/fixture", harness: "pi", alive: true }; } });
  const pending = f.gateway.request({ operation: "connect", profile, callerSession: "alice", generation: "g", protocolVersions: [2] });
  await f.gateway.close(); release();
  expect(await pending).toMatchObject({ ok: false, error: { code: "RELAY_RESET" } });
});

test("peer ingress is separate, aliases bind both origin and epoch, and loss after acceptance is retryable", async () => {
  const receiver = fixture(), target = await receiver.connect("bob");
  let network = 0;
  const sender = fixture({ peerOrigin: "https://sender.tail123.ts.net", peerFetch: async (_url, init) => {
    network++; const reply = await receiver.gateway.peer(JSON.parse(String(init?.body)));
    if (network === 1) throw new Error("lost after destination acceptance");
    return Response.json(reply);
  } });
  const source = await sender.connect("alice");
  const resolve = (peerEpoch: string) => sender.gateway.topology({ ...source, operation: "resolvePeer", origin: "https://receiver.tail123.ts.net", peerEpoch, target: target.endpoint });
  expect(await sender.gateway.request({ ...source, operation: "resolvePeer", origin: "https://receiver.tail123.ts.net", peerEpoch: receiver.gateway.epoch, target: target.endpoint }))
    .toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  const remote = take(await resolve(receiver.gateway.epoch), "resolved").endpoint;
  expect(take(await resolve(receiver.gateway.epoch), "resolved").endpoint).toEqual(remote);
  expect(take(await resolve(randomUUID()), "resolved").endpoint.relay).not.toBe(remote.relay);
  const item = envelope(source.endpoint, remote);
  expect(await sender.gateway.request({ ...source, operation: "send", envelope: item })).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE", retryable: true, mayHaveBeenDelivered: true } });
  expect(await sender.gateway.request({ ...source, operation: "send", envelope: item })).toMatchObject({ ok: false }); expect(network).toBe(1);
  sender.advance(1000);
  const accepted = take(await sender.gateway.request({ ...source, operation: "send", envelope: item }), "accepted");
  expect(accepted.duplicate).toBe(true); expect(accepted.forwarding).toBe("forwarded"); expect(network).toBe(2);
  expect(take(await sender.gateway.request({ ...source, operation: "send", envelope: item }), "accepted").acceptanceId).toBe(accepted.acceptanceId);
  expect(network).toBe(2);
  const page = take(await receiver.gateway.request({ ...target, operation: "receive", cursor: "0" }), "page");
  expect(page.deliveries).toHaveLength(1); expect(page.deliveries[0]!.envelope.source.relay).not.toBe(RELAY_ID);
  expect(take(await sender.gateway.request({ ...source, operation: "health" }), "health").store.activeItems).toBe(0);
  const peerInput = { operation: "receivePeer", profile, epoch: receiver.gateway.epoch, sourceEpoch: sender.gateway.epoch,
    origin: "https://sender.tail123.ts.net", envelope: { ...item, target: target.endpoint } };
  expect(await receiver.gateway.request(peerInput)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(await receiver.gateway.peer({ ...peerInput, sourceEpoch: randomUUID() })).toMatchObject({ ok: false, error: { code: "ENVELOPE_CONFLICT" } });
});

test("four actual failures produce stable unconfirmed, no rearm or success-shaped pending", async () => {
  let calls = 0;
  const f = fixture({ peerOrigin: "https://sender.tail123.ts.net", peerFetch: async () => { calls++; throw new Error("offline"); } });
  const a = await f.connect("alice"), remote = take(await f.gateway.topology({ ...a, operation: "resolvePeer", origin: "https://target.tail123.ts.net", peerEpoch: randomUUID(), target: { relay: RELAY_ID, id: randomUUID() } }), "resolved").endpoint;
  const item = envelope(a.endpoint, remote);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const reply = await f.gateway.request({ ...a, operation: "send", envelope: item });
    expect(reply).toMatchObject({ ok: false, error: { code: attempt === 4 ? "DELIVERY_UNCONFIRMED" : "PEER_UNREACHABLE", retryable: attempt < 4, mayHaveBeenDelivered: true } });
    f.advance(1000);
  }
  expect(await f.gateway.request({ ...a, operation: "send", envelope: item })).toMatchObject({ ok: false, error: { code: "DELIVERY_UNCONFIRMED" } });
  expect(calls).toBe(4); expect(take(await f.gateway.request({ ...a, operation: "health" }), "health").store.activeItems).toBe(0);
});

test("concurrent identical sends coalesce but changed content conflicts during the in-flight call", async () => {
  let release!: () => void, started!: () => void, calls = 0;
  const start = new Promise<void>(r => { started = r; }), gate = new Promise<void>(r => { release = r; });
  const remoteEpoch = randomUUID(), acceptanceId = randomUUID();
  const f = fixture({ peerOrigin: "https://sender.tail123.ts.net", peerFetch: async (_url, init) => {
    calls++; started(); await gate;
    const body = JSON.parse(String(init?.body));
    return Response.json({ ok: true, profile, epoch: remoteEpoch, value: { kind: "accepted", envelopeId: body.envelope.envelopeId, acceptanceId, duplicate: false, forwarding: "local" } });
  } });
  const a = await f.connect("alice"), target = take(await f.gateway.topology({ ...a, operation: "resolvePeer", origin: "https://target.tail123.ts.net", peerEpoch: remoteEpoch, target: { relay: RELAY_ID, id: randomUUID() } }), "resolved").endpoint;
  const item = envelope(a.endpoint, target), first = f.gateway.request({ ...a, operation: "send", envelope: item }); await start;
  const second = f.gateway.request({ ...a, operation: "send", envelope: item });
  expect(await f.gateway.request({ ...a, operation: "send", envelope: { ...item, payload: "changed" } })).toMatchObject({ ok: false, error: { code: "ENVELOPE_CONFLICT" } });
  release(); const replies = await Promise.all([first, second]);
  expect(replies.map(r => take(r, "accepted").acceptanceId)).toEqual([acceptanceId, acceptanceId]); expect(calls).toBe(1);
});

test("logging failures do not reject accepted work and health reports sanitized loss", async () => {
  const investigation = new BoundedRelayInvestigation({ append: async () => { throw new Error("secret path"); } });
  const f = fixture({ investigation }), a = await f.connect("alice"), b = await f.connect("bob");
  take(await f.gateway.request({ ...a, operation: "send", envelope: envelope(a.endpoint, b.endpoint) }), "accepted");
  await investigation.drain();
  const health = take(await f.gateway.request({ ...a, operation: "health" }), "health");
  expect(health.investigation?.degraded).toBe(true); expect(health.investigation!.writeFailures).toBeGreaterThan(0);
  expect(JSON.stringify(health)).not.toContain("secret path"); expect(health.store.activeItems).toBe(1);
});

test("oversized and invalid peer confirmations cannot become acceptance", async () => {
  for (const invalid of ["oversized", "epoch", "id", "acceptance", "profile"]) {
    const peerEpoch = randomUUID();
    const f = fixture({ peerOrigin: "https://sender.tail123.ts.net", peerFetch: async (_url, init) => {
      if (invalid === "oversized") return new Response("x".repeat(4097));
      const wire = JSON.parse(String(init?.body));
      return Response.json({ ok: true, profile: invalid === "profile" ? "legacy" : profile, epoch: invalid === "epoch" ? randomUUID() : peerEpoch,
        value: { kind: "accepted", envelopeId: invalid === "id" ? "wrong-id" : wire.envelope.envelopeId,
          acceptanceId: invalid === "acceptance" ? "" : randomUUID(), duplicate: false, forwarding: "local" } });
    } });
    const source = await f.connect("alice");
    const remote = take(await f.gateway.topology({ ...source, operation: "resolvePeer", origin: "https://peer.tail123.ts.net", peerEpoch, target: { relay: RELAY_ID, id: randomUUID() } }), "resolved").endpoint;
    expect(await f.gateway.request({ ...source, operation: "send", envelope: envelope(source.endpoint, remote) })).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE" } });
    expect(take(await f.gateway.request({ ...source, operation: "health" }), "health").store.activeItems).toBe(1);
  }
});

test("network deadline bounds an uncooperative fetch and late confirmation cannot commit", async () => {
  let release!: (response: Response) => void, wire: any, calls = 0;
  const peerEpoch = randomUUID(), acceptanceId = randomUUID();
  const confirmed = () => Response.json({ ok: true, profile, epoch: peerEpoch, value: { kind: "accepted", envelopeId: wire.envelope.envelopeId, acceptanceId, duplicate: false, forwarding: "local" } });
  const f = fixture({ peerOrigin: "https://sender.tail123.ts.net", peerFetch: async (_url, init) => {
    wire = JSON.parse(String(init?.body)); calls++;
    return calls === 1 ? await new Promise<Response>(resolve => { release = resolve; }) : confirmed();
  } });
  const source = await f.connect("alice");
  const remote = take(await f.gateway.topology({ ...source, operation: "resolvePeer", origin: "https://peer.tail123.ts.net", peerEpoch, target: { relay: RELAY_ID, id: randomUUID() } }), "resolved").endpoint;
  const item = envelope(source.endpoint, remote);
  expect(await f.gateway.request({ ...source, operation: "send", envelope: item })).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE" } });
  release(confirmed()); await Bun.sleep(10);
  expect(take(await f.gateway.request({ ...source, operation: "health" }), "health").store.activeItems).toBe(1);
  f.advance(1000);
  expect(take(await f.gateway.request({ ...source, operation: "send", envelope: item }), "accepted").acceptanceId).toBe(acceptanceId);
  expect(calls).toBe(2);
}, 12_000);

test("status observation after a slow failure never starts a phantom forwarding attempt", async () => {
  let calls = 0;
  const peerEpoch = randomUUID();
  const f = fixture({ peerOrigin: "https://sender.tail123.ts.net", peerFetch: async (_url, init) => {
    calls++; f.advance(2000);
    if (calls === 1) throw new Error("slow failure");
    const wire = JSON.parse(String(init?.body));
    return Response.json({ ok: true, profile, epoch: peerEpoch, value: { kind: "accepted", envelopeId: wire.envelope.envelopeId, acceptanceId: randomUUID(), duplicate: true, forwarding: "local" } });
  } });
  const source = await f.connect("alice");
  const remote = take(await f.gateway.topology({ ...source, operation: "resolvePeer", origin: "https://peer.tail123.ts.net", peerEpoch, target: { relay: RELAY_ID, id: randomUUID() } }), "resolved").endpoint;
  const item = envelope(source.endpoint, remote);
  expect(await f.gateway.request({ ...source, operation: "send", envelope: item })).toMatchObject({ ok: false });
  take(await f.gateway.request({ ...source, operation: "send", envelope: item }), "accepted");
  expect(calls).toBe(2);
});

test("idle maintenance coalesces investigation cleanup and never evicts accepted mailboxes", async () => {
  let cleanups = 0;
  const investigation = new BoundedRelayInvestigation({ append: async () => {}, cleanup: async () => { cleanups++; } });
  const f = fixture({ investigation }), source = await f.connect("alice"), target = await f.connect("bob");
  take(await f.gateway.request({ ...source, operation: "send", envelope: envelope(source.endpoint, target.endpoint) }), "accepted");
  f.gateway.initialize(); f.gateway.initialize(); await investigation.drain(); expect(cleanups).toBe(1);
  f.advance(60_000); f.gateway.maintenance(); f.gateway.maintenance(); await investigation.drain(); expect(cleanups).toBe(2);
  expect(take(await f.gateway.request({ ...source, operation: "health" }), "health").store.activeItems).toBe(1);
});
