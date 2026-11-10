import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRecoveryStore } from "../../src/task-relay/recovery-store.ts";
import { RESTART_SAFE_RELAY_TIMING } from "../../src/task-relay/memory-store.ts";

for (const purge of ["maintenance", "lookup"] as const) test(`native ${purge} expiry stays irreversible across reopen and clock rollback without dropping offline mail`, () => {
  const root = mkdtempSync("/tmp/relay-expiry-rollback-"), now = Date.now(), sessionId = randomUUID(), generation = randomUUID();
  let owner = createRecoveryStore({ root });
  const register = (at: number) => owner.store.register({ sessionId, generation, protocolVersions: [2], leaseMs: 60_000 }, at);
  try {
    const registration = register(now), endpoint = registration.endpoint;
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: endpoint, target: endpoint,
      createdAt: new Date(now).toISOString(), payload: "already completed transport" };
    const accepted = owner.store.accept(owner.store.epoch, envelope, now);
    owner.store.acknowledge(owner.store.epoch, endpoint.id, envelope.envelopeId, now);
    const pending = { ...envelope, envelopeId: randomUUID(), createdAt: new Date(now + 1).toISOString(), payload: "accepted offline mail must remain" };
    const pendingAcceptance = owner.store.accept(owner.store.epoch, pending, now + 1);
    const expires = now + RESTART_SAFE_RELAY_TIMING.receiptMs + 1;
    if (purge === "maintenance") owner.store.maintenance(owner.store.epoch, expires, 1024);
    else {
      register(expires);
      expect(() => owner.store.accept(owner.store.epoch, envelope, expires)).toThrow("ENVELOPE_EXPIRED");
    }
    owner.close(); owner = createRecoveryStore({ root });
    expect(register(now + 1000).endpoint).toEqual(endpoint);
    expect(() => owner.store.accept(owner.store.epoch, envelope, now + 1000)).toThrow("ENVELOPE_EXPIRED");
    expect(owner.store.stats()).toMatchObject({ activeItems: 1, receipts: 1 });
    expect(owner.store.accept(owner.store.epoch, pending, now + 1000).acceptanceId).toBe(pendingAcceptance.acceptanceId);
    expect(owner.store.inbox(owner.store.epoch, endpoint.id, "0", now + 1000).deliveries.map(item => item.envelope)).toEqual([pending]);
    // A high observed wall clock must not impose an eight-day floor on fresh mail.
    const fresh = { ...envelope, envelopeId: randomUUID(), createdAt: new Date(now + 1000).toISOString(), payload: "new mail after clock correction" };
    expect(owner.store.accept(owner.store.epoch, fresh, now + 1000)).toMatchObject({ kind: "accepted" });
    expect(owner.store.recoveryRows().filter(row => row.bucket === "identity")).toHaveLength(1);
    expect(accepted.acceptanceId).not.toBe(pendingAcceptance.acceptanceId);
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});
