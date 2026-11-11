import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_STATUS_AUTHORITY, AGENT_STATUS_FRESHNESS, AGENT_STATUS_STATE } from "../../src/agent-status-contract.ts";
import { CHILD_EVENT, CHILD_EVENT_PAYLOAD_KIND, CHILD_EVENT_RELAY_PROTOCOL, type ChildEventPayload } from "../../src/child-event-contract.ts";
import { createChildEventDelivery } from "../../src/server/child-event-delivery.ts";
import { SESSION_SEND_DELIVERY, SESSION_SEND_OUTCOME } from "../../src/session-send-contract.ts";
import { RELAY_PROTOCOL_VERSION } from "../../src/task-relay/domain.ts";
import { createTaskRelayGateway } from "../../src/task-relay/gateway.ts";
import { createRecoveryStore } from "../../src/task-relay/recovery-store.ts";
import { HOST_ENVELOPE_ACCEPTANCE, type VolatileResult } from "../../src/task-relay/volatile-protocol.ts";

/** The server's own relay source session (volatile-gateway.ts HOST_SOURCE_SESSION). */
const HOST_SOURCE_SESSION = "wolfpack-server/host";

function inspectSession(root: string) {
  return async (selector: string) => ({ ok: true as const, session: "parent", sessionId: selector, projectPath: root, harness: "pi", alive: true });
}

function connected(result: VolatileResult) {
  if (!result.ok || result.value.kind !== "connected") throw new Error(`connect failed: ${JSON.stringify(result)}`);
  return { epoch: result.epoch, endpoint: result.value.endpoint };
}

function payload(parentSessionId: string, seq = 1): ChildEventPayload {
  return {
    kind: CHILD_EVENT_PAYLOAD_KIND, eventId: `child:boot:${seq}`, bootId: "boot", seq, childSessionId: randomUUID(), childName: "child",
    parentSessionId, event: CHILD_EVENT.DONE, state: AGENT_STATUS_STATE.IDLE, observedAt: new Date().toISOString(),
  };
}

function hostInput(targetSession: string, seq = 1) {
  return {
    targetSession,
    requiredProtocol: CHILD_EVENT_RELAY_PROTOCOL,
    envelopeId: `wolfpack.child_event:child:boot:${seq}`,
    payload: payload(targetSession, seq),
    createdAt: new Date().toISOString(),
  };
}

test("a SQLite owner failure during a host envelope is uncertain acceptance and suppresses the typed note", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-host-owner-failure-")), parentId = randomUUID();
  // A real journal write failure scoped to the server's own source registration.
  createRecoveryStore({ root }).close();
  const db = new Database(join(root, "restart-safe-v1.sqlite"));
  db.exec(`CREATE TRIGGER fail_host_source BEFORE INSERT ON cells
    WHEN NEW.bucket='registrations' AND json_extract(NEW.value, '$.value.sessionId')='${HOST_SOURCE_SESSION}'
    BEGIN SELECT RAISE(FAIL, 'private fixture host source write failure'); END;`);
  db.close();
  const gateway = createTaskRelayGateway({ root, storage: "sqlite", inspectSession: inspectSession(root) });
  const notes: string[] = [];
  const delivery = createChildEventDelivery({
    hostEnvelope: input => gateway.hostEnvelope(input),
    send: async (_sessionId, _name, text) => {
      notes.push(text);
      return { delivery: SESSION_SEND_DELIVERY.DELIVERED, outcome: SESSION_SEND_OUTCOME.SUBMITTED, observedMs: 1 };
    },
    typedNotesEnabled: () => true,
    lastViewerInputAt: () => undefined,
    now: () => Date.now(),
  });
  try {
    await gateway.initialize();
    connected(await gateway.volatile({ operation: "connect", profile: gateway.profile, callerSession: parentId, generation: randomUUID(),
      protocolVersions: [RELAY_PROTOCOL_VERSION, CHILD_EVENT_RELAY_PROTOCOL] }));

    expect(await gateway.hostEnvelope(hostInput(parentId))).toMatchObject({ kind: "failed", acceptance: HOST_ENVELOPE_ACCEPTANCE.UNCERTAIN });

    // Through child-event delivery: the replacement owner hits the same failure, and the note stays suppressed.
    await Bun.sleep(1100); // Past the first recovery cooldown, so a replacement owner receives the send.
    await delivery.deliver({ parentSessionName: "parent", childEvent: payload(parentId, 2) });
    delivery.observeParent({ sessionId: parentId, name: "parent", alive: true, runtimeState: {
      state: AGENT_STATUS_STATE.IDLE, authority: AGENT_STATUS_AUTHORITY.PROGRAM, freshness: AGENT_STATUS_FRESHNESS.FRESH, stale: false } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(notes).toEqual([]);
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);

test("a child event accepted into a SQLite relay is still received by the same endpoint after the journal reopens", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-host-reopen-")), parentId = randomUUID(), generation = randomUUID();
  const options = { root, storage: "sqlite" as const, inspectSession: inspectSession(root) };
  const connect = (gateway: ReturnType<typeof createTaskRelayGateway>) => gateway.volatile({ operation: "connect", profile: gateway.profile,
    callerSession: parentId, generation, protocolVersions: [RELAY_PROTOCOL_VERSION, CHILD_EVENT_RELAY_PROTOCOL] });
  let gateway = createTaskRelayGateway(options);
  try {
    await gateway.initialize();
    const first = connected(await connect(gateway));
    expect(await gateway.hostEnvelope(hostInput(parentId))).toEqual({ kind: "accepted", duplicate: false });
    await gateway.close();

    gateway = createTaskRelayGateway(options);
    await gateway.initialize();
    const page = await gateway.volatile({ operation: "receive", profile: gateway.profile, epoch: first.epoch, callerSession: parentId,
      endpoint: first.endpoint, cursor: "0" });
    if (!page.ok || page.value.kind !== "page") throw new Error(`receive failed: ${JSON.stringify(page)}`);
    expect(page.value.deliveries.map(item => item.envelope.envelopeId)).toEqual(["wolfpack.child_event:child:boot:1"]);
    expect(page.value.deliveries[0]!.envelope.payload).toMatchObject({ kind: CHILD_EVENT_PAYLOAD_KIND, parentSessionId: parentId });
    // The same generation reconnects to the same endpoint.
    expect(connected(await connect(gateway)).endpoint).toEqual(first.endpoint);
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);
