import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_KIND } from "../../src/agent-kind.ts";
import { CHILD_EVENT, CHILD_EVENT_PAYLOAD_KIND, CHILD_EVENT_RELAY_PROTOCOL, type ChildEventPayload } from "../../src/child-event-contract.ts";
import { AGENT_STATUS_AUTHORITY, AGENT_STATUS_FRESHNESS, AGENT_STATUS_STATE } from "../../src/agent-status-contract.ts";
import { createChildEventDelivery } from "../../src/server/child-event-delivery.ts";
import { SESSION_SEND_DELIVERY, SESSION_SEND_OUTCOME } from "../../src/session-send-contract.ts";
import { RELAY_ID, RELAY_PROTOCOL_VERSION } from "../../src/task-relay/domain.ts";
import type { RelayEndpoint, RelayEnvelope } from "../../src/task-relay/domain.ts";
import { MEMORY_RELAY_PROFILE as profile } from "../../src/task-relay/memory-store.ts";
import { VolatileRelayGateway } from "../../src/task-relay/volatile-gateway.ts";
import { HOST_ENVELOPE_ACCEPTANCE } from "../../src/task-relay/volatile-protocol.ts";
import type { VolatileBinding, VolatileResult, VolatileValue } from "../../src/task-relay/volatile-protocol.ts";
import { WorkerRelayGateway } from "../../src/task-relay/worker-client.ts";

const NOW = Date.parse("2026-11-09T00:00:00Z");
const gateways: { close(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.close())); });

function take<K extends VolatileValue["kind"]>(result: VolatileResult, kind: K): Extract<VolatileValue, { kind: K }> {
  if (!result.ok) throw new Error(result.error.code);
  expect(result.value.kind).toBe(kind);
  return result.value as Extract<VolatileValue, { kind: K }>;
}

function fixture() {
  const people = new Map(["parent", "child", "mallory"].map(name => [name, { id: randomUUID(), alive: true }]));
  const gateway = new VolatileRelayGateway({ now: () => NOW, elapsedNow: () => 0, inspectSession: async selector => {
    const found = [...people.entries()].find(([name, person]) => name === selector || person.id === selector);
    return found ? { ok: true, session: found[0], sessionId: found[1].id, projectPath: "/fixture", harness: "pi", alive: found[1].alive }
      : { ok: false, code: "NOT_FOUND" };
  } });
  gateways.push(gateway);
  const connect = async (callerSession: string, protocolVersions: number[] = [RELAY_PROTOCOL_VERSION]): Promise<VolatileBinding> => {
    const result = await gateway.request({ operation: "connect", profile, callerSession, generation: "g", protocolVersions, leaseMs: 300_000 });
    return { profile, epoch: gateway.epoch, callerSession, endpoint: take(result, "connected").endpoint };
  };
  return { gateway, people, connect, id: (name: string) => people.get(name)!.id };
}

function childEvent(seq = 1) {
  return { kind: CHILD_EVENT_PAYLOAD_KIND, eventId: `child:boot:${seq}`, bootId: "boot", seq, event: "done", state: "idle" };
}

function hostInput(targetSession: string, seq = 1) {
  return {
    targetSession,
    requiredProtocol: CHILD_EVENT_RELAY_PROTOCOL,
    envelopeId: `wolfpack.child_event:child:boot:${seq}`,
    payload: childEvent(seq),
    createdAt: new Date(NOW).toISOString(),
  };
}

