import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createRecoveryStore } from "../../../src/task-relay/recovery-store.ts";

/** Synthetic incident shape: valid SQLite and checksums, invalid source relationship. */
export function seedInvalidRelayJournal(root: string): string {
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
  const db = new Database(join(root, "restart-safe-v1.sqlite"));
  try {
    const row = db.query("SELECT value FROM cells WHERE bucket='registrations' AND key=?").get(source.endpoint.id) as { value: string };
    const entry = JSON.parse(row.value); entry.current = false;
    const value = JSON.stringify(entry);
    const digest = createHash("sha256").update(JSON.stringify(["registrations", source.endpoint.id, value])).digest("hex");
    db.query("UPDATE cells SET value=?, digest=? WHERE bucket='registrations' AND key=?").run(value, digest, source.endpoint.id);
  } finally { db.close(); }
  return epoch;
}

export function relayJournalRows(root: string): unknown[] {
  const db = new Database(join(root, "restart-safe-v1.sqlite"), { readonly: true });
  try { return db.query("SELECT * FROM cells ORDER BY bucket,key").all(); }
  finally { db.close(); }
}
