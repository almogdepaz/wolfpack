import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../src/canonical-json.ts";
import { RELAY_ID, RELAY_PROTOCOL_VERSION } from "../src/task-relay/domain.ts";

const storeModule = resolve(process.argv[2] ?? "src/task-relay/store.ts");
const { TaskRelayStore } = await import(pathToFileURL(storeModule).href) as typeof import("../src/task-relay/store.ts");
const repeats = 5;
const median = (values: number[]) => values.sort((left, right) => left - right)[Math.floor(values.length / 2)]!;

async function measure(operation: () => unknown): Promise<number> {
  await operation();
  const values: number[] = [];
  for (let index = 0; index < repeats; index += 1) {
    const start = performance.now();
    await operation();
    values.push(performance.now() - start);
  }
  return Number(median(values).toFixed(3));
}

const root = mkdtempSync(join(tmpdir(), "wolfpack-relay-store-perf-"));
try {
  console.log(JSON.stringify({
    kind: "relay-store-perf",
    module: storeModule,
    runtime: Bun.version,
    platform: process.platform,
    arch: process.arch,
    repeats,
    note: "Synthetic warm-filesystem medians in milliseconds; no live relay data or services.",
  }));
  const now = new Date("2026-08-09T00:00:00.000Z");
  const endpoint = { relay: RELAY_ID, id: randomUUID() };
  const registration = {
    endpoint,
    sessionId: "synthetic-session",
    generation: "synthetic-generation",
    protocolVersions: [RELAY_PROTOCOL_VERSION],
    leaseExpiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
  };
  for (const count of [1_000, 5_000]) {
    const envelopes = Array.from({ length: count }, (_, index) => {
      const envelope = {
        envelopeId: `synthetic-${index}`,
        protocolVersion: RELAY_PROTOCOL_VERSION,
        source: endpoint,
        target: endpoint,
        payload: { text: "x".repeat(1024) },
        createdAt: now.toISOString(),
      };
      return {
        envelope,
        digest: createHash("sha256").update(canonicalJson(envelope)).digest("hex"),
        acceptedAt: now.toISOString(),
        acceptanceId: randomUUID(),
      };
    });
    const mailbox = envelopes.map((item, index) => ({
      endpointId: endpoint.id,
      envelopeId: item.envelope.envelopeId,
      cursor: String(index + 1),
      acknowledgedAt: now.toISOString(),
    }));
    const state = canonicalJson({
      version: 2,
      registrations: [registration],
      envelopes,
      mailbox,
      mailboxCursors: [{ endpointId: endpoint.id, cursor: String(count) }],
      peerRoutes: [],
      outbox: [],
    });
    const seed = () => {
      const store = new TaskRelayStore(root);
      writeFileSync(store.path, state);
      return store;
    };

    const coldLookupMs = await measure(() => {
      const store = seed();
      return store.registrationForSession(registration.sessionId, now);
    });
    const warmStore = seed();
    await warmStore.registrationForSession(registration.sessionId, now);
    const warmLookupMs = await measure(() => warmStore.registrationForSession(registration.sessionId, now));
    const emptyOutboxTwoReadsMs = await measure(async () => {
      await warmStore.outbox();
      await warmStore.outbox();
    });
    const twentyWarmLookupsMs = await measure(() => Promise.all(
      Array.from({ length: 20 }, (_, index) => warmStore.registrationForSession(`missing-${index}`, now)),
    ));
    await warmStore.acknowledge(endpoint.id, envelopes[0]!.envelope.envelopeId, now.toISOString());
    const duplicateAcknowledgementMs = await measure(() => warmStore.acknowledge(endpoint.id, envelopes[0]!.envelope.envelopeId, now.toISOString()));
    console.log(JSON.stringify({
      kind: "relay-store-perf-result",
      envelopes: count,
      storeBytes: statSync(warmStore.path).size,
      coldLookupMs,
      warmLookupMs,
      emptyOutboxTwoReadsMs,
      twentyWarmLookupsMs,
      duplicateAcknowledgementMs,
    }));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