test("a server-owned envelope reaches only endpoints that advertise the child-event protocol", async () => {
  const f = fixture();
  const legacy = await f.connect("parent");
  // A current adapter advertises only the wire version: it would reject the
  // whole inbox page on an unknown payload, so nothing is sent to it.
  expect(await f.gateway.hostEnvelope(hostInput(f.id("parent")))).toEqual({ kind: "unsupported" });
  expect(take(await f.gateway.request({ ...legacy, operation: "receive", cursor: "0" }), "page").deliveries).toEqual([]);
  // No registration at all is also unsupported.
  expect(await f.gateway.hostEnvelope(hostInput(f.id("child")))).toEqual({ kind: "unsupported" });

  const capable = await f.connect("mallory", [RELAY_PROTOCOL_VERSION, CHILD_EVENT_RELAY_PROTOCOL]);
  expect(await f.gateway.hostEnvelope(hostInput(f.id("mallory")))).toEqual({ kind: "accepted", duplicate: false });
  expect(await f.gateway.hostEnvelope(hostInput(f.id("mallory")))).toEqual({ kind: "accepted", duplicate: true });
  const page = take(await f.gateway.request({ ...capable, operation: "receive", cursor: "0" }), "page");
  expect(page.deliveries).toHaveLength(1);
  const delivered = page.deliveries[0]!.envelope;
  expect(delivered).toMatchObject({
    envelopeId: "wolfpack.child_event:child:boot:1",
    protocolVersion: RELAY_PROTOCOL_VERSION,
    target: capable.endpoint,
    payload: childEvent(1),
    createdAt: new Date(NOW).toISOString(),
  });
  expect(delivered.source.relay).toBe(RELAY_ID);
  expect(delivered.source.id).not.toBe(capable.endpoint.id);
  expect(delivered.source.id).not.toBe(legacy.endpoint.id);
  take(await f.gateway.request({ ...capable, operation: "acknowledge", envelopeId: delivered.envelopeId }), "acknowledged");

  // Nobody can address the server source: it belongs to no inspectable session.
  const toServer: RelayEnvelope = { envelopeId: randomUUID(), protocolVersion: RELAY_PROTOCOL_VERSION, source: capable.endpoint,
    target: delivered.source, payload: { text: "hello" }, createdAt: new Date(NOW).toISOString() };
  expect(await f.gateway.request({ ...capable, operation: "send", envelope: toServer })).toMatchObject({ ok: false, error: { code: "TARGET_NOT_REGISTERED" } });
});

test("only the server may send child-event payloads", async () => {
  const f = fixture();
  const child = await f.connect("child");
  const parent = await f.connect("parent", [RELAY_PROTOCOL_VERSION, CHILD_EVENT_RELAY_PROTOCOL]);
  const spoof = (target: RelayEndpoint, payload: unknown): RelayEnvelope => ({ envelopeId: randomUUID(), protocolVersion: RELAY_PROTOCOL_VERSION,
    source: child.endpoint, target, payload, createdAt: new Date(NOW).toISOString() });
  expect(await f.gateway.request({ ...child, operation: "send", envelope: spoof(parent.endpoint, childEvent()) }))
    .toMatchObject({ ok: false, error: { code: "SOURCE_MISMATCH" } });
  // The same envelope with an ordinary payload is accepted, so the kind is the reason.
  take(await f.gateway.request({ ...child, operation: "send", envelope: spoof(parent.endpoint, { text: "ordinary" }) }), "accepted");

  const peer = (payload: unknown) => ({ operation: "receivePeer", profile, epoch: f.gateway.epoch, sourceEpoch: randomUUID(),
    origin: "https://sender.tail123.ts.net", envelope: { ...spoof(parent.endpoint, payload), source: { relay: RELAY_ID, id: randomUUID() } } });
  expect(await f.gateway.peer(peer(childEvent()))).toMatchObject({ ok: false, error: { code: "SOURCE_MISMATCH" } });
  take(await f.gateway.peer(peer({ text: "ordinary" })), "accepted");
});

test("the relay worker exposes the host envelope operation", async () => {
  const inspect = async (selector: string) => ({ ok: true as const, session: selector, sessionId: selector, projectPath: "/tmp", harness: AGENT_KIND.PI.id, alive: true });
  const gateway = new WorkerRelayGateway({ root: mkdtempSync(join(tmpdir(), "relay-host-envelope-")), inspectSession: inspect });
  gateways.push(gateway);
  await gateway.initialize();
  const connected = await gateway.volatile({ profile, operation: "connect", callerSession: "parent", generation: "g",
    protocolVersions: [RELAY_PROTOCOL_VERSION, CHILD_EVENT_RELAY_PROTOCOL] });
  if (!connected.ok || connected.value.kind !== "connected") throw new Error(JSON.stringify(connected));
  const input = { ...hostInput("parent"), createdAt: new Date().toISOString() };
  expect(await gateway.hostEnvelope(input)).toEqual({ kind: "accepted", duplicate: false });
  expect(await gateway.hostEnvelope({ ...input, targetSession: "nobody" })).toEqual({ kind: "unsupported" });
});

