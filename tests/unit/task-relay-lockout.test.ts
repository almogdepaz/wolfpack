import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRecoveryStore } from "../../src/task-relay/recovery-store.ts";
import { RESTART_SAFE_RELAY_TIMING } from "../../src/task-relay/memory-store.ts";
import { VolatileRelayGateway } from "../../src/task-relay/volatile-gateway.ts";
import type { RelayEndpoint } from "../../src/task-relay/domain.ts";

const NOW = Date.parse("2026-11-11T00:00:00Z");
const registration = (sessionId = randomUUID(), leaseMs = 60_000) => ({ sessionId, generation: randomUUID(), leaseMs, protocolVersions: [2] });
const envelope = (source: RelayEndpoint, target: RelayEndpoint) => ({ envelopeId: randomUUID(), protocolVersion: 2,
  source, target, createdAt: new Date(NOW).toISOString(), payload: "old-lifetime mail" });
function fixture(limits?: { registrations?: number; metadataBytes?: number }) {
  const root = mkdtempSync("/tmp/relay-lockout-");
  let owner = createRecoveryStore({ root, limits });
  return { get store() { return owner.store; }, reopen() { owner.close(); owner = createRecoveryStore({ root, limits }); },
    close() { owner.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const disconnect of [false, true]) test(`outgoing unread local mail survives sender replacement and native reopen (disconnect=${disconnect})`, () => {
  const f = fixture(), a = registration(), b = registration();
  try {
    const old = f.store.register(a, NOW), target = f.store.register(b, NOW);
    const mail = envelope(old.endpoint, target.endpoint);
    const accepted = f.store.accept(f.store.epoch, mail, NOW);
    const rows = f.store.recoveryRows();
    expect(() => f.store.register({ ...a, generation: randomUUID() }, NOW + 1)).toThrow("SESSION_ALREADY_REGISTERED");
    expect(f.store.recoveryRows()).toEqual(rows);
    if (disconnect) f.store.disconnect(f.store.epoch, a.sessionId, old.endpoint.id, NOW + 1);
    const at = disconnect ? NOW + 1 : NOW + 60_000;
    const fresh = f.store.register({ ...a, generation: randomUUID() }, at);
    expect(fresh.endpoint).not.toEqual(old.endpoint);
    expect(f.store.stats()).toMatchObject({ registrations: 3, receipts: 1, activeItems: 1 });
    f.reopen();
    f.store.register(b, at, "renew");
    expect(f.store.inbox(f.store.epoch, target.endpoint.id, "0", at).deliveries[0]?.envelope).toEqual(mail);
    expect(f.store.acknowledge(f.store.epoch, target.endpoint.id, mail.envelopeId, at)).toBe("acknowledged");
    const receipt = f.store.recoveryRows().find(row => row.bucket === "receipts" && row.key === mail.envelopeId)!;
    expect(JSON.parse(receipt.value)).toMatchObject({ state: "acknowledged", acceptanceId: accepted.acceptanceId });
    expect(() => f.store.terminalAcceptance(f.store.epoch, mail, at)).toThrow("REGISTRATION_EXPIRED");
    expect(() => f.store.register(a, at, "renew")).toThrow("RELAY_RESET");
    f.reopen();
    f.store.maintenance(f.store.epoch, at + RESTART_SAFE_RELAY_TIMING.receiptMs + 1, 1024);
    expect(f.store.stats()).toMatchObject({ registrations: 2, receipts: 0, activeItems: 0 });
    f.reopen();
  } finally { f.close(); }
});

test("an empty expired prior is replaced without retaining an empty predecessor", () => {
  const f = fixture({ registrations: 1 }), a = registration();
  try {
    const old = f.store.register(a, NOW);
    const fresh = f.store.register({ ...a, generation: randomUUID() }, NOW + 60_000);
    expect(fresh.endpoint).not.toEqual(old.endpoint);
    expect(f.store.stats()).toMatchObject({ registrations: 1, sessions: 1 });
    f.reopen();
    expect(f.store.registrationForSession(f.store.epoch, a.sessionId, NOW + 60_000)?.endpoint).toEqual(fresh.endpoint);
  } finally { f.close(); }
});

test("replacement forgets incoming mail without delivering it to the new lifetime or reviving it on retry", () => {
  const f = fixture({ registrations: 2 }), a = registration(), b = registration();
  try {
    const source = f.store.register(a, NOW), old = f.store.register(b, NOW);
    const mail = envelope(source.endpoint, old.endpoint);
    f.store.accept(f.store.epoch, mail, NOW);
    const fresh = f.store.register({ ...b, generation: randomUUID() }, NOW + 60_000);
    expect(f.store.stats()).toMatchObject({ registrations: 2, receipts: 0, activeItems: 0 });
    f.reopen(); f.store.register(a, NOW + 60_000, "renew");
    expect(f.store.inbox(f.store.epoch, fresh.endpoint.id, "0", NOW + 60_000).deliveries).toEqual([]);
    expect(f.store.terminalAcceptance(f.store.epoch, mail, NOW + 60_000)).toBeUndefined();
    expect(() => f.store.accept(f.store.epoch, mail, NOW + 60_000)).toThrow("TARGET_NOT_REGISTERED");
    expect(() => f.store.accept(f.store.epoch, { ...mail, target: fresh.endpoint }, NOW + 60_000)).toThrow("ENVELOPE_EXPIRED");
  } finally { f.close(); }
});

test("retiring the target forgets the last reference to an already retained sender", () => {
  const f = fixture({ registrations: 3 }), a = registration(), b = registration();
  try {
    const source = f.store.register(a, NOW), target = f.store.register(b, NOW);
    f.store.accept(f.store.epoch, envelope(source.endpoint, target.endpoint), NOW);
    f.store.register({ ...a, generation: randomUUID() }, NOW + 60_000);
    expect(f.store.stats().registrations).toBe(3);
    f.store.register({ ...b, generation: randomUUID() }, NOW + 60_000);
    expect(f.store.stats()).toMatchObject({ registrations: 2, sessions: 2, receipts: 0, activeItems: 0, activeBytes: 0, receiptBytes: 0 });
    f.reopen();
  } finally { f.close(); }
});

test("replacement capacity failure leaves pending incoming and outgoing mail unchanged", () => {
  const f = fixture({ registrations: 2 }), a = registration(), b = registration();
  try {
    const old = f.store.register(a, NOW), other = f.store.register(b, NOW);
    f.store.accept(f.store.epoch, envelope(old.endpoint, other.endpoint), NOW);
    f.store.accept(f.store.epoch, envelope(other.endpoint, old.endpoint), NOW);
    const rows = f.store.recoveryRows();
    expect(() => f.store.register({ ...a, generation: randomUUID() }, NOW + 60_000)).toThrow("RELAY_CAPACITY");
    expect(f.store.recoveryRows()).toEqual(rows);
    f.reopen();
  } finally { f.close(); }
});

test("native reopen preserves the owner's epoch and generation through a lease gap; no forced rebind is needed", () => {
  const f = fixture(), a = registration();
  try {
    const old = f.store.register(a, NOW), epoch = f.store.epoch;
    const mail = envelope(old.endpoint, old.endpoint);
    f.store.accept(epoch, mail, NOW);
    f.reopen();
    expect(f.store.epoch).toBe(epoch);
    expect(f.store.register(a, NOW + 60_000, "renew").endpoint).toEqual(old.endpoint);
    expect(f.store.inbox(epoch, old.endpoint.id, "0", NOW + 60_000).deliveries[0]?.envelope).toEqual(mail);
  } finally { f.close(); }
});

test("retirement proof is fenced by lease and mutation, even with unread mail", () => {
  const f = fixture(), a = registration();
  try {
    const old = f.store.register(a, NOW), epoch = f.store.epoch;
    f.store.accept(epoch, envelope(old.endpoint, old.endpoint), NOW);
    expect(f.store.retirementCandidate(epoch, NOW + 59_999, "")).toBeUndefined();
    const candidate = f.store.retirementCandidate(epoch, NOW + 60_000, "")!;
    expect(candidate?.registration.endpoint).toEqual(old.endpoint);
    f.store.register(a, NOW + 60_000, "renew");
    expect(f.store.retireRegistration(epoch, old.endpoint.id, candidate.mutation, NOW + 60_000)).toBe(false);
    expect(f.store.retireRegistration(epoch, old.endpoint.id, candidate.mutation, NOW + 120_000)).toBe(false);
    expect(f.store.stats().activeItems).toBe(1);
  } finally { f.close(); }
});

for (const disposition of ["dead", "absent", "alive", "unavailable", "renewed"] as const) test(`capacity reclaim resolves unread mail only after fresh death proof (${disposition})`, async () => {
  const root = mkdtempSync("/tmp/relay-lockout-gateway-"), a = randomUUID(), b = randomUUID(), c = randomUUID();
  let now = NOW, proof = false, gateway: VolatileRelayGateway;
  gateway = new VolatileRelayGateway({ root, storage: "sqlite", limits: { registrations: 2 }, now: () => now, elapsedNow: () => now,
    inspectSession: async selector => {
      if (proof && selector === b) {
        if (disposition === "unavailable") throw new Error("broker offline");
        if (disposition === "absent") return { ok: false, code: "NOT_FOUND" };
        if (disposition === "renewed") {
          proof = false;
          expect(await connect(b, 60_000)).toMatchObject({ ok: true });
          proof = true;
        }
      }
      return { ok: true, sessionId: selector, session: selector, alive: !(proof && selector === b && disposition !== "alive"), projectPath: root, harness: "pi" };
    } });
  const connect = (callerSession: string, leaseMs = 300_000, generation = callerSession) => gateway.request({ operation: "connect", profile: "volatile-v1", callerSession, generation, protocolVersions: [2], leaseMs });
  try {
    const aa = await connect(a) as any, bb = await connect(b, 60_000) as any;
    const binding = { profile: "volatile-v1", epoch: aa.epoch, callerSession: a, endpoint: aa.value.endpoint };
    const mail = envelope(aa.value.endpoint, bb.value.endpoint);
    expect(await gateway.request({ ...binding, operation: "send", envelope: mail })).toMatchObject({ ok: true });
    now += 60_000; proof = true;
    const result = await connect(c);
    expect(result).toMatchObject(disposition === "dead" || disposition === "absent" ? { ok: true } : { ok: false, error: { code: "RELAY_CAPACITY" } });
    const health = await gateway.request({ ...binding, operation: "health" }) as any;
    expect(health.value.store.activeItems).toBe(disposition === "dead" || disposition === "absent" ? 0 : 1);
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
});

test("gateway allows the coordinator's fresh lifetime after its target dies unread", async () => {
  const root = mkdtempSync("/tmp/relay-lockout-e2e-"), a = randomUUID(), b = randomUUID();
  let now = NOW, dead = false;
  const gateway = new VolatileRelayGateway({ root, storage: "sqlite", now: () => now, elapsedNow: () => now,
    inspectSession: async selector => ({ ok: true, sessionId: selector, session: selector, alive: selector !== b || !dead, projectPath: root, harness: "pi" }) });
  const connect = (callerSession: string, generation = callerSession) => gateway.request({ operation: "connect", profile: "volatile-v1", callerSession, generation, protocolVersions: [2], leaseMs: 60_000 });
  try {
    const aa = await connect(a) as any, bb = await connect(b) as any;
    expect(await gateway.request({ operation: "send", profile: "volatile-v1", callerSession: a, epoch: aa.epoch, endpoint: aa.value.endpoint,
      envelope: envelope(aa.value.endpoint, bb.value.endpoint) })).toMatchObject({ ok: true });
    dead = true; now += 60_000;
    const fresh = await connect(a, randomUUID()) as any;
    expect(fresh).toMatchObject({ ok: true, value: { kind: "connected" } });
    expect(fresh.value.endpoint).not.toEqual(aa.value.endpoint);
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
});
