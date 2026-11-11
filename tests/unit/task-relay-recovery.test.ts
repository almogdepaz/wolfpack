import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const gateway = createTaskRelayGateway({ root: directory, storage: "sqlite", requestTimeoutMs: 1000,
    inspectSession: async selector => { if (hang) { hang = false; return new Promise(() => {}); } return { ok: true, session: "reused-name", sessionId: selector, projectPath: directory, harness: "pi", alive: true }; },
  } as GatewayOptions);
  try {
    await gateway.initialize();
    const registered = await gateway.volatile({ operation: "connect", profile: gateway.profile, callerSession: session, generation: randomUUID(), protocolVersions: [2] });
    expect(registered.ok).toBe(true); if (!registered.ok || registered.value.kind !== "connected") throw new Error("connect failed");
    hang = true;
    const interrupted = await gateway.volatile({ operation: "health", profile: gateway.profile, epoch: registered.epoch, callerSession: session, endpoint: registered.value.endpoint });
    expect(interrupted).toMatchObject({ ok: false, error: { code: "RELAY_UNAVAILABLE", retryable: true, mayHaveBeenDelivered: true } });
    if (!interrupted.ok && interrupted.error.retryAfterMs) await Bun.sleep(interrupted.error.retryAfterMs + 10);
    expect(await gateway.volatileEpoch()).toBe(registered.epoch);
  } finally { await gateway.close(); rmSync(directory, { recursive: true, force: true }); }
}, 15_000);

test("a poisoned native commit fences RAM and replaces the stopped worker after storage becomes writable", async () => {
  const directory = root(), sessionId = randomUUID(), generation = randomUUID();
  const options = { root: directory, storage: "sqlite" as const, inspectSession: async (selector: string) => ({ ok: true as const, session: "same-name", sessionId: selector, projectPath: directory, harness: "pi", alive: true }) };
  let gateway = createTaskRelayGateway(options);
  const connect = () => gateway.volatile({ operation: "connect", profile: gateway.profile, callerSession: sessionId, generation, protocolVersions: [2] });
  try {
    const first = await connect(); expect(first.ok).toBe(true);
    await gateway.close(); chmodSync(directory, 0o500);
    gateway = createTaskRelayGateway(options); await gateway.initialize();
    const failed = await connect(); expect(failed).toMatchObject({ ok: false, error: { code: "RELAY_STORAGE_UNCERTAIN", ownerFatal: true, mayHaveBeenDelivered: true } });
    chmodSync(directory, 0o700);
    if (!failed.ok && failed.error.retryAfterMs) await Bun.sleep(failed.error.retryAfterMs + 10);
    const recovered = await connect(); expect(recovered).toMatchObject({ ok: true, epoch: first.epoch });
    if (first.ok && recovered.ok && first.value.kind === "connected" && recovered.value.kind === "connected") expect(recovered.value.endpoint).toEqual(first.value.endpoint);
  } finally { chmodSync(directory, 0o700); await gateway.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("durable registrations fence stale generations; bounded receipt expiry never admits an old envelope again", () => {
  const directory = root(); let owner = createRecoveryStore({ root: directory });
  const now = Date.now(), a = randomUUID(), b = randomUUID(), generation = randomUUID();
  try {
    let store = owner.store;
    const source = store.register({ sessionId: a, generation, leaseMs: 60_000, protocolVersions: [2] }, now);
    const target = store.register({ sessionId: b, generation, leaseMs: 60_000, protocolVersions: [2] }, now);
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: source.endpoint, target: target.endpoint, createdAt: new Date(now).toISOString(), payload: "opaque" };
    const accepted = store.accept(store.epoch, envelope, now);
    expect(() => store.register({ sessionId: a, generation: randomUUID(), leaseMs: 60_000, protocolVersions: [2] }, now + 60_000)).toThrow("RELAY_RESET");
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

test("valid opaque envelope IDs round-trip recovery; invalid wire bindings fail before persistence", () => {
  const directory = root(), generation = randomUUID(), sessionId = randomUUID(), now = Date.now();
  let owner = createRecoveryStore({ root: directory });
  try {
    const registered = owner.store.register({ sessionId, generation, leaseMs: 60_000, protocolVersions: [2] }, now);
    const envelope = { envelopeId: "stable-logical-envelope", protocolVersion: 2, source: registered.endpoint, target: registered.endpoint, createdAt: new Date(now).toISOString(), payload: "opaque" };
    const accepted = owner.store.accept(owner.store.epoch, envelope, now); owner.close(); owner = createRecoveryStore({ root: directory });
    expect(owner.store.inbox(owner.store.epoch, registered.endpoint.id, "0", now).deliveries[0]?.envelope).toEqual(envelope);
    expect(owner.store.accept(owner.store.epoch, envelope, now).acceptanceId).toBe(accepted.acceptanceId);
    expect(() => owner.store.register({ sessionId: randomUUID(), generation: "", leaseMs: 60_000, protocolVersions: [2] }, now)).toThrow("INVALID_REQUEST");
  } finally { owner.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("an unsupported native journal mode is refused without conversion", () => {
  const directory = root(), owner = createRecoveryStore({ root: directory }); owner.close();
  const path = join(directory, "restart-safe-v1.sqlite"), db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
  const before = readFileSync(path);
  try { expect(() => { const reopened = createRecoveryStore({ root: directory }); reopened.close(); }).toThrow(); expect(readFileSync(path)).toEqual(before); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test("existing unsafe rollback sidecars fail without native recovery or deletion", () => {
  const directory = root(), owner = createRecoveryStore({ root: directory }); owner.close();
  const sidecar = join(directory, "restart-safe-v1.sqlite-journal"); writeFileSync(sidecar, "untrusted rollback bytes", { mode: 0o600 }); chmodSync(sidecar, 0o644);
  try { expect(() => { const reopened = createRecoveryStore({ root: directory }); reopened.close(); }).toThrow(); expect(readFileSync(sidecar, "utf8")).toBe("untrusted rollback bytes"); }
  finally { rmSync(directory, { recursive: true, force: true }); }
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
