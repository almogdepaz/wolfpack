import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkerRelayGateway } from "../../src/task-relay/worker-client.ts";
import { RelayPeerTransport } from "../../src/task-relay/peer-transport.ts";
import { readPeerResponse } from "../../src/task-relay/peer-response.ts";
import { RELAY_ID } from "../../src/task-relay/domain.ts";

const profile = "volatile-v1";
const sourceOrigin = "https://source.tail123.ts.net", targetOrigin = "https://target.tail123.ts.net";
type Mode = "oversized" | "declared-oversized" | "stalled" | "valid";

async function fixture(authenticated: boolean) {
  const root = mkdtempSync(join(tmpdir(), "peer-response-worker-")), peerEpoch = randomUUID();
  let mode: Mode = "oversized", cancelled = 0, started: (() => void) | undefined;
  const signals: AbortSignal[] = [];
  const network = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/api/task-relay/profile") return Response.json({ ok: true, profile, epoch: peerEpoch });
    signals.push(init!.signal!);
    if (mode === "valid") {
      const body = JSON.parse(String(init?.body));
      return Response.json({ ok: true, profile, epoch: peerEpoch, value: { kind: "accepted", envelopeId: body.envelope.envelopeId, acceptanceId: randomUUID(), duplicate: false, forwarding: "local" } });
    }
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(mode === "oversized" ? 4097 : 1)); },
      // A misbehaving stream's cancellation promise must not retain callback slots.
      cancel() { cancelled++; return new Promise<void>(() => {}); },
    }), mode === "declared-oversized" ? { headers: { "content-length": "4097" } } : undefined);
    started?.(); return response;
  }, { preconnect: fetch.preconnect }) as typeof fetch;
  const auth: RelayPeerTransport = new RelayPeerTransport({ topology: async () => ({ origin: sourceOrigin, nodeId: "source-node", peers: new Map([[targetOrigin, "target-node"]]) }), epoch: async () => gateway.volatileEpoch(), fetch: network });
  const gateway = new WorkerRelayGateway({ root, profile, peerOrigin: sourceOrigin, peerFetch: authenticated ? (input, init) => auth.forward(input, init) : network,
    inspectSession: async selector => ({ ok: true, session: selector, sessionId: selector, projectPath: "/fixture", harness: "pi", alive: true }) });
  try {
    await gateway.initialize(); await gateway.volatileEpoch();
    const connected = await gateway.volatile({ operation: "connect", profile, callerSession: "source", generation: "g", protocolVersions: [2] });
    if (!connected.ok || connected.value.kind !== "connected") throw new Error("fixture connection failed");
    const binding = { profile, epoch: connected.epoch, callerSession: "source", endpoint: connected.value.endpoint };
    const resolved = await gateway.volatileTopology({ ...binding, operation: "resolvePeer", origin: targetOrigin, peerEpoch, target: { relay: RELAY_ID, id: randomUUID() } });
    if (!resolved.ok || resolved.value.kind !== "resolved") throw new Error("fixture resolution failed");
    const remote = resolved.value.endpoint;
    return {
      gateway, signals, cancelled: () => cancelled, setMode(value: Mode) { mode = value; },
      started: () => new Promise<void>(resolve => { started = resolve; }),
      send: () => gateway.volatile({ ...binding, operation: "send", envelope: { envelopeId: randomUUID(), protocolVersion: 2, source: binding.endpoint, target: remote, createdAt: new Date().toISOString(), payload: { opaque: true } } }),
      close: async () => { await gateway.close(); rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) { await gateway.close(); rmSync(root, { recursive: true, force: true }); throw error; }
}

for (const authenticated of [false, true]) test(`worker-mediated peer bodies are bounded before cloning and recover callback slots (policy=${authenticated})`, async () => {
  const f = await fixture(authenticated);
  try {
    // More failures than the eight host callback slots: no leak and no false ACK.
    for (let i = 0; i < 10; i++) {
      f.setMode(i % 2 ? "declared-oversized" : "oversized");
      expect(await f.send()).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE", mayHaveBeenDelivered: true } });
      expect(f.cancelled()).toBe(i + 1); expect(f.signals[i]!.aborted).toBe(true);
    }
    f.setMode("valid"); expect(await f.send()).toMatchObject({ ok: true, value: { kind: "accepted", forwarding: "forwarded" } });
  } finally { await f.close(); }
}, 15_000);

test("trusted worker forwarding retains its four-second deadline through a never-ending body", async () => {
  const f = await fixture(true);
  try {
    f.setMode("stalled"); const start = performance.now();
    expect(await f.send()).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE", mayHaveBeenDelivered: true } });
    expect(performance.now() - start).toBeLessThan(4800);
    expect(f.signals[0]!.aborted).toBe(true); expect(f.cancelled()).toBe(1);
    f.setMode("valid"); expect(await f.send()).toMatchObject({ ok: true, value: { kind: "accepted" } });
  } finally { await f.close(); }
}, 10_000);

for (const authenticated of [false, true]) test(`worker close aborts active peer bodies and settles without waiting for the deadline (policy=${authenticated})`, async () => {
  const f = await fixture(authenticated);
  try {
    f.setMode("stalled"); const started = f.started(), pending = f.send(); await started;
    const start = performance.now(); await f.gateway.close();
    expect(await pending).toMatchObject({ ok: false, error: { code: "RELAY_RESET" } });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(f.signals[0]!.aborted).toBe(true); expect(f.cancelled()).toBe(1);
  } finally { await f.close(); }
}, 10_000);

test("host peer reader rejects invalid UTF-8 and cancels late responses without consuming bytes", async () => {
  const error = await readPeerResponse(new Response(new Uint8Array([0xff])), new AbortController().signal, 4096).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  const controller = new AbortController(); controller.abort(); let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const aborted = await readPeerResponse(response, controller.signal, 4096).catch(error => error);
  expect(aborted).toBeInstanceOf(Error); expect(cancelled).toBe(true);
});
