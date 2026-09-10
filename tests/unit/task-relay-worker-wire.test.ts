import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AGENT_KIND } from "../../src/agent-kind.ts";
import { WorkerRelayGateway } from "../../src/task-relay/worker-client.ts";
import { RELAY_PROTOCOL_VERSION } from "../../src/task-relay/domain.ts";
import { captureRelayWire, relayWireBytes, RelayWireBudgetError, RELAY_WORKER_LIMITS as LIMIT } from "../../src/task-relay/worker-protocol.ts";

const registration = { profile: "volatile-v1", operation: "connect", callerSession: "sender", generation: "generation", protocolVersions: [RELAY_PROTOCOL_VERSION] };
const inspection = { ok: true as const, session: "sender", sessionId: "sender", projectPath: "/tmp", harness: AGENT_KIND.PI.id, alive: true };

test("wire snapshots bound exact JSON bytes and own opaque data before transfer", () => {
  const value = JSON.parse('{"__proto__":{"x":1},"text":"é😀\\n\\\"","array":[true,null,3]}');
  const size = Buffer.byteLength(JSON.stringify(value));
  const copy = captureRelayWire(value, size);
  expect(copy.bytes).toBe(size);
  expect(copy.value).toEqual(value);
  expect(() => captureRelayWire(value, size - 1)).toThrow(RelayWireBudgetError);
  value.__proto__.x = 2;
  expect(copy.value.__proto__.x).toBe(1);
  expect(Object.getPrototypeOf(copy.value)).toBe(null);
  expect(captureRelayWire([undefined, -0], 14).value).toEqual([undefined, -0]);
  expect(() => captureRelayWire("x".repeat(LIMIT.responseBytes + 1), LIMIT.requestBytes)).toThrow(RelayWireBudgetError);
  const map = new Map([["__proto__", { id: "original" }]]);
  const captured = captureRelayWire(map, 100, true);
  expect(captured.bytes).toBe(Buffer.byteLength(JSON.stringify({ $map: [...map] })));
  map.get("__proto__")!.id = "changed";
  expect(captured.value.get("__proto__")!.id).toBe("original");
  expect(() => captureRelayWire(captured.value, captured.bytes - 1, true)).toThrow(RelayWireBudgetError);
});

test("all ignored fields must be inert wire data, not JSON-invisible clone payloads", () => {
  const buffer = new ArrayBuffer(4 * 1024 * 1024);
  class Custom { padding = buffer; }
  for (const padding of [buffer, new SharedArrayBuffer(4), new Uint8Array(buffer), new DataView(buffer),
    new Set([buffer]), new Map([["buffer", buffer]]), new Date(), /test/, new Error("test"), new Custom(),
    new WeakMap(), NaN, Infinity, 1n, Symbol("value"), () => 1]) {
    expect(() => captureRelayWire({ ...registration, padding }, LIMIT.requestBytes)).toThrow();
    expect(() => relayWireBytes({ ...inspection, padding })).toThrow();
  }
  let trapCalls = 0;
  const proxy = new Proxy({}, { getPrototypeOf() { trapCalls++; return Object.prototype; }, ownKeys() { trapCalls++; return []; } });
  expect(() => captureRelayWire(proxy, LIMIT.requestBytes)).toThrow();
  expect(trapCalls).toBe(0);
  let getterCalls = 0;
  const getter = { get padding() { getterCalls++; return buffer; } };
  expect(() => captureRelayWire(getter, LIMIT.requestBytes)).toThrow();
  expect(getterCalls).toBe(0);
  let jsonCalls = 0;
  expect(() => captureRelayWire({ toJSON() { jsonCalls++; return {}; } }, 100)).toThrow();
  expect(jsonCalls).toBe(0);
  for (const value of [Object.defineProperty({}, "padding", { value: buffer }), { [Symbol("padding")]: buffer },
    Object.assign([], { padding: buffer }), new Array(1_000_000)]) {
    expect(() => captureRelayWire(value, LIMIT.requestBytes)).toThrow();
  }
  const map = Object.assign(new Map(), { padding: buffer });
  expect(() => captureRelayWire(map, LIMIT.responseBytes, true)).toThrow();
  const cycle: unknown[] = []; cycle.push(cycle);
  expect(() => captureRelayWire(cycle, LIMIT.requestBytes)).toThrow();
  let deep: unknown = null;
  for (let i = 0; i < 66; i++) deep = [deep];
  expect(captureRelayWire(deep, LIMIT.requestBytes).bytes).toBe(136);
  const shared = { x: 1 };
  const repeated = captureRelayWire([shared, shared], 100);
  expect(repeated.bytes).toBe(Buffer.byteLength(JSON.stringify([shared, shared])));
  expect(repeated.value[0]).not.toBe(repeated.value[1]);
});

test("review reproduction: ignored 4 MiB request and callback buffers fail closed independently", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-wire-regression-"));
  let badCallback = false, calls = 0;
  const padding = new ArrayBuffer(4 * 1024 * 1024);
  const gateway = new WorkerRelayGateway({ root, inspectSession: async () => {
    calls++;
    return badCallback ? { ...inspection, padding } : inspection;
  } });
  try {
    const malformedRequest = { ...registration, padding };
    expect(await gateway.volatile(malformedRequest)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(calls).toBe(0);
    expect((await gateway.endpointsForSessions(["sender"])).size).toBe(0);
    badCallback = true;
    expect(await gateway.volatile(registration)).toMatchObject({ ok: false, error: { code: "RELAY_UNAVAILABLE" } });
    expect(calls).toBe(1);
    expect((await gateway.endpointsForSessions(["sender"])).size).toBe(0);
    badCallback = false;
    expect(await gateway.volatile(registration)).toMatchObject({ ok: true });
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
});

test("bootstrap options reject hidden clone payloads without reserving the root", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-wire-bootstrap-"));
  let gateway: WorkerRelayGateway | undefined;
  try {
    expect(() => new WorkerRelayGateway({ root, peerOrigin: new ArrayBuffer(4 * 1024 * 1024) as unknown as string })).toThrow();
    gateway = new WorkerRelayGateway({ root, inspectSession: async () => inspection });
    expect(await gateway.volatile(registration)).toMatchObject({ ok: true });
  } finally { await gateway?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("aggregate byte credits reject before count saturation and recover after completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-wire-credits-"));
  const gateway = new WorkerRelayGateway({ root, inspectSession: async () => inspection });
  // Metadata calls accept large inert selector lists; endpoint envelopes deliberately
  // have a tighter 64KiB domain bound. Admit synchronously before worker responses.
  const request = ["x".repeat(200 * 1024)];
  const bytes = captureRelayWire([request], LIMIT.requestBytes).bytes;
  const count = Math.floor(LIMIT.regularBytes / bytes);
  try {
    expect(count).toBeLessThan(LIMIT.regularRequests);
    const pending = Array.from({ length: count }, () => gateway.registrationsForSessions(request));
    const overflow = await gateway.registrationsForSessions(request).then(() => undefined, (error: unknown) => error);
    expect(overflow).toMatchObject({ message: "relay request byte budget exceeded" });
    expect((await Promise.all(pending)).every(r => r.size === 0)).toBe(true);
    expect((await gateway.registrationsForSessions(request)).size).toBe(0);
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
});
