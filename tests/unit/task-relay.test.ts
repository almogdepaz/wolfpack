import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELAY_ERROR, RELAY_ID, RELAY_LIMITS, RELAY_PROTOCOL_VERSION } from "../../src/task-relay/domain.ts";
import { TaskRelayGateway } from "../../src/task-relay/gateway.ts";

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
        createdAt: NOW.toISOString(),
      };

      await expect(gateway.send({ callerSession: "sender", envelope })).resolves.toMatchObject({ ok: true, kind: "accepted" });
      await expect(gateway.send({ callerSession: "sender", envelope })).resolves.toMatchObject({ ok: true, kind: "duplicate" });
      await expect(gateway.send({ callerSession: "sender", envelope: { ...envelope, source: receiver } })).resolves.toMatchObject({
        ok: false,
        error: { code: "SOURCE_MISMATCH" },
      });

      await expect(receiverGateway.receive({ callerSession: "receiver", cursor: "0" })).resolves.toMatchObject({
        ok: true,
        envelopes: [expect.objectContaining({ envelopeId: "envelope-1", payload: envelope.payload })],
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

  test("uses a distinct v2 storage root", () => {
    expect(RELAY_ID).toBe("wolfpack-pi-tasks-v2");
  });
});
