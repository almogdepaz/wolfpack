import { expect, test, jest, spyOn } from "bun:test";
import { TaskRelayGateway } from "../../src/task-relay/gateway.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_KIND } from "../../src/agent-kind.ts";
import { WorkerRelayGateway } from "../../src/task-relay/worker-client.ts";
import { RELAY_ID, RELAY_ERROR, RELAY_PROTOCOL_VERSION, type RelayEnvelope } from "../../src/task-relay/domain.ts";

test("background maintenance cannot accumulate overlapping history scans", async () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-maintenance-test-"));
  const gateway = new TaskRelayGateway({ root: directory, retryIntervalMs: 20 });
  const flush = spyOn(gateway, "flushPeerOutbox").mockResolvedValue({ forwarded: 0, pending: 0 });
  jest.useFakeTimers();
  let release!: () => void;
  try {
    await gateway.initialize(); flush.mockClear();
    const blocked = new Promise<void>(r => { release = r; });
    flush.mockImplementation(async () => { await blocked; return { forwarded: 0, pending: 0 }; });
    jest.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
    release();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    jest.advanceTimersByTime(20);
    expect(flush).toHaveBeenCalledTimes(2);
  } finally { release?.(); gateway.close(); flush.mockRestore(); jest.useRealTimers(); rmSync(directory, { recursive: true, force: true }); }
});

const root = () => mkdtempSync(join(tmpdir(), "relay-worker-test-"));
const inspect = async (selector: string) => ({ ok: true as const, session: selector, sessionId: selector, projectPath: "/tmp", harness: AGENT_KIND.PI.id, alive: true });
const input = (callerSession: string) => ({ callerSession, generation: "generation", protocolVersions: [RELAY_PROTOCOL_VERSION] });
async function connect(g: WorkerRelayGateway, selector: string) {
  const result = await g.connect(input(selector));
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.endpoint;
}
const tick = () => new Promise(r => setTimeout(r, 10));
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await tick(); }
  throw new Error("test readiness timeout");
}

