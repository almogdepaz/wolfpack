import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createRecoveryStore } from "../../../src/task-relay/recovery-store.ts";

/**
 * Valid SQLite and row checksums with two retained mailbox receipts, then one
 * registration marked noncurrent. Since #484, restore accepts a noncurrent
 * mailbox *source* (retired senders keep their outgoing local mail) but rejects
 * a noncurrent mailbox *target* (retirement forgets incoming mail).
 */
export function seedRetiredRelayJournal(root: string, retired: "source" | "target"): string {
  const owner = createRecoveryStore({ root });
  const now = Date.now(), generation = randomUUID();
  const source = owner.store.register({ sessionId: randomUUID(), generation, leaseMs: 60_000, protocolVersions: [2] }, now);
  const target = owner.store.register({ sessionId: randomUUID(), generation, leaseMs: 60_000, protocolVersions: [2] }, now);
  const epoch = owner.store.epoch;
  for (let i = 0; i < 2; i++) owner.store.accept(epoch, {
    envelopeId: randomUUID(), protocolVersion: 2, source: source.endpoint, target: target.endpoint,
    createdAt: new Date(now).toISOString(), payload: "synthetic historical mail; never replay",
  }, now);
  owner.close();
  const id = (retired === "source" ? source : target).endpoint.id;
  const db = new Database(join(root, "restart-safe-v1.sqlite"));
  try {
    const row = db.query("SELECT value FROM cells WHERE bucket='registrations' AND key=?").get(id) as { value: string };
    const entry = JSON.parse(row.value); entry.current = false;
    const value = JSON.stringify(entry);
    const digest = createHash("sha256").update(JSON.stringify(["registrations", id, value])).digest("hex");
    db.query("UPDATE cells SET value=?, digest=? WHERE bucket='registrations' AND key=?").run(value, digest, id);
  } finally { db.close(); }
  return epoch;
}

/** Synthetic invalid-storage shape under the current restore invariant: a retired target with retained mailbox receipts. */
export function seedInvalidRelayJournal(root: string): string {
  return seedRetiredRelayJournal(root, "target");
}

export function relayJournalRows(root: string): unknown[] {
  const db = new Database(join(root, "restart-safe-v1.sqlite"), { readonly: true });
  try { return db.query("SELECT * FROM cells ORDER BY bucket,key").all(); }
  finally { db.close(); }
}
