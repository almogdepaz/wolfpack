#!/usr/bin/env bun
/** Temporary-store lookup benchmark; no live relay/session access.
 * Optional first argument: exact-base src/task-relay/store.ts module path.
 * Fixture seeding and correctness checks are outside measured operations.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../src/canonical-json.ts";
import { RELAY_ID, RELAY_PROTOCOL_VERSION } from "../src/task-relay/domain.ts";

const modulePath = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dir, "../src/task-relay/store.ts");
const { TaskRelayStore } = await import(pathToFileURL(modulePath).href) as typeof import("../src/task-relay/store.ts");
const now = new Date("2026-08-09T00:00:00.000Z");
const registrations = Array.from({ length: 20 }, (_, i) => ({
  sessionId: `session-${i}`, endpoint: { relay: RELAY_ID, id: randomUUID() }, generation: "generation-1",
  protocolVersions: [RELAY_PROTOCOL_VERSION], leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
}));
const ids = registrations.map(r => r.sessionId);
function fixture(count: number): string {
  const envelopes = Array.from({ length: count }, (_, i) => {
    const envelope = {
      envelopeId: `fixture-envelope-${i}`, protocolVersion: RELAY_PROTOCOL_VERSION,
      source: registrations[0]!.endpoint, target: registrations[1]!.endpoint,
      payload: { index: i, content: "x".repeat(1_024) }, createdAt: now.toISOString(),
    };
    return { envelope, digest: createHash("sha256").update(canonicalJson(envelope)).digest("hex"), acceptedAt: now.toISOString(), acceptanceId: randomUUID() };
  });
  return JSON.stringify({ version: 2, registrations, envelopes,
    mailbox: envelopes.map((item, i) => ({ endpointId: item.envelope.target.id, envelopeId: item.envelope.envelopeId, cursor: String(i + 1) })),
    mailboxCursors: count ? [{ endpointId: registrations[1]!.endpoint.id, cursor: String(count) }] : [],
    peerRoutes: [], outbox: [],
  }) + "\n";
}
const median = (values: number[]) => Number(values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!.toFixed(3));
const root = mkdtempSync(join(tmpdir(), "relay-lookup-perf-"));
try {
  const store = new TaskRelayStore(root);
  console.log(JSON.stringify({ modulePath, scope: "3-trial warm-filesystem medians in ms; store operations, not RSS/HTTP/production latency; 20 sessions, 1 KiB envelope payloads" }));
  for (const envelopes of [0, 1_000, 5_000]) {
    const source = fixture(envelopes);
    const single: number[] = [];
    const batch: number[] = [];
    const register: number[] = [];
    for (let trial = 0; trial < 3; trial++) {
      writeFileSync(store.path, source, { mode: 0o600 });
      // Exercise the same validated parser once before measurements.
      await store.registrationForSession(ids[0]!, now);
      let start = performance.now();
      const repeated = await Promise.all(ids.map(id => store.registrationForSession(id, now)));
      single.push(performance.now() - start);
      if (repeated.some((r, i) => r?.endpoint.id !== registrations[i]!.endpoint.id)) throw new Error("scalar lookup mismatch");
      if (typeof store.registrationsForSessions === "function") {
        start = performance.now();
        const selected = await store.registrationsForSessions(ids, now);
        batch.push(performance.now() - start);
        if (selected.size !== ids.length || ids.some((id, i) => selected.get(id)?.endpoint.id !== repeated[i]!.endpoint.id)) throw new Error("batch lookup mismatch");
      }
      start = performance.now();
      await store.register({ ...registrations[0]!, leaseExpiresAt: new Date(now.getTime() + 120_000).toISOString() });
      register.push(performance.now() - start);
    }
    console.log(JSON.stringify({ envelopes, bytes: Buffer.byteLength(source), scalar20Ms: median(single), ...(batch.length && { batch20Ms: median(batch) }), realRegistrationMs: median(register) }));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
