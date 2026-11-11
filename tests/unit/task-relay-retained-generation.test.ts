import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRecoveryStore } from "../../src/task-relay/recovery-store.ts";
import { MemoryRelayStore, RESTART_SAFE_RELAY_TIMING } from "../../src/task-relay/memory-store.ts";
import { VolatileRelayGateway } from "../../src/task-relay/volatile-gateway.ts";

const registration = (sessionId: string, generation = randomUUID()) => ({ sessionId, generation, leaseMs: 60_000, protocolVersions: [2] });
const receipts = (store: MemoryRelayStore) => store.recoveryRows().filter(row => row.bucket === "receipts");

for (const prune of ["maintenance", "lookup"] as const) test(`native terminal-only generation retention preserves evidence/charges and prunes only the predecessor via ${prune}`, () => {
  const root = mkdtempSync("/tmp/relay-retained-generation-"), now = Date.now(), a = registration(randomUUID()), b = registration(randomUUID());
  let owner = createRecoveryStore({ root });
  try {
    let store = owner.store;
    const old = store.register(a, now), source = store.register(b, now);
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: source.endpoint, target: old.endpoint, createdAt: new Date(now).toISOString(), payload: "completed transport" };
    const accepted = store.accept(store.epoch, envelope, now); store.acknowledge(store.epoch, old.endpoint.id, envelope.envelopeId, now);
    const evidence = receipts(store), before = store.stats(), successor = registration(a.sessionId);
    store.disconnect(store.epoch, a.sessionId, old.endpoint.id, now);
    const fresh = store.register(successor, now + 1);
    expect(fresh.endpoint).not.toEqual(old.endpoint);
    expect(store.inbox(store.epoch, fresh.endpoint.id, "0", now + 1).deliveries).toEqual([]);
    expect(store.stats()).toMatchObject({ registrations: 3, sessions: 2, receipts: 1, activeItems: 0,
      receiptBytes: before.receiptBytes, metadataBytes: before.metadataBytes * 1.5 });
    expect(receipts(store)).toEqual(evidence);
    expect(() => store.register(a, now + 1)).toThrow("RELAY_RESET");
    expect(() => store.inbox(store.epoch, old.endpoint.id, "0", now + 1)).toThrow("REGISTRATION_EXPIRED");
    expect(() => store.acknowledge(store.epoch, old.endpoint.id, envelope.envelopeId, now + 1)).toThrow("REGISTRATION_EXPIRED");
    owner.close(); owner = createRecoveryStore({ root }); store = owner.store;
    expect(receipts(store)).toEqual(evidence);
    expect(store.stats()).toMatchObject({ registrations: 3, sessions: 2, receiptBytes: before.receiptBytes, metadataBytes: before.metadataBytes * 1.5 });
    expect(store.terminalAcceptance(store.epoch, envelope, now + 1)).toEqual({ kind: "duplicate", acceptanceId: accepted.acceptanceId });
    expect(() => store.terminalAcceptance(store.epoch, { ...envelope, payload: "changed" }, now + 1)).toThrow("ENVELOPE_CONFLICT");
    expect(store.terminalAcceptance(store.epoch, { ...envelope, envelopeId: randomUUID() }, now + 1)).toBeUndefined();
    const expires = now + RESTART_SAFE_RELAY_TIMING.receiptMs + 1;
    store.register(b, expires, "renew");
    if (prune === "maintenance") store.maintenance(store.epoch, expires, 1024);
    expect(store.terminalAcceptance(store.epoch, envelope, expires)).toBeUndefined();
    expect(store.stats()).toMatchObject({ registrations: 2, sessions: 2, receipts: 0, activeItems: 0, receiptBytes: 0, metadataBytes: before.metadataBytes });
    owner.close(); owner = createRecoveryStore({ root }); store = owner.store;
    expect(() => store.register(a, expires, "renew")).toThrow("RELAY_RESET");
    expect(store.register(successor, expires, "renew").endpoint).toEqual(fresh.endpoint);
    expect(store.inbox(store.epoch, fresh.endpoint.id, "0", expires).nextCursor).toBe("0");
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const limit of ["registrations", "metadataBytes"] as const) test(`terminal-only replacement preflights BOTH registration charges against ${limit} before changing either`, () => {
  const root = mkdtempSync("/tmp/relay-retained-capacity-"), now = Date.now(), input = registration(randomUUID());
  let owner = createRecoveryStore({ root });
  try {
    const old = owner.store.register(input, now);
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: old.endpoint, target: old.endpoint, createdAt: new Date(now).toISOString(), payload: "done" };
    owner.store.accept(owner.store.epoch, envelope, now); owner.store.acknowledge(owner.store.epoch, old.endpoint.id, envelope.envelopeId, now);
    const before = owner.store.stats(), rows = owner.store.recoveryRows(); owner.close();
    owner = createRecoveryStore({ root, limits: limit === "registrations" ? { registrations: 1 } : { metadataBytes: before.metadataBytes * 2 - 1 } });
    expect(() => owner.store.register(registration(input.sessionId), now + 60_000)).toThrow("RELAY_CAPACITY");
    expect(owner.store.recoveryRows()).toEqual(rows); expect(owner.store.stats()).toEqual(before);
    expect(owner.store.register(input, now, "renew").endpoint).toEqual(old.endpoint);
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const state of ["mailbox", "in-flight", "retryable"] as const) test(`fresh generation cannot retain nonterminal ${state} obligations`, () => {
  const root = mkdtempSync("/tmp/relay-retained-active-"), now = Date.now(), input = registration(randomUUID());
  const owner = createRecoveryStore({ root });
  try {
    const store = owner.store, old = store.register(input, now);
    const peer = state === "mailbox" ? undefined : store.peerRoute(store.epoch, "https://peer.tail123.ts.net", randomUUID());
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: old.endpoint,
      target: peer ? { relay: peer.id, id: randomUUID() } : old.endpoint, createdAt: new Date(now).toISOString(), payload: "pending" };
    if (state === "mailbox") store.accept(store.epoch, envelope, now);
    else {
      const attempt = store.beginForward(store.epoch, envelope, now);
      expect(attempt.kind).toBe("attempt");
      if (state === "retryable" && attempt.kind === "attempt") store.finishForward(store.epoch, envelope.envelopeId, attempt.token, { kind: "retryable" }, now);
    }
    const rows = store.recoveryRows();
    expect(() => store.register(registration(input.sessionId), now + 60_000)).toThrow("RELAY_RESET");
    expect(store.recoveryRows()).toEqual(rows);
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("terminal unconfirmed forwarding stays unknown through generation replacement and native reopen", () => {
  const root = mkdtempSync("/tmp/relay-retained-unknown-"), now = Date.now(), input = registration(randomUUID());
  let owner = createRecoveryStore({ root });
  try {
    let store = owner.store; const old = store.register(input, now);
    const peer = store.peerRoute(store.epoch, "https://peer.tail123.ts.net", randomUUID());
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: old.endpoint, target: { relay: peer.id, id: randomUUID() }, createdAt: new Date(now).toISOString(), payload: "outcome unknown" };
    const attempt = store.beginForward(store.epoch, envelope, now);
    if (attempt.kind !== "attempt") throw new Error("fixture did not begin native forward");
    store.finishForward(store.epoch, envelope.envelopeId, attempt.token, { kind: "rejected" }, now);
    expect(store.terminalAcceptance(store.epoch, envelope, now)).toBeUndefined();
    const evidence = receipts(store), receiptBytes = store.stats().receiptBytes;
    store.disconnect(store.epoch, input.sessionId, old.endpoint.id, now);
    const next = store.register(registration(input.sessionId), now + 1);
    owner.close(); owner = createRecoveryStore({ root }); store = owner.store;
    expect(receipts(store)).toEqual(evidence); expect(store.stats().receiptBytes).toBe(receiptBytes);
    expect(store.forwardStatus(store.epoch, envelope.envelopeId, now + 1)).toEqual({ kind: "unconfirmed", mayHaveBeenDelivered: true });
    expect(JSON.parse(evidence[0]!.value).acceptanceId).toBeUndefined();
    expect(() => store.beginForward(store.epoch, envelope, now + 1)).toThrow("REGISTRATION_EXPIRED");
    expect(store.inbox(store.epoch, next.endpoint.id, "0", now + 1).deliveries).toEqual([]);
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("repeated empty fresh generations do not accumulate history while retained predecessors consume the remaining capacity", () => {
  const root = mkdtempSync("/tmp/relay-retained-bounded-"), now = Date.now(), input = registration(randomUUID());
  const owner = createRecoveryStore({ root, limits: { registrations: 2 } });
  try {
    const store = owner.store, old = store.register(input, now);
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: old.endpoint, target: old.endpoint, createdAt: new Date(now).toISOString(), payload: "done" };
    store.accept(store.epoch, envelope, now); store.acknowledge(store.epoch, old.endpoint.id, envelope.envelopeId, now);
    let current = old;
    for (let index = 0; index < 20; index++) {
      store.disconnect(store.epoch, input.sessionId, current.endpoint.id, now + 1);
      current = store.register(registration(input.sessionId), now + 1);
      expect(store.stats()).toMatchObject({ registrations: 2, sessions: 1, receipts: 1 });
    }
    const latest = { ...envelope, envelopeId: randomUUID(), source: current.endpoint, target: current.endpoint };
    store.accept(store.epoch, latest, now + 1); store.acknowledge(store.epoch, current.endpoint.id, latest.envelopeId, now + 1);
    expect(() => store.register(registration(input.sessionId), now + 60_001)).toThrow("RELAY_CAPACITY");
    expect(store.registration(store.epoch, current.endpoint.id, now + 1)?.endpoint).toEqual(current.endpoint);
    expect(store.stats()).toMatchObject({ registrations: 2, sessions: 1, receipts: 2 });
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("explicit memory-only storage keeps its baseline expired-target rejection instead of enabling durable receipt lookup", async () => {
  let now = Date.now(); const a = randomUUID(), b = randomUUID();
  const gateway = new VolatileRelayGateway({ storage: "memory", now: () => now,
    inspectSession: async sessionId => ({ ok: true, sessionId, session: sessionId, alive: true, projectPath: "/tmp", harness: "pi" }) });
  const connect = (callerSession: string) => gateway.request({ profile: "volatile-v1", operation: "connect", callerSession, generation: callerSession, protocolVersions: [2], leaseMs: 60_000 });
  try {
    const aa = await connect(a) as any, bb = await connect(b) as any;
    const bound = { profile: "volatile-v1", epoch: aa.epoch, callerSession: a, endpoint: aa.value.endpoint };
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: aa.value.endpoint, target: bb.value.endpoint, createdAt: new Date(now).toISOString(), payload: "already ACKed" };
    expect(await gateway.request({ ...bound, operation: "send", envelope })).toMatchObject({ ok: true });
    expect(await gateway.request({ ...bound, callerSession: b, endpoint: bb.value.endpoint, operation: "acknowledge", envelopeId: envelope.envelopeId })).toMatchObject({ ok: true });
    now += 61_000; await connect(a);
    expect(await gateway.request({ ...bound, operation: "send", envelope })).toMatchObject({ ok: false, error: { code: "TARGET_NOT_REGISTERED" } });
  } finally { await gateway.close(); }
});

test("restore rejects duplicate current owners and nonterminal or empty retained predecessors", () => {
  const root = mkdtempSync("/tmp/relay-retained-restore-"), now = Date.now(), a = registration(randomUUID()), b = registration(randomUUID());
  const owner = createRecoveryStore({ root });
  try {
    const store = owner.store, old = store.register(a, now); store.register(b, now);
    const rows = store.recoveryRows();
    const duplicate = rows.map(row => {
      if (row.bucket !== "registrations") return row;
      const entry = JSON.parse(row.value); entry.value.sessionId = a.sessionId; return { ...row, value: JSON.stringify(entry) };
    });
    expect(() => new MemoryRelayStore({ recoverable: true, rows: duplicate })).toThrow("invalid restart-safe relay state");
    const retained = () => store.recoveryRows().map(row => {
      if (row.bucket !== "registrations" || row.key !== old.endpoint.id) return row;
      const entry = JSON.parse(row.value); entry.current = false; return { ...row, value: JSON.stringify(entry) };
    });
    expect(() => new MemoryRelayStore({ recoverable: true, rows: retained() })).toThrow("invalid restart-safe relay state");
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: old.endpoint, target: old.endpoint, createdAt: new Date(now).toISOString(), payload: "must not restore as retained mail" };
    store.accept(store.epoch, envelope, now);
    expect(() => new MemoryRelayStore({ recoverable: true, rows: retained() })).toThrow("invalid restart-safe relay state");
    store.acknowledge(store.epoch, old.endpoint.id, envelope.envelopeId, now);
    const falseAcceptance = store.recoveryRows().map(row => row.bucket === "receipts"
      ? { ...row, value: JSON.stringify({ ...JSON.parse(row.value), state: "forwarded" }) } : row);
    expect(() => new MemoryRelayStore({ recoverable: true, rows: falseAcceptance })).toThrow("invalid restart-safe relay state");
    const peer = store.peerRoute(store.epoch, "https://peer.tail123.ts.net", randomUUID());
    store.beginForward(store.epoch, { ...envelope, envelopeId: randomUUID(), target: { relay: peer.id, id: randomUUID() } }, now);
    expect(() => new MemoryRelayStore({ recoverable: true, rows: retained() })).toThrow("invalid restart-safe relay state");
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});
