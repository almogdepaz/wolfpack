import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createTaskRelayGateway, type GatewayOptions } from "../../src/task-relay/gateway.ts";
import { createRecoveryStore } from "../../src/task-relay/recovery-store.ts";
import { RESTART_SAFE_RELAY_TIMING } from "../../src/task-relay/memory-store.ts";

const root = () => mkdtempSync(join(tmpdir(), "relay-recovery-"));
test("failed server-owned worker is replaced before the next request, retaining epoch without replaying a mutation", async () => {
  const directory = root(); let hang = false;
  const session = randomUUID();
  const gateway = createTaskRelayGateway({ root: directory, profile: "restart-safe-v1", requestTimeoutMs: 1000,
    inspectSession: async selector => { if (hang) { hang = false; return new Promise(() => {}); } return { ok: true, session: "reused-name", sessionId: selector, projectPath: directory, harness: "pi", alive: true }; },
  } as GatewayOptions);
  try {
    await gateway.initialize();
    const registered = await gateway.volatile({ operation: "connect", profile: gateway.profile, callerSession: session, generation: randomUUID(), protocolVersions: [2] });
    expect(registered.ok).toBe(true); if (!registered.ok || registered.value.kind !== "connected") throw new Error("connect failed");
    hang = true;
    const interrupted = await gateway.volatile({ operation: "health", profile: gateway.profile, epoch: registered.epoch, callerSession: session, endpoint: registered.value.endpoint });
    expect(interrupted).toMatchObject({ ok: false, error: { code: "RELAY_UNAVAILABLE", retryable: true, mayHaveBeenDelivered: true } });
    expect(await gateway.volatileEpoch()).toBe(registered.epoch);
  } finally { await gateway.close(); rmSync(directory, { recursive: true, force: true }); }
}, 15_000);

test("durable registrations fence stale generations; bounded receipt expiry never admits an old envelope again", () => {
  const directory = root(); let owner = createRecoveryStore({ root: directory });
  const now = Date.now(), a = randomUUID(), b = randomUUID(), generation = randomUUID();
  try {
    let store = owner.store;
    const source = store.register({ sessionId: a, generation, leaseMs: 60_000, protocolVersions: [2] }, now);
    const target = store.register({ sessionId: b, generation, leaseMs: 60_000, protocolVersions: [2] }, now);
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: source.endpoint, target: target.endpoint, createdAt: new Date(now).toISOString(), payload: "opaque" };
    const accepted = store.accept(store.epoch, envelope, now);
    expect(() => store.register({ sessionId: a, generation: randomUUID(), leaseMs: 60_000, protocolVersions: [2] }, now)).toThrow("RELAY_RESET");
    store.acknowledge(store.epoch, target.endpoint.id, envelope.envelopeId, now);
    owner.close(); owner = createRecoveryStore({ root: directory }); store = owner.store;
    const renew = (at: number) => { for (const sessionId of [a, b]) store.register({ sessionId, generation, leaseMs: 60_000, protocolVersions: [2] }, at); };
    renew(now + 70_000);
    expect(store.accept(store.epoch, envelope, now + 70_000).acceptanceId).toBe(accepted.acceptanceId);
    store.maintenance(store.epoch, now + RESTART_SAFE_RELAY_TIMING.receiptMs + 1, 1024);
    renew(now + RESTART_SAFE_RELAY_TIMING.receiptMs + 1);
    expect(() => store.accept(store.epoch, envelope, now + RESTART_SAFE_RELAY_TIMING.receiptMs + 1)).toThrow("ENVELOPE_EXPIRED");
    expect(store.registrationForSession(store.epoch, a, now + RESTART_SAFE_RELAY_TIMING.receiptMs + 1)?.endpoint).toEqual(source.endpoint);
  } finally { owner.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("unsupported/corrupt journal is refused, ownership is exclusive, and legacy files remain untouched", () => {
  for (const kind of ["version", "corrupt"] as const) {
    const directory = root(), legacy = join(directory, "relay-state.json"); writeFileSync(legacy, "legacy-not-imported", { mode: 0o600 });
    const owner = createRecoveryStore({ root: directory }); expect(() => createRecoveryStore({ root: directory })).toThrow(); owner.close();
    const db = new Database(join(directory, "restart-safe-v1.sqlite")); db.exec(kind === "version" ? "PRAGMA user_version=9" : "UPDATE cells SET value='{}'"); db.close();
    try { expect(() => createRecoveryStore({ root: directory })).toThrow(); expect(readFileSync(legacy, "utf8")).toBe("legacy-not-imported"); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