test("a worker reset after the send reports uncertain acceptance; a closed worker reports a definite rejection (review A2-2)", async () => {
  const inspect = async (selector: string) => ({ ok: true as const, session: selector, sessionId: selector, projectPath: "/tmp", harness: AGENT_KIND.PI.id, alive: true });
  const gateway = new WorkerRelayGateway({ root: mkdtempSync(join(tmpdir(), "relay-host-envelope-reset-")), inspectSession: inspect });
  gateways.push(gateway);
  const input = { ...hostInput("parent"), createdAt: new Date().toISOString() };
  // The request is handed to the worker; the reset can come before or after the store accepted it.
  const inFlight = gateway.hostEnvelope(input);
  await gateway.close();
  expect(await inFlight).toEqual({ kind: "failed", code: "RELAY_RESET", acceptance: HOST_ENVELOPE_ACCEPTANCE.UNCERTAIN });
  // A closed worker never receives the request.
  expect(await gateway.hostEnvelope(input)).toEqual({ kind: "failed", code: "RELAY_RESET", acceptance: HOST_ENVELOPE_ACCEPTANCE.REJECTED });
});

test("a gateway failure before the store accepted is a definite rejection (review A2-2)", async () => {
  const f = fixture();
  expect(await f.gateway.hostEnvelope({ ...hostInput(f.id("parent")), createdAt: "not a time" }))
    .toEqual({ kind: "failed", code: "INVALID_REQUEST", acceptance: HOST_ENVELOPE_ACCEPTANCE.REJECTED });
});

test("a relay that accepted and then reset gives one relay delivery and no typed note; a definite rejection gives one note (review A2-2)", async () => {
  const f = fixture();
  const parent = await f.connect("parent", [RELAY_PROTOCOL_VERSION, CHILD_EVENT_RELAY_PROTOCOL]);
  const payload = (seq: number): ChildEventPayload => ({
    kind: CHILD_EVENT_PAYLOAD_KIND, eventId: `child:boot:${seq}`, bootId: "boot", seq, childSessionId: f.id("child"), childName: "child",
    parentSessionId: f.id("parent"), event: CHILD_EVENT.DONE, state: AGENT_STATUS_STATE.IDLE, observedAt: new Date(NOW).toISOString(),
  });
  const notes: string[] = [];
  let reply: "reset-after-accept" | "rejected" = "reset-after-accept";
  const delivery = createChildEventDelivery({
    hostEnvelope: async input => {
      if (reply === "rejected") return { kind: "failed", code: "RELAY_CAPACITY", acceptance: HOST_ENVELOPE_ACCEPTANCE.REJECTED };
      await f.gateway.hostEnvelope(input);
      return { kind: "failed", code: "RELAY_RESET", acceptance: HOST_ENVELOPE_ACCEPTANCE.UNCERTAIN };
    },
    send: async (_sessionId, _name, text) => {
      notes.push(text);
      return { delivery: SESSION_SEND_DELIVERY.DELIVERED, outcome: SESSION_SEND_OUTCOME.SUBMITTED, observedMs: 1 };
    },
    typedNotesEnabled: () => true,
    lastViewerInputAt: () => undefined,
    now: () => NOW,
  });
  const observeIdleParent = async () => {
    delivery.observeParent({ sessionId: f.id("parent"), name: "parent", alive: true, runtimeState: {
      state: AGENT_STATUS_STATE.IDLE, authority: AGENT_STATUS_AUTHORITY.PROGRAM, freshness: AGENT_STATUS_FRESHNESS.FRESH, stale: false } });
    await new Promise(resolve => setTimeout(resolve, 0));
  };

  await delivery.deliver({ parentSessionName: "parent", childEvent: payload(1) });
  await observeIdleParent();
  expect(take(await f.gateway.request({ ...parent, operation: "receive", cursor: "0" }), "page").deliveries).toHaveLength(1);
  expect(notes).toEqual([]);

  reply = "rejected";
  await delivery.deliver({ parentSessionName: "parent", childEvent: payload(2) });
  await observeIdleParent();
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("child done");
});
