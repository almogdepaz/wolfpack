import { expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRecoveryStore } from "../../src/task-relay/recovery-store.ts";
import { WorkerRelayGateway } from "../../src/task-relay/worker-client.ts";
import { createTaskRelayGateway } from "../../src/task-relay/gateway.ts";

function poisonOneSession(root: string, blocked: string): string {
  const seed = createRecoveryStore({ root }); const epoch = seed.store.epoch; seed.close();
  const db = new Database(join(root, "restart-safe-v1.sqlite"));
  db.exec(`CREATE TRIGGER fail_one_session BEFORE INSERT ON cells
    WHEN NEW.bucket='registrations' AND json_extract(NEW.value, '$.value.sessionId')='${blocked}'
    BEGIN SELECT RAISE(FAIL, 'private fixture scoped write failure'); END;`);
  db.close(); return epoch;
}

test("repeated native owner failure admits only a bounded half-open replacement after cooldown", async () => {
  const root = mkdtempSync("/tmp/relay-owner-cooldown-"), blocked = randomUUID(); poisonOneSession(root, blocked);
  let inspections = 0;
  const gateway = createTaskRelayGateway({ root, storage: "sqlite", inspectSession: async selector => {
    inspections++; return { ok: true, sessionId: selector, session: "fixture", projectPath: root, harness: "pi", alive: true };
  } });
  const connect = () => gateway.volatile({ operation: "connect", profile: gateway.profile, callerSession: blocked, generation: randomUUID(), protocolVersions: [2] });
  try {
    await gateway.initialize();
    const failed = await connect(), immediate = await connect();
    expect(failed).toMatchObject({ ok: false, error: { code: "RELAY_STORAGE_UNCERTAIN", ownerFatal: true } });
    expect(immediate).toMatchObject({ ok: false, error: { code: "RELAY_STORAGE_RECOVERING", retryable: true } });
    expect(inspections).toBe(1);
    if (!immediate.ok) {
      expect(typeof immediate.error.retryAfterMs).toBe("number");
      expect(immediate.error.retryAfterMs).toBeGreaterThan(0);
      await Bun.sleep(immediate.error.retryAfterMs! + 10);
    }
    const retry = await connect();
    expect(retry).toMatchObject({ ok: false, error: { code: "RELAY_STORAGE_UNCERTAIN" } });
    if (!failed.ok && !retry.ok) expect(retry.error.retryAfterMs!).toBeGreaterThan(failed.error.retryAfterMs!);
    expect(inspections).toBe(2);
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);

test("real competing process returns SQLITE_BUSY without takeover; SIGKILL releases the native owner for same-epoch recovery", async () => {
  const root = mkdtempSync("/tmp/relay-native-owner-"), relayRoot = join(root, "relay"), ready = join(root, "ready.json"), home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const child = Bun.spawn([process.execPath, new URL("../integration/fixtures/restart-safe-journal-owner.ts", import.meta.url).pathname, relayRoot, ready], {
    env: { HOME: home, WOLFPACK_DIR: join(root, "state"), WOLFPACK_PORT: "1", WOLFPACK_TEST: "1", PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
  let gateway: ReturnType<typeof createTaskRelayGateway> | undefined;
  try {
    const deadline = performance.now() + 5000;
    while (!existsSync(ready) && child.exitCode === null && performance.now() < deadline) await Bun.sleep(10);
    if (!existsSync(ready)) throw new Error(`private owner did not become ready: exit=${child.exitCode}`);
    const epoch = JSON.parse(readFileSync(ready, "utf8")).epoch;
    const hash = () => createHash("sha256").update(readFileSync(join(relayRoot, "restart-safe-v1.sqlite"))).digest("hex");
    const before = hash();
    gateway = createTaskRelayGateway({ root: relayRoot, storage: "sqlite", inspectSession: async selector => ({ ok: true, sessionId: selector, session: "fixture", projectPath: root, harness: "pi", alive: true }) });
    const failure = await gateway.initialize().catch(error => error);
    expect(failure.code).toBe("RELAY_STORAGE_BUSY"); expect(failure.failure.ownerFatal).toBe(true);
    expect(failure.failure.mayHaveBeenDelivered).toBeUndefined(); expect(child.exitCode).toBeNull(); expect(hash()).toBe(before);
    const request = { operation: "connect", profile: gateway.profile, callerSession: randomUUID(), generation: randomUUID(), protocolVersions: [2] };
    const cooling = await gateway.volatile(request);
    expect(cooling.ok).toBe(false); if (cooling.ok) throw new Error("live owner was taken over");
    expect(cooling.error.code).toBe("RELAY_STORAGE_RECOVERING");
    child.kill("SIGKILL"); await child.exited;
    await Bun.sleep(cooling.error.retryAfterMs! + 10);
    const resumed = await gateway.volatile(request);
    expect(resumed.ok).toBe(true); if (!resumed.ok) throw new Error("owner was not recovered after confirmed process death");
    expect(resumed.epoch).toBe(epoch);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL"); await child.exited;
    const output = await new Response(child.stdout).text(), errors = await new Response(child.stderr).text();
    if (output) console.log(output); if (errors) console.error(errors);
    await gateway?.close(); rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("unsupported storage stays explicitly blocked instead of repeatedly reopening or adopting a repaired file", async () => {
  const root = mkdtempSync("/tmp/relay-invalid-owner-"), seed = createRecoveryStore({ root }); const epoch = seed.store.epoch; seed.close();
  const path = join(root, "restart-safe-v1.sqlite");
  const version = (value: number) => { const db = new Database(path); db.exec(`PRAGMA user_version=${value}`); db.close(); };
  version(99); let inspections = 0;
  const options = { root, storage: "sqlite" as const, inspectSession: async (selector: string) => {
    inspections++; return { ok: true as const, sessionId: selector, session: "fixture", projectPath: root, harness: "pi", alive: true };
  } };
  let gateway = createTaskRelayGateway(options);
  const request = { operation: "connect", profile: gateway.profile, callerSession: randomUUID(), generation: randomUUID(), protocolVersions: [2] };
  try {
    const first = await gateway.volatile(request);
    expect(first.ok).toBe(false); if (first.ok) throw new Error("unsupported format was adopted");
    expect(first.error.code).toBe("RELAY_STORAGE_INVALID"); expect(first.error.retryable).toBe(false);
    // The rejected constructor has already closed its database. This is private fixture repair, not application migration.
    version(1);
    for (let i = 0; i < 3; i++) {
      const blocked = await gateway.volatile(request);
      expect(blocked.ok).toBe(false); if (blocked.ok) throw new Error("blocked owner was silently reopened");
      expect(blocked.error.code).toBe("RELAY_STORAGE_INVALID");
    }
    expect(inspections).toBe(0);
    await gateway.close(); gateway = createTaskRelayGateway(options);
    const afterExplicitReopen = await gateway.volatile(request);
    expect(afterExplicitReopen.ok).toBe(true); if (afterExplicitReopen.ok) expect(afterExplicitReopen.epoch).toBe(epoch);
    expect(inspections).toBe(1);
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);

test("unconfirmed termination blocks replacement and retains the native root reservation", async () => {
  const root = mkdtempSync("/tmp/relay-owner-termination-"), blocked = randomUUID(); poisonOneSession(root, blocked);
  const gateway = createTaskRelayGateway({ root, storage: "sqlite", inspectSession: async selector => ({ ok: true, sessionId: selector, session: "fixture", projectPath: root, harness: "pi", alive: true }) });
  const original = Worker.prototype.terminate; let unconfirmed: Worker | undefined;
  await gateway.initialize();
  const terminate = spyOn(Worker.prototype, "terminate").mockImplementation(function(this: Worker) {
    unconfirmed = this; return Promise.reject(new Error("private fixture termination rejection"));
  });
  const request = { operation: "connect", profile: gateway.profile, callerSession: blocked, generation: randomUUID(), protocolVersions: [2] };
  try {
    const failed = await gateway.volatile(request);
    expect(failed.ok).toBe(false); if (failed.ok) throw new Error("failing mutation was accepted");
    if (failed.error.retryAfterMs) await Bun.sleep(failed.error.retryAfterMs + 10);
    const fenced = await gateway.volatile(request);
    expect(fenced.ok).toBe(false); if (fenced.ok) throw new Error("unconfirmed owner was replaced");
    expect(fenced.error.code).toBe("RELAY_STORAGE_RECOVERY_BLOCKED"); expect(fenced.error.retryable).toBe(false);
    expect(() => createTaskRelayGateway({ root, storage: "sqlite" })).toThrow("already has a worker owner");
    expect(unconfirmed).toBeDefined();
  } finally {
    terminate.mockRestore();
    if (unconfirmed) await original.call(unconfirmed); // Exact fixture worker only, after the assertion.
    await gateway.close(); rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("a delayed genuinely committed reply cannot clear a later owner's failure cooldown", async () => {
  const root = mkdtempSync("/tmp/relay-owner-late-reply-"), blocked = randomUUID(), first = randomUUID(); poisonOneSession(root, blocked);
  const gateway = createTaskRelayGateway({ root, storage: "sqlite", inspectSession: async selector => ({ ok: true, sessionId: selector, session: "fixture", projectPath: root, harness: "pi", alive: true }) });
  let committed!: () => void, release!: () => void;
  const didCommit = new Promise<void>(resolve => { committed = resolve; }), releaseReply = new Promise<void>(resolve => { release = resolve; });
  const native = WorkerRelayGateway.prototype.volatile;
  const delivery = spyOn(WorkerRelayGateway.prototype, "volatile").mockImplementation(async function(this: WorkerRelayGateway, input: unknown) {
    const result = await native.call(this, input); // Real worker and real committed SQLite response.
    if ((input as { callerSession?: string }).callerSession === first && result.ok) { committed(); await releaseReply; }
    return result;
  });
  const connect = (callerSession: string) => gateway.volatile({ operation: "connect", profile: gateway.profile, callerSession, generation: randomUUID(), protocolVersions: [2] });
  let pending: ReturnType<typeof connect> | undefined;
  try {
    await gateway.initialize(); pending = connect(first); await didCommit;
    const failed = await connect(blocked);
    expect(failed.ok).toBe(false); if (failed.ok) throw new Error("scoped native failure was accepted");
    expect(failed.error.code).toBe("RELAY_STORAGE_UNCERTAIN");
    release(); expect((await pending).ok).toBe(true); // Preserve the truthful earlier acceptance.
    const afterLateReply = await connect(randomUUID());
    expect(afterLateReply.ok).toBe(false);
    if (!afterLateReply.ok) expect(afterLateReply.error.code).toBe("RELAY_STORAGE_RECOVERING");
  } finally { release(); await pending; delivery.mockRestore(); await gateway.close(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);

test("transient native open permission failure is not mislabeled as permanent invalid storage", async () => {
  const root = mkdtempSync("/tmp/relay-owner-open-"), seed = createRecoveryStore({ root }); const epoch = seed.store.epoch; seed.close();
  chmodSync(root, 0o000);
  const gateway = createTaskRelayGateway({ root, storage: "sqlite", inspectSession: async selector => ({ ok: true, sessionId: selector, session: "fixture", projectPath: root, harness: "pi", alive: true }) });
  const request = { operation: "connect", profile: gateway.profile, callerSession: randomUUID(), generation: randomUUID(), protocolVersions: [2] };
  try {
    const unavailable = await gateway.volatile(request);
    expect(unavailable.ok).toBe(false); if (unavailable.ok) throw new Error("inaccessible owner was accepted");
    expect(String(unavailable.error.code)).toBe("RELAY_STORAGE_UNAVAILABLE"); expect(unavailable.error.retryable).toBe(true);
    expect(unavailable.error.mayHaveBeenDelivered).toBeUndefined();
    chmodSync(root, 0o700);
    if (unavailable.error.retryAfterMs) await Bun.sleep(unavailable.error.retryAfterMs + 10);
    const resumed = await gateway.volatile(request);
    expect(resumed.ok).toBe(true); if (resumed.ok) expect(resumed.epoch).toBe(epoch);
  } finally { chmodSync(root, 0o700); await gateway.close(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);

/** Native SQLite fault, not a mocked worker response or copied state machine. */
test("a scoped SQLite write failure reports typed uncertain owner death, then reopens for an unrelated caller without replay", async () => {
  const root = mkdtempSync("/tmp/relay-owner-failure-"), blocked = randomUUID(), healthy = randomUUID();
  const epoch = poisonOneSession(root, blocked);
  const inspections = new Map<string, number>();
  const gateway = createTaskRelayGateway({ root, storage: "sqlite", inspectSession: async selector => {
    inspections.set(selector, (inspections.get(selector) ?? 0) + 1);
    return { ok: true, sessionId: selector, session: "reused-name", projectPath: root, harness: "pi", alive: true };
  } });
  const connect = (callerSession: string) => gateway.volatile({ operation: "connect", profile: "volatile-v1", callerSession, generation: randomUUID(), protocolVersions: [2] });
  try {
    await gateway.initialize();
    const failed = await connect(blocked);
    expect(failed).toMatchObject({ ok: false, error: { mayHaveBeenDelivered: true } });
    // Existing WIP can now close generically, but that is not the typed failure contract.
    expect(failed).toMatchObject({ ok: false, error: { code: "RELAY_STORAGE_UNCERTAIN", ownerFatal: true, retryable: true } });
    if (!failed.ok && failed.error.retryAfterMs) await Bun.sleep(failed.error.retryAfterMs + 10);
    const recovered = await connect(healthy);
    expect(recovered).toMatchObject({ ok: true, epoch, value: { kind: "connected" } });
    expect(inspections.get(blocked)).toBe(1);
    expect(inspections.get(healthy)).toBe(1);
    expect(await gateway.volatileEpoch()).toBe(epoch);
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);


test("a native scheduled-maintenance commit failure reports typed uncertain owner death", async () => {
  const root = mkdtempSync("/tmp/relay-owner-maintenance-"), seed = createRecoveryStore({ root });
  const now = Date.now() - 8 * 86_400_000 + 1500;
  const registration = seed.store.register({ sessionId: randomUUID(), generation: randomUUID(), leaseMs: 60_000, protocolVersions: [2] }, now);
  const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: registration.endpoint, target: registration.endpoint,
    createdAt: new Date(now).toISOString(), payload: { opaque: true } };
  seed.store.accept(seed.store.epoch, envelope, now);
  seed.store.acknowledge(seed.store.epoch, registration.endpoint.id, envelope.envelopeId, now); seed.close();
  const db = new Database(join(root, "restart-safe-v1.sqlite"));
  db.exec("CREATE TRIGGER fail_expiry BEFORE DELETE ON cells WHEN OLD.bucket='receipts' BEGIN SELECT RAISE(FAIL, 'private maintenance fault'); END;"); db.close();
  const gateway = new WorkerRelayGateway({ root, storage: "sqlite" });
  try {
    await gateway.initialize();
    const deadline = Date.now() + 5000;
    while (!gateway.isClosed && Date.now() < deadline) await Bun.sleep(20);
    expect(gateway.isClosed).toBe(true);
    expect(gateway.ownerFailure).toMatchObject({ code: "RELAY_STORAGE_UNCERTAIN", ownerFatal: true, mayHaveBeenDelivered: true });
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
}, 10_000);
