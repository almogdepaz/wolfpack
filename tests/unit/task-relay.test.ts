import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isJsonValue, RELAY_ERROR, RELAY_ID, RELAY_LIMITS, RELAY_PROTOCOL_VERSION } from "../../src/task-relay/domain.ts";
import type { RelayEnvelope } from "../../src/task-relay/domain.ts";
import { TaskRelayGateway } from "../../src/task-relay/gateway.ts";
import { MalformedRelayStoreError, TaskRelayStore } from "../../src/task-relay/store.ts";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const session = (sessionId: string, harness = "pi", alive = true) => async (selector: string) => selector === sessionId
  ? { ok: true as const, session: selector, sessionId, projectPath: "/tmp", harness, alive }
  : { ok: false as const, code: "NOT_FOUND" as const };

function root(): string {
  return mkdtempSync(join(tmpdir(), "wolfpack-task-relay-"));
}

async function connect(gateway: TaskRelayGateway, sessionId: string, generation = "process-1") {
  const connected = await gateway.connect({ callerSession: sessionId, generation, protocolVersions: [RELAY_PROTOCOL_VERSION] });
  expect(connected.ok).toBe(true);
  if (!connected.ok) throw new Error("expected relay connection");
  return connected.endpoint;
}

const SENDER_ID = "0accef20-3e6b-4bdd-9faf-1d875b07112a";
const RECEIVER_ID = "8e5fbbf1-fbc8-4a45-a73f-b10239428c65";
const ROUTE_ID = `${RELAY_ID}:peer:813dcecd-2787-4455-a260-9ce19b9d9bbf`;
const PEER_ORIGIN = "https://receiver.example.ts.net";
const LOCAL_ENVELOPE: RelayEnvelope = {
  envelopeId: "stored-local-envelope",
  protocolVersion: RELAY_PROTOCOL_VERSION,
  source: { relay: RELAY_ID, id: SENDER_ID },
  target: { relay: RELAY_ID, id: RECEIVER_ID },
  payload: { opaque: true },
  createdAt: NOW.toISOString(),
};
const REMOTE_ENVELOPE: RelayEnvelope = {
  ...LOCAL_ENVELOPE,
  envelopeId: "stored-remote-envelope",
  target: { relay: ROUTE_ID, id: RECEIVER_ID },
};
const VALID_REGISTRATION = {
  endpoint: { relay: RELAY_ID, id: SENDER_ID },
  sessionId: "sender",
  generation: "sender-generation",
  protocolVersions: [RELAY_PROTOCOL_VERSION],
  leaseExpiresAt: "2026-08-09T00:01:00.000Z",
};
const VALID_STORED_ENVELOPE = {
  envelope: LOCAL_ENVELOPE,
  digest: "00270c4e435d6d3dcd38b9d100b20162655af332b2cd7e3bb56046419d4d736b",
  acceptedAt: NOW.toISOString(),
  acceptanceId: "ad5bac02-2eef-4ae7-9099-e60b74313abc",
};
const VALID_MAILBOX_ITEM = {
  endpointId: RECEIVER_ID,
  envelopeId: LOCAL_ENVELOPE.envelopeId,
  cursor: "1",
  acknowledgedAt: undefined,
};
const VALID_PEER_ROUTE = { id: ROUTE_ID, origin: PEER_ORIGIN };
const VALID_OUTBOX_ITEM = {
  envelope: REMOTE_ENVELOPE,
  peerOrigin: PEER_ORIGIN,
  digest: "8431c2702d805570009cb80552a92b9fdc1f104a6acf128b639c762926b94d34",
  acceptanceId: "510ba100-e8a7-4ba8-89bd-e92c99e52a2e",
  queuedAt: NOW.toISOString(),
  attempts: 1,
  lastAttemptAt: NOW.toISOString(),
  forwardedAt: undefined,
  exhaustedAt: undefined,
  lastError: "peer unavailable",
};
const VALID_RELAY_STATE = {
  version: 2,
  registrations: [VALID_REGISTRATION],
  envelopes: [VALID_STORED_ENVELOPE],
  mailbox: [VALID_MAILBOX_ITEM],
  peerRoutes: [VALID_PEER_ROUTE],
  outbox: [VALID_OUTBOX_ITEM],
};
function storeOperations(store: TaskRelayStore): readonly (() => Promise<unknown>)[] {
  return [
    () => store.register(VALID_REGISTRATION),
    () => store.registrationForSession("sender", NOW),
    () => store.registration(SENDER_ID, NOW),
    () => store.deactivateRegistration("sender", SENDER_ID, NOW.toISOString()),
    () => store.accept(LOCAL_ENVELOPE, NOW.toISOString()),
    () => store.inbox(RECEIVER_ID, "0"),
    () => store.acknowledge(RECEIVER_ID, LOCAL_ENVELOPE.envelopeId, NOW.toISOString()),
    () => store.peerRoute(PEER_ORIGIN),
    () => store.peerOrigin(ROUTE_ID),
    () => store.queuePeer({
      envelope: REMOTE_ENVELOPE,
      peerOrigin: PEER_ORIGIN,
      queuedAt: NOW.toISOString(),
      attempts: 0,
      lastAttemptAt: undefined,
      forwardedAt: undefined,
      exhaustedAt: undefined,
      lastError: undefined,
    }),
    () => store.outbox(),
    () => store.updateOutbox(REMOTE_ENVELOPE.envelopeId, item => item),
    () => store.cleanup(NOW),
  ];
}