test("worker preserves input/result ownership, duplicate/content conflicts, cursor and restart semantics", async () => {
  const directory = root(); let g = new WorkerRelayGateway({ root: directory, inspectSession: inspect });
  try {
    const registration = input("sender");
    const pending = g.connect(registration); registration.generation = "mutated";
    const sourceResult = await pending; if (!sourceResult.ok) throw new Error("connect failed");
    const source = sourceResult.endpoint, target = await connect(g, "receiver");
    expect(JSON.parse(readFileSync(join(directory, "relay-state.json"), "utf8")).registrations[0].generation).toBe("generation");
    const original: RelayEnvelope = { envelopeId: randomUUID(), source, target, protocolVersion: RELAY_PROTOCOL_VERSION, createdAt: new Date().toISOString(), payload: { text: "original" } };
    const submitted = structuredClone(original);
    const sent = g.send({ callerSession: "sender", envelope: submitted });
    (submitted.payload as { text: string }).text = "mutated";
    expect(await sent).toMatchObject({ ok: true, kind: "accepted", forwarding: "local" });
    expect(await g.send({ callerSession: "sender", envelope: original })).toMatchObject({ ok: true, kind: "duplicate" });
    expect(await g.send({ callerSession: "sender", envelope: submitted })).toMatchObject({ ok: false, error: { code: RELAY_ERROR.ENVELOPE_CONFLICT } });
    expect(await g.send({ callerSession: "receiver", envelope: original })).toMatchObject({ ok: false, error: { code: RELAY_ERROR.SOURCE_MISMATCH } });
    expect(await g.send({ callerSession: "sender", envelope: { ...original, envelopeId: randomUUID(), payload: { value: NaN } } })).toMatchObject({ ok: false, error: { code: RELAY_ERROR.INVALID_REQUEST } });
    class NotJson { value = "must not become a plain payload after cloning"; }
    const nonJson = { ...original, envelopeId: randomUUID(), payload: new NotJson() as unknown as RelayEnvelope["payload"] };
    expect(await g.send({ callerSession: "sender", envelope: nonJson })).toMatchObject({ ok: false, error: { code: RELAY_ERROR.INVALID_REQUEST } });
    expect(await g.receivePeer({ origin: "https://sender.example.ts.net", envelope: nonJson })).toMatchObject({ ok: false, error: { code: RELAY_ERROR.INVALID_REQUEST } });
    const page = await g.receive({ callerSession: "receiver", cursor: "0" }); if (!page.ok) throw new Error("receive failed");
    expect(page.envelopes).toEqual([original]); expect(page.nextCursor).toBe("1");
    expect(await g.acknowledgeDelivery({ callerSession: "receiver", envelopeId: original.envelopeId })).toMatchObject({ ok: true, kind: "acknowledged" });
    const endpoints = await g.endpointsForSessions(["sender", "receiver"]);
    expect(endpoints.get("sender")).toEqual(source); (endpoints as Map<string, unknown>).clear();
    expect((await g.endpointsForSessions(["sender"])).get("sender")).toEqual(source);
    await g.close();
    g = new WorkerRelayGateway({ root: directory, inspectSession: inspect }); await g.initialize();
    expect(await g.send({ callerSession: "sender", envelope: original })).toMatchObject({ ok: true, kind: "duplicate" });
    expect(await g.receive({ callerSession: "receiver", cursor: "1" })).toMatchObject({ ok: true, envelopes: [] });
    expect(await g.acknowledgeDelivery({ callerSession: "receiver", envelopeId: original.envelopeId })).toMatchObject({ ok: true, kind: "duplicate" });
  } finally { await g.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("peer ingress has reserved capacity while regular admissions are full", async () => {
  const directory = root(); let release!: () => void;
  const gate = new Promise<void>(r => { release = r; }); let held = 0;
  const g = new WorkerRelayGateway({ root: directory, inspectSession: async selector => {
    if (selector === "held") { held++; await gate; } return inspect(selector);
  } });
  try {
    const target = await connect(g, "receiver");
    const requests = Array.from({ length: 28 }, () => g.connect(input("held")));
    expect(await g.connect(input("overflow"))).toMatchObject({ ok: false, error: { code: RELAY_ERROR.STORE_UNAVAILABLE, retryable: true } });
    await until(() => held === 4);
    expect(await g.receivePeer({ origin: "https://sender.example.ts.net", envelope: {
      envelopeId: randomUUID(), protocolVersion: RELAY_PROTOCOL_VERSION, source: { relay: RELAY_ID, id: randomUUID() }, target,
      createdAt: new Date().toISOString(), payload: { ingress: true },
    } })).toMatchObject({ ok: true, kind: "accepted" });
    release(); expect((await Promise.all(requests)).every(r => r.ok)).toBe(true);
  } finally { release(); await g.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("two workers preserve opaque routes and recover a lost peer response without duplicating delivery", async () => {
  const aRoot = root(), bRoot = root();
  let a!: WorkerRelayGateway, b!: WorkerRelayGateway, drop = true;
  const optionsA = { root: aRoot, inspectSession: inspect, peerOrigin: "https://a.example.ts.net", peerFetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
    const result = await b.receivePeer(JSON.parse(String(init?.body)));
    if (drop) { drop = false; throw new Error("response lost"); }
    return Response.json(result);
  } };
  a = new WorkerRelayGateway(optionsA);
  b = new WorkerRelayGateway({ root: bRoot, inspectSession: inspect, peerOrigin: "https://b.example.ts.net", peerFetch: async (_url, init) => Response.json(await a.receivePeer(JSON.parse(String(init?.body)))) });
  try {
    const source = await connect(a, "overlap"), destination = await connect(b, "overlap");
    expect((await a.endpointsForSessions(["overlap"])).get("overlap")).toEqual(source);
    expect((await b.endpointsForSessions(["overlap"])).get("overlap")).toEqual(destination);
    const route = await a.resolvePeerEndpoint({ origin: "https://b.example.ts.net", endpoint: destination }); if (!route.ok) throw new Error("route failed");
    expect(route.endpoint.relay.startsWith(`${RELAY_ID}:peer:`)).toBe(true);
    const envelope = { envelopeId: randomUUID(), source, target: route.endpoint, protocolVersion: RELAY_PROTOCOL_VERSION, payload: { hello: true }, createdAt: new Date().toISOString() };
    expect(await a.send({ callerSession: "overlap", envelope })).toMatchObject({ ok: true, kind: "accepted", forwarding: "pending" });
    await a.close(); a = new WorkerRelayGateway(optionsA); await a.initialize();
    const page = await b.receive({ callerSession: "overlap", cursor: "0" }); if (!page.ok) throw new Error("receive failed");
    expect(page.envelopes.length).toBe(1); expect(page.envelopes[0]!.envelopeId).toBe(envelope.envelopeId);
    expect(await b.acknowledgeDelivery({ callerSession: "overlap", envelopeId: envelope.envelopeId })).toMatchObject({ ok: true });
    expect(await b.send({ callerSession: "overlap", envelope: { ...envelope, envelopeId: randomUUID(), source: destination, target: page.envelopes[0]!.source } })).toMatchObject({ ok: true, forwarding: "forwarded" });
    const replies = await a.receive({ callerSession: "overlap", cursor: "0" }); if (!replies.ok) throw new Error("reply missing");
    expect(replies.envelopes.length).toBe(1);
    expect(await a.acknowledgeDelivery({ callerSession: "overlap", envelopeId: replies.envelopes[0]!.envelopeId })).toMatchObject({ ok: true });
  } finally { await a.close(); await b.close(); rmSync(aRoot, { recursive: true, force: true }); rmSync(bRoot, { recursive: true, force: true }); }
});

test("dead/missing host inspection and malformed fresh state remain fail-closed", async () => {
  const directory = root(); let alive = true;
  const g = new WorkerRelayGateway({ root: directory, inspectSession: async selector => selector === "missing"
    ? { ok: false as const, code: "NOT_FOUND" as const } : ({ ...await inspect(selector), alive }) });
  try {
    await connect(g, "sender");
    expect(await g.connect(input("missing"))).toMatchObject({ ok: false, error: { code: RELAY_ERROR.CALLER_NOT_FOUND } });
    alive = false;
    expect(await g.connect(input("sender"))).toMatchObject({ ok: false, error: { code: RELAY_ERROR.CALLER_DEAD } });
    alive = true;
    const path = join(directory, "relay-state.json"), good = readFileSync(path);
    writeFileSync(path, "malformed");
    expect((await g.endpointsForSessions([])).size).toBe(0);
    expect(await g.connect(input("sender"))).toMatchObject({ ok: false, error: { code: RELAY_ERROR.STORE_UNAVAILABLE } });
    writeFileSync(path, good);
    expect((await g.connect(input("sender"))).ok).toBe(true);
  } finally { await g.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("deadline stops the owner, rejects all work, and late inspection cannot write after replacement", async () => {
  const directory = root(); let release!: () => void, held = false;
  const gate = new Promise<void>(r => { release = r; });
  const g = new WorkerRelayGateway({ root: directory, requestTimeoutMs: 1000, inspectSession: async selector => { held = true; await gate; return inspect(selector); } });
  let replacement: WorkerRelayGateway | undefined;
  try {
    await g.endpointsForSessions([]); // prove startup succeeded before withholding host inspection
    expect(() => new WorkerRelayGateway({ root: directory })).toThrow("already has a worker owner");
    const pending = g.connect({ ...input("sender"), generation: "old" }); await until(() => held);
    expect(await pending).toMatchObject({ ok: false, error: { code: RELAY_ERROR.STORE_UNAVAILABLE, retryable: true } });
    expect(await g.connect(input("sender"))).toMatchObject({ ok: false, error: { code: RELAY_ERROR.STORE_UNAVAILABLE } });
    await g.close(); replacement = new WorkerRelayGateway({ root: directory, inspectSession: inspect });
    await connect(replacement, "sender"); release(); await tick();
    expect(JSON.parse(readFileSync(join(directory, "relay-state.json"), "utf8")).registrations[0].generation).toBe("generation");
  } finally { release(); await g.close(); await replacement?.close(); rmSync(directory, { recursive: true, force: true }); }
});