async function expectMalformedRelayStore(operation: () => Promise<unknown>, label = "malformed store"): Promise<void> {
  try {
    await operation();
    throw new Error("expected malformed relay store failure");
  } catch (error) {
    expect(error, label).toBeInstanceOf(MalformedRelayStoreError);
    if (!(error instanceof Error)) throw error;
    expect(error.message, label).toBe("relay store is malformed");
  }
}

function rawOverflowState(): string {
  const marker = "raw-overflow-payload";
  const state = {
    ...VALID_RELAY_STATE,
    envelopes: [{ ...VALID_STORED_ENVELOPE, envelope: { ...LOCAL_ENVELOPE, payload: marker } }],
  };
  return JSON.stringify(state).replace(JSON.stringify(marker), "1e400");
}

describe("pi tasks relay v2", () => {
  test("authenticates a generation-bound source, accepts opaque payloads exactly once, and retains ordered mailbox delivery until acknowledgement", async () => {
    const directory = root();
    try {
      const gateway = new TaskRelayGateway({ root: directory, inspectSession: session("sender"), now: () => NOW });
      const sender = await connect(gateway, "sender");
      const receiverGateway = new TaskRelayGateway({ root: directory, inspectSession: session("receiver"), now: () => NOW });
      const receiver = await connect(receiverGateway, "receiver");
      const envelope = {
        envelopeId: "envelope-1",
        protocolVersion: RELAY_PROTOCOL_VERSION,
        source: sender,
        target: receiver,
        payload: { taskId: "this is opaque", kind: "assignment", nested: { terminal: "completed" } },
        createdAt: "opaque-client-clock",
      };

      await expect(gateway.send({ callerSession: "sender", envelope })).resolves.toMatchObject({ ok: true, kind: "accepted" });
      await expect(gateway.send({ callerSession: "sender", envelope })).resolves.toMatchObject({ ok: true, kind: "duplicate" });
      await expect(gateway.send({ callerSession: "sender", envelope: { ...envelope, source: receiver } })).resolves.toMatchObject({
        ok: false,
        error: { code: "SOURCE_MISMATCH" },
      });

      await expect(receiverGateway.receive({ callerSession: "receiver", cursor: "0" })).resolves.toMatchObject({
        ok: true,
        envelopes: [expect.objectContaining({ envelopeId: "envelope-1", payload: envelope.payload, createdAt: "opaque-client-clock" })],
        nextCursor: "1",
      });
      await expect(receiverGateway.acknowledgeDelivery({ callerSession: "receiver", envelopeId: "envelope-1" })).resolves.toMatchObject({ ok: true });
      await expect(receiverGateway.acknowledgeDelivery({ callerSession: "receiver", envelopeId: "envelope-1" })).resolves.toMatchObject({ ok: true, kind: "duplicate" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects stale, incompatible, cross-relay, and oversized endpoint envelopes without inspecting payload semantics", async () => {
    const directory = root();
    try {
      const gateway = new TaskRelayGateway({ root: directory, inspectSession: session("sender"), now: () => NOW });
      const sender = await connect(gateway, "sender");
      const targetGateway = new TaskRelayGateway({ root: directory, inspectSession: session("target"), now: () => NOW });
      const target = await connect(targetGateway, "target");
      const base = { envelopeId: "envelope-check", protocolVersion: RELAY_PROTOCOL_VERSION, source: sender, target, payload: { arbitrary: true }, createdAt: NOW.toISOString() };
      await expect(gateway.send({ callerSession: "sender", envelope: { ...base, target: { relay: "other-relay", id: target.id } } })).resolves.toMatchObject({ ok: false, error: { code: "CROSS_RELAY_ENDPOINT" } });
      await expect(gateway.send({ callerSession: "sender", envelope: { ...base, protocolVersion: 999 } })).resolves.toMatchObject({ ok: false, error: { code: "INCOMPATIBLE_PROTOCOL" } });
      await expect(gateway.send({ callerSession: "sender", envelope: { ...base, payload: "x".repeat(64 * 1024) } })).resolves.toMatchObject({ ok: false, error: { code: "PAYLOAD_TOO_LARGE" } });
      await expect(gateway.connect({ callerSession: "sender", generation: "process-2", protocolVersions: [99] })).resolves.toMatchObject({ ok: false, error: { code: "INCOMPATIBLE_PROTOCOL" } });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("accepts ordinary JSON payloads and rejects unsafe values without throwing", async () => {
    const directory = root();
    try {
      const senderGateway = new TaskRelayGateway({ root: directory, inspectSession: session("sender"), now: () => NOW });
      const targetGateway = new TaskRelayGateway({ root: directory, inspectSession: session("target"), now: () => NOW });
      const source = await connect(senderGateway, "sender");
      const target = await connect(targetGateway, "target");
      const base = { protocolVersion: RELAY_PROTOCOL_VERSION, source, target, createdAt: NOW.toISOString() };
      const cyclicPayload: Record<string, unknown> = {};
      cyclicPayload.self = cyclicPayload;
      const customToJson = [1];
      Object.defineProperty(customToJson, "toJSON", { enumerable: true, value: () => 1n });
      const throwingIndex = [1];
      Object.defineProperty(throwingIndex, "0", { enumerable: true, get: () => { throw new Error("index getter executed"); } });
      const revoked = Proxy.revocable([1], {});
      revoked.revoke();
      expect(isJsonValue(revoked.proxy)).toBe(false);

      await expect(senderGateway.send({ callerSession: "sender", envelope: { ...base, envelopeId: "bigint", payload: 1n } })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      await expect(senderGateway.send({ callerSession: "sender", envelope: { ...base, envelopeId: "cycle", payload: cyclicPayload } })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      await expect(senderGateway.send({ callerSession: "sender", envelope: { ...base, envelopeId: "custom-to-json", payload: customToJson } })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      await expect(senderGateway.send({ callerSession: "sender", envelope: { ...base, envelopeId: "throwing-index", payload: throwingIndex } })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      await expect(senderGateway.send({ callerSession: "sender", envelope: { ...base, envelopeId: "null", payload: null } })).resolves.toMatchObject({ ok: true });
      const shared = { value: 1 };
      await expect(senderGateway.send({ callerSession: "sender", envelope: { ...base, envelopeId: "shared", payload: { left: shared, right: shared } } })).resolves.toMatchObject({ ok: true });
      await expect(senderGateway.send({ callerSession: "sender", envelope: { ...base, envelopeId: "frozen-array", payload: Object.freeze([1, { valid: true }]) } })).resolves.toMatchObject({ ok: true });
      await expect(targetGateway.receive({ callerSession: "target", cursor: "0" })).resolves.toMatchObject({
        ok: true,
        envelopes: [
          expect.objectContaining({ envelopeId: "null", payload: null }),
          expect.objectContaining({ envelopeId: "shared", payload: { left: { value: 1 }, right: { value: 1 } } }),
          expect.objectContaining({ envelopeId: "frozen-array", payload: [1, { valid: true }] }),
        ],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("registers any live local session without classifying its harness", async () => {
    expect(Object.values(RELAY_ERROR)).not.toContain("CALLER_NOT_PI");
    const directory = root();
    try {
      const shellGateway = new TaskRelayGateway({ root: directory, inspectSession: session("shell", "shell"), now: () => NOW });
      await expect(shellGateway.connect({ callerSession: "shell", generation: "shell-process", protocolVersions: [RELAY_PROTOCOL_VERSION] })).resolves.toMatchObject({ ok: true });

      const deadGateway = new TaskRelayGateway({ root: directory, inspectSession: session("dead", "pi", false), now: () => NOW });
      await expect(deadGateway.connect({ callerSession: "dead", generation: "dead-process", protocolVersions: [RELAY_PROTOCOL_VERSION] })).resolves.toMatchObject({ ok: false, error: { code: "CALLER_DEAD" } });

      const missingGateway = new TaskRelayGateway({ root: directory, inspectSession: session("known"), now: () => NOW });
      await expect(missingGateway.connect({ callerSession: "missing", generation: "missing-process", protocolVersions: [RELAY_PROTOCOL_VERSION] })).resolves.toMatchObject({ ok: false, error: { code: "CALLER_NOT_FOUND" } });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("preserves endpoint identity when the same generation renews an expired lease", async () => {
    const directory = root();
    let now = NOW;
    try {
      const gateway = new TaskRelayGateway({ root: directory, inspectSession: session("sender"), now: () => now });
      const original = await connect(gateway, "sender", "generation-1");
      now = new Date(NOW.getTime() + RELAY_LIMITS.LEASE_MS + 1);
      const renewed = await connect(gateway, "sender", "generation-1");
      expect(renewed).toEqual(original);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("continues mailbox cursors when the same generation reconnects after lease expiry", async () => {
    const directory = root();
    let now = NOW;
    try {
      const senderGateway = new TaskRelayGateway({ root: directory, inspectSession: session("sender"), now: () => now });
      const receiverGateway = new TaskRelayGateway({ root: directory, inspectSession: session("receiver"), now: () => now });
      const sender = await connect(senderGateway, "sender", "sender-generation");
      const receiver = await connect(receiverGateway, "receiver", "receiver-generation");
      const firstEnvelope = { envelopeId: "before-expiry", protocolVersion: RELAY_PROTOCOL_VERSION, source: sender, target: receiver, payload: { order: 1 }, createdAt: now.toISOString() };
      await expect(senderGateway.send({ callerSession: "sender", envelope: firstEnvelope })).resolves.toMatchObject({ ok: true });
      await expect(receiverGateway.receive({ callerSession: "receiver", cursor: "0" })).resolves.toMatchObject({
        ok: true,
        envelopes: [expect.objectContaining({ envelopeId: "before-expiry" })],
        nextCursor: "1",
      });

      now = new Date(NOW.getTime() + RELAY_LIMITS.LEASE_MS + 1);
      const renewedSender = await connect(senderGateway, "sender", "sender-generation");
      const renewedReceiver = await connect(receiverGateway, "receiver", "receiver-generation");
      const secondEnvelope = { envelopeId: "after-expiry", protocolVersion: RELAY_PROTOCOL_VERSION, source: renewedSender, target: renewedReceiver, payload: { order: 2 }, createdAt: now.toISOString() };
      await expect(senderGateway.send({ callerSession: "sender", envelope: secondEnvelope })).resolves.toMatchObject({ ok: true });
      await expect(receiverGateway.receive({ callerSession: "receiver", cursor: "1" })).resolves.toMatchObject({
        ok: true,
        envelopes: [expect.objectContaining({ envelopeId: "after-expiry" })],
        nextCursor: "2",
      });
      expect(renewedSender).toEqual(sender);
      expect(renewedReceiver).toEqual(receiver);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("continues mailbox cursors when the same generation reconnects after disconnect", async () => {
    const directory = root();
    try {
      const senderGateway = new TaskRelayGateway({ root: directory, inspectSession: session("sender"), now: () => NOW });
      const receiverGateway = new TaskRelayGateway({ root: directory, inspectSession: session("receiver"), now: () => NOW });
      const sender = await connect(senderGateway, "sender", "sender-generation");
      const receiver = await connect(receiverGateway, "receiver", "receiver-generation");
      const firstEnvelope = { envelopeId: "before-disconnect", protocolVersion: RELAY_PROTOCOL_VERSION, source: sender, target: receiver, payload: { order: 1 }, createdAt: NOW.toISOString() };
      await expect(senderGateway.send({ callerSession: "sender", envelope: firstEnvelope })).resolves.toMatchObject({ ok: true });
      await expect(receiverGateway.receive({ callerSession: "receiver", cursor: "0" })).resolves.toMatchObject({
        ok: true,
        envelopes: [expect.objectContaining({ envelopeId: "before-disconnect" })],
        nextCursor: "1",
      });

      await expect(receiverGateway.disconnect({ callerSession: "receiver", endpoint: receiver })).resolves.toEqual({ ok: true });
      await expect(senderGateway.resolve({ callerSession: "sender", target: receiver, protocolVersion: RELAY_PROTOCOL_VERSION })).resolves.toMatchObject({
        ok: false,
        error: { code: "TARGET_NOT_REGISTERED" },
      });
      const reconnectedReceiver = await connect(receiverGateway, "receiver", "receiver-generation");
      expect(reconnectedReceiver).toEqual(receiver);

      const secondEnvelope = { envelopeId: "after-disconnect", protocolVersion: RELAY_PROTOCOL_VERSION, source: sender, target: reconnectedReceiver, payload: { order: 2 }, createdAt: NOW.toISOString() };
      await expect(senderGateway.send({ callerSession: "sender", envelope: secondEnvelope })).resolves.toMatchObject({ ok: true });
      await expect(receiverGateway.receive({ callerSession: "receiver", cursor: "1" })).resolves.toMatchObject({
        ok: true,
        envelopes: [expect.objectContaining({ envelopeId: "after-disconnect" })],
        nextCursor: "2",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("expires leases and invalidates the prior endpoint when a process generation reconnects", async () => {
    const directory = root();
    let now = NOW;
    try {
      const senderGateway = new TaskRelayGateway({ root: directory, inspectSession: session("sender"), now: () => now });
      const targetGateway = new TaskRelayGateway({ root: directory, inspectSession: session("target"), now: () => now });
      const original = await connect(senderGateway, "sender", "generation-1");
      const target = await connect(targetGateway, "target");
      const envelope = { envelopeId: "generation-envelope", protocolVersion: RELAY_PROTOCOL_VERSION, source: original, target, payload: { opaque: true }, createdAt: now.toISOString() };
      const replacement = await connect(senderGateway, "sender", "generation-2");
      expect(replacement.id).not.toBe(original.id);
      await expect(senderGateway.send({ callerSession: "sender", envelope })).resolves.toMatchObject({ ok: false, error: { code: "REGISTRATION_EXPIRED" } });
      now = new Date(NOW.getTime() + 60_001);
      await expect(senderGateway.resolve({ callerSession: "sender", target, protocolVersion: RELAY_PROTOCOL_VERSION })).resolves.toMatchObject({ ok: false, error: { code: "TARGET_NOT_REGISTERED" } });
      await expect(senderGateway.resolve({ callerSession: "sender", target: { relay: RELAY_ID, id: "target" }, protocolVersion: RELAY_PROTOCOL_VERSION })).resolves.toMatchObject({ ok: false, error: { code: "INCOMPATIBLE_PROTOCOL" } });
      await expect(senderGateway.resolve({ callerSession: "sender", target: { relay: RELAY_ID, id: "https://receiver.example.ts.net" }, protocolVersion: RELAY_PROTOCOL_VERSION })).resolves.toMatchObject({ ok: false, error: { code: "INCOMPATIBLE_PROTOCOL" } });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("persists a remote outbox before forwarding and receiver deduplicates a lost response", async () => {
    const senderRoot = root();
    const receiverRoot = root();
    let now = NOW;
    try {
      let receiver: TaskRelayGateway;
      let loseResponse = true;
      const sender = new TaskRelayGateway({
        root: senderRoot,
        inspectSession: session("sender"),
        now: () => now,
        peerOrigin: "https://sender.example.ts.net",
        peerFetch: async (_url, init) => {
          const accepted = await receiver.receivePeer(JSON.parse(String(init?.body)));
          if (loseResponse) {
            loseResponse = false;
            throw new Error("lost after durable peer acceptance");
          }
          return Response.json(accepted);
        },
      });
      receiver = new TaskRelayGateway({ root: receiverRoot, inspectSession: session("receiver"), now: () => NOW, peerOrigin: "https://receiver.example.ts.net" });
      const source = await connect(sender, "sender");
      const target = await connect(receiver, "receiver");
      const remoteTarget = { relay: await sender.peerRelay("https://receiver.example.ts.net"), id: target.id };
      const envelope = { envelopeId: "remote-envelope", protocolVersion: RELAY_PROTOCOL_VERSION, source, target: remoteTarget, payload: { any: "payload" }, createdAt: NOW.toISOString() };

      await expect(sender.send({ callerSession: "sender", envelope })).resolves.toMatchObject({ ok: true, forwarding: "pending" });
      await expect(receiver.receive({ callerSession: "receiver", cursor: "0" })).resolves.toMatchObject({ ok: true, envelopes: [expect.objectContaining({ envelopeId: "remote-envelope" })] });
      now = new Date(now.getTime() + RELAY_LIMITS.FORWARD_RETRY_MS);
      await expect(sender.flushPeerOutbox()).resolves.toMatchObject({ forwarded: 1, pending: 0 });
      await expect(receiver.receive({ callerSession: "receiver", cursor: "0" })).resolves.toMatchObject({ ok: true, envelopes: [expect.anything()] });
    } finally {
      rmSync(senderRoot, { recursive: true, force: true });
      rmSync(receiverRoot, { recursive: true, force: true });
    }
  });

  test("preserves peer source routes so the receiver can reply", async () => {
    const senderRoot = root();
    const receiverRoot = root();
    let sender: TaskRelayGateway | undefined;
    let receiver: TaskRelayGateway | undefined;
    try {
      const senderOrigin = "https://sender.example.ts.net";
      const receiverOrigin = "https://receiver.example.ts.net";
      sender = new TaskRelayGateway({
        root: senderRoot,
        inspectSession: session("sender"),
        now: () => NOW,
        peerOrigin: senderOrigin,
        peerFetch: async (_url, init) => Response.json(await receiver!.receivePeer(JSON.parse(String(init?.body)))),
      });
      receiver = new TaskRelayGateway({
        root: receiverRoot,
        inspectSession: session("receiver"),
        now: () => NOW,
        peerOrigin: receiverOrigin,
        peerFetch: async (_url, init) => Response.json(await sender!.receivePeer(JSON.parse(String(init?.body)))),
      });
      const source = await connect(sender, "sender");
      const target = await connect(receiver, "receiver");
      const remoteTarget = { relay: await sender.peerRelay(receiverOrigin), id: target.id };
      const outbound = { envelopeId: "peer-question", protocolVersion: RELAY_PROTOCOL_VERSION, source, target: remoteTarget, payload: { question: true }, createdAt: NOW.toISOString() };

      await expect(sender.send({ callerSession: "sender", envelope: outbound })).resolves.toMatchObject({ ok: true, forwarding: "forwarded" });
      const received = await receiver.receive({ callerSession: "receiver", cursor: "0" });
      if (!received.ok) throw new Error("expected receiver inbox");
      expect(received.envelopes[0]?.envelopeId).toBe("peer-question");
      expect(received.envelopes[0]?.source?.relay).toMatch(/^wolfpack-pi-tasks-v2:peer:/);

      await expect(receiver.send({
        callerSession: "receiver",
        envelope: { envelopeId: "peer-answer", protocolVersion: RELAY_PROTOCOL_VERSION, source: target, target: received.envelopes[0]!.source, payload: { answer: true }, createdAt: NOW.toISOString() },
      })).resolves.toMatchObject({ ok: true, forwarding: "forwarded" });
      await expect(sender.receive({ callerSession: "sender", cursor: "0" })).resolves.toMatchObject({
        ok: true,
        envelopes: [expect.objectContaining({ envelopeId: "peer-answer", payload: { answer: true } })],
      });
    } finally {
      sender?.close();
      receiver?.close();
      rmSync(senderRoot, { recursive: true, force: true });
      rmSync(receiverRoot, { recursive: true, force: true });
    }
  });

  test("persists opaque peer routes and recovers remote forwarding without a sender mailbox", async () => {
    const senderRoot = root();
    const receiverRoot = root();
    let sender: TaskRelayGateway | undefined;
    let restarted: TaskRelayGateway | undefined;
    try {
      let receiver: TaskRelayGateway;
      let available = false;
      const peerOrigin = "https://receiver.example.ts.net";
      const peerFetch = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (!available) throw new Error("peer is offline");
        return Response.json(await receiver.receivePeer(JSON.parse(String(init?.body))));
      };
      sender = new TaskRelayGateway({ root: senderRoot, inspectSession: session("sender"), now: () => NOW, peerOrigin: "https://sender.example.ts.net", peerFetch });
      receiver = new TaskRelayGateway({ root: receiverRoot, inspectSession: session("receiver"), now: () => NOW, peerOrigin });
      const source = await connect(sender, "sender");
      const target = await connect(receiver, "receiver");
      const remoteTarget = { relay: await sender.peerRelay(peerOrigin), id: target.id };
      expect(remoteTarget.relay).toMatch(/^wolfpack-pi-tasks-v2:peer:[0-9a-f-]{36}$/);
      const envelope = { envelopeId: "restart-envelope", protocolVersion: RELAY_PROTOCOL_VERSION, source, target: remoteTarget, payload: { opaque: true }, createdAt: NOW.toISOString() };

      await expect(sender.send({ callerSession: "sender", envelope })).resolves.toMatchObject({ ok: true, forwarding: "pending" });
      const beforeRestart = JSON.parse(readFileSync(join(senderRoot, "relay-state.json"), "utf8"));
      expect(beforeRestart.mailbox).toEqual([]);
      expect(beforeRestart.envelopes).toEqual([]);
      expect(beforeRestart.peerRoutes).toEqual([{ id: remoteTarget.relay, origin: peerOrigin }]);

      available = true;
      restarted = new TaskRelayGateway({ root: senderRoot, inspectSession: session("sender"), now: () => NOW, peerOrigin: "https://sender.example.ts.net", peerFetch });
      await expect(restarted.peerRelay(peerOrigin)).resolves.toBe(remoteTarget.relay);
      await restarted.initialize();
      await expect(receiver.receive({ callerSession: "receiver", cursor: "0" })).resolves.toMatchObject({
        ok: true,
        envelopes: [expect.objectContaining({ envelopeId: "restart-envelope" })],
      });
      await restarted.cleanup(new Date(NOW.getTime() + 1));
      const afterCleanup = JSON.parse(readFileSync(join(senderRoot, "relay-state.json"), "utf8"));
      expect(afterCleanup.outbox).toEqual([]);
    } finally {
      if (sender && "close" in sender) (sender as { close(): void }).close();
      if (restarted && "close" in restarted) (restarted as { close(): void }).close();
      rmSync(senderRoot, { recursive: true, force: true });
      rmSync(receiverRoot, { recursive: true, force: true });
    }
  });

  test("does not spend retry attempts when a duplicate remote send arrives before its retry window", async () => {
    const directory = root();
    try {
      const gateway = new TaskRelayGateway({
        root: directory,
        inspectSession: session("sender"),
        now: () => NOW,
        peerOrigin: "https://sender.example.ts.net",
        peerFetch: async () => { throw new Error("peer is offline"); },
      });
      const source = await connect(gateway, "sender");
      const target = { relay: await gateway.peerRelay("https://receiver.example.ts.net"), id: "2af8af29-c4fe-44f9-9a99-9a0e35952d74" };
      const envelope = { envelopeId: "duplicate-pending-envelope", protocolVersion: RELAY_PROTOCOL_VERSION, source, target, payload: { opaque: true }, createdAt: NOW.toISOString() };

      await expect(gateway.send({ callerSession: "sender", envelope })).resolves.toMatchObject({ ok: true, kind: "accepted", forwarding: "pending" });
      await expect(gateway.send({ callerSession: "sender", envelope })).resolves.toMatchObject({ ok: true, kind: "duplicate", forwarding: "pending" });

      const state = JSON.parse(readFileSync(join(directory, "relay-state.json"), "utf8"));
      expect(state.outbox).toEqual([expect.objectContaining({ attempts: 1, lastError: "peer unavailable" })]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("single-flights slow peer forwarding so concurrent retries do not exceed the attempt limit", async () => {
    const directory = root();
    let releasePeer: (() => void) | undefined;
    let peerStarted: (() => void) | undefined;
    const peerStartedPromise = new Promise<void>((resolve) => { peerStarted = resolve; });
    const peerReleasePromise = new Promise<void>((resolve) => { releasePeer = resolve; });
    let peerRequests = 0;
    try {
      const gateway = new TaskRelayGateway({
        root: directory,
        inspectSession: session("sender"),
        now: () => NOW,
        peerOrigin: "https://sender.example.ts.net",
        peerFetch: async () => {
          peerRequests += 1;
          peerStarted?.();
          await peerReleasePromise;
          return Response.json({ ok: true });
        },
      });
      const source = await connect(gateway, "sender");
      const target = { relay: await gateway.peerRelay("https://receiver.example.ts.net"), id: "2af8af29-c4fe-44f9-9a99-9a0e35952d74" };
      const envelope = { envelopeId: "slow-peer-envelope", protocolVersion: RELAY_PROTOCOL_VERSION, source, target, payload: { opaque: true }, createdAt: NOW.toISOString() };

      const sending = gateway.send({ callerSession: "sender", envelope });
      await peerStartedPromise;
      const flushing = Promise.all(Array.from({ length: RELAY_LIMITS.MAX_FORWARD_ATTEMPTS + 1 }, () => gateway.flushPeerOutbox(true)));
      await Promise.resolve();
      releasePeer?.();

      await expect(sending).resolves.toMatchObject({ ok: true, forwarding: "forwarded" });
      await expect(flushing).resolves.toEqual(Array.from({ length: RELAY_LIMITS.MAX_FORWARD_ATTEMPTS + 1 }, () => ({ forwarded: 1, pending: 0 })));
      expect(peerRequests).toBe(1);
      const state = JSON.parse(readFileSync(join(directory, "relay-state.json"), "utf8"));
      expect(state.outbox).toEqual([expect.objectContaining({ attempts: 1, forwardedAt: NOW.toISOString() })]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retains recent forwarding diagnostics until their retention cutoff", async () => {
    const directory = root();
    try {
      const gateway = new TaskRelayGateway({
        root: directory,
        inspectSession: session("sender"),
        now: () => NOW,
        peerOrigin: "https://sender.example.ts.net",
        peerFetch: async () => Response.json({ ok: true }),
      });
      const source = await connect(gateway, "sender");
      const target = { relay: await gateway.peerRelay("https://receiver.example.ts.net"), id: "2af8af29-c4fe-44f9-9a99-9a0e35952d74" };
      const envelope = { envelopeId: "recent-forward-envelope", protocolVersion: RELAY_PROTOCOL_VERSION, source, target, payload: { opaque: true }, createdAt: NOW.toISOString() };

      await expect(gateway.send({ callerSession: "sender", envelope })).resolves.toMatchObject({ ok: true, forwarding: "forwarded" });
      await expect(gateway.cleanup(new Date(NOW.getTime() - 1))).resolves.toBe(0);

      const state = JSON.parse(readFileSync(join(directory, "relay-state.json"), "utf8"));
      expect(state.outbox).toEqual([expect.objectContaining({ forwardedAt: NOW.toISOString() })]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("bounds unavailable forwarding and persists exhaustion diagnostics", async () => {
    const directory = root();
    let now = NOW;
    try {
      const gateway = new TaskRelayGateway({ root: directory, inspectSession: session("sender"), now: () => now });
      const source = await connect(gateway, "sender");
      const target = { relay: await gateway.peerRelay("https://receiver.example.ts.net"), id: "2af8af29-c4fe-44f9-9a99-9a0e35952d74" };
      await expect(gateway.send({
        callerSession: "sender",
        envelope: { envelopeId: "exhausted-envelope", protocolVersion: RELAY_PROTOCOL_VERSION, source, target, payload: { opaque: true }, createdAt: NOW.toISOString() },
      })).resolves.toMatchObject({ ok: true, forwarding: "pending" });
      for (let attempt = 1; attempt < 4; attempt += 1) {
        now = new Date(now.getTime() + RELAY_LIMITS.FORWARD_RETRY_MS);
        await gateway.flushPeerOutbox();
      }
      const state = JSON.parse(readFileSync(join(directory, "relay-state.json"), "utf8"));
      expect(state.outbox).toEqual([expect.objectContaining({
        attempts: 4,
        lastError: "local peer origin unavailable",
        exhaustedAt: now.toISOString(),
      })]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects representative malformed persisted relay records on reads and mutations", async () => {
    const malformedStates = [
      { label: "invalid JSON", contents: "{" },
      { label: "registration endpoint", contents: JSON.stringify({ ...VALID_RELAY_STATE, registrations: [{ ...VALID_REGISTRATION, endpoint: null }] }) },
      { label: "registration integer", contents: JSON.stringify({ ...VALID_RELAY_STATE, registrations: [{ ...VALID_REGISTRATION, protocolVersions: [1.5] }] }) },
      { label: "stored timestamp", contents: JSON.stringify({ ...VALID_RELAY_STATE, envelopes: [{ ...VALID_STORED_ENVELOPE, acceptedAt: "not-a-date" }] }) },
      { label: "non-decimal cursor", contents: JSON.stringify({ ...VALID_RELAY_STATE, mailbox: [{ ...VALID_MAILBOX_ITEM, cursor: "one" }] }) },
      { label: "zero cursor", contents: JSON.stringify({ ...VALID_RELAY_STATE, mailbox: [{ ...VALID_MAILBOX_ITEM, cursor: "0" }] }) },
      { label: "dangling mailbox", contents: JSON.stringify({ ...VALID_RELAY_STATE, mailbox: [{ ...VALID_MAILBOX_ITEM, envelopeId: "missing-envelope" }] }) },
      { label: "duplicate mailbox", contents: JSON.stringify({ ...VALID_RELAY_STATE, mailbox: [VALID_MAILBOX_ITEM, VALID_MAILBOX_ITEM] }) },
      { label: "orphan envelope", contents: JSON.stringify({ ...VALID_RELAY_STATE, mailbox: [] }) },
      { label: "duplicate envelope", contents: JSON.stringify({ ...VALID_RELAY_STATE, envelopes: [VALID_STORED_ENVELOPE, VALID_STORED_ENVELOPE] }) },
      { label: "peer origin", contents: JSON.stringify({ ...VALID_RELAY_STATE, peerRoutes: [{ ...VALID_PEER_ROUTE, origin: "not-an-origin" }] }) },
      { label: "outbox optional field", contents: JSON.stringify({ ...VALID_RELAY_STATE, outbox: [{ ...VALID_OUTBOX_ITEM, lastError: 500 }] }) },
      { label: "outbox route", contents: JSON.stringify({ ...VALID_RELAY_STATE, outbox: [{ ...VALID_OUTBOX_ITEM, peerOrigin: "https://other.example.ts.net" }] }) },
      { label: "stored digest", contents: JSON.stringify({ ...VALID_RELAY_STATE, envelopes: [{ ...VALID_STORED_ENVELOPE, digest: "0".repeat(64) }] }) },
      { label: "outbox digest", contents: JSON.stringify({ ...VALID_RELAY_STATE, outbox: [{ ...VALID_OUTBOX_ITEM, digest: "0".repeat(64) }] }) },
      { label: "overflow payload", contents: rawOverflowState() },
      { label: "unknown version", contents: JSON.stringify({ ...VALID_RELAY_STATE, version: 3 }) },
    ];

    for (const { contents, label } of malformedStates) {
      const directory = root();
      try {
        writeFileSync(join(directory, "relay-state.json"), contents);
        const store = new TaskRelayStore(directory);
        await expectMalformedRelayStore(() => store.outbox(), label);
        await expectMalformedRelayStore(() => store.cleanup(NOW), label);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test("uses the same malformed-store boundary across every public store method", async () => {
    const directory = root();
    try {
      const malformed = { ...VALID_RELAY_STATE, registrations: [{ ...VALID_REGISTRATION, endpoint: null }] };
      writeFileSync(join(directory, "relay-state.json"), JSON.stringify(malformed));
      for (const operation of storeOperations(new TaskRelayStore(directory))) {
        await expectMalformedRelayStore(operation);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("destructively resets any parsed v1 relay state without validating its fields", async () => {
    const directory = root();
    const path = join(directory, "relay-state.json");
    try {
      writeFileSync(path, JSON.stringify({ version: 1, discarded: { malformed: true } }));
      const store = new TaskRelayStore(directory);

      await expect(store.outbox()).resolves.toEqual([]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        version: 2,
        registrations: [],
        envelopes: [],
        mailbox: [],
        peerRoutes: [],
        outbox: [],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses a distinct v2 storage root", () => {
    expect(RELAY_ID).toBe("wolfpack-pi-tasks-v2");
  });
});
