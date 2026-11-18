import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, renameSync, mkdirSync, statSync } from "node:fs";
import { createTaskRelayGateway } from "../../src/task-relay/gateway.ts";
import { randomUUID } from "node:crypto";
import { seedInvalidRelayJournal, relayJournalRows } from "../integration/fixtures/invalid-relay-journal.ts";
import { createRecoveryStore } from "../../src/task-relay/recovery-store.ts";

test("invalid relay storage cannot prevent core HTTP and session access or silently reset the journal", () => {
  const home = mkdtempSync(join(tmpdir(), "relay-startup-containment-")), root = join(home, "relay");
  try {
    seedInvalidRelayJournal(root);
    const db = new Database(join(root, "restart-safe-v1.sqlite"), { readonly: true });
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" }); db.close();
    expect(() => createRecoveryStore({ root })).toThrow("RELAY_STORAGE_INVALID");
    const before = relayJournalRows(root);
    const result = spawnSync(process.execPath, ["-e", `
      import { server, startServer } from "./src/server/index.ts";
      import { MockBackend } from "./src/server/mock-backend.ts";
      import { getDefaultServerContext } from "./src/server/context.ts";
      await startServer(0, "127.0.0.1", { backend: new MockBackend({ sessions: ["kept"], capturePane: async () => "terminal output" }) });
      if (!server.listening) await new Promise(resolve => server.once("listening", resolve));
      const base = "http://127.0.0.1:" + server.address().port;
      const get = async path => { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; };
      const health = await get("/api/health"), poll = await get("/api/poll?session=kept"), sessions = await get("/api/sessions");
      const profile = await get("/api/task-relay/profile");
      const relay = await fetch(base + "/api/task-relay/volatile-v1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "connect", profile: "volatile-v1", callerSession: "kept", generation: "new", protocolVersions: [2] }) });
      const asset = await fetch(base + "/app.bundle.js"); await asset.arrayBuffer();
      const gateway = getDefaultServerContext().taskRelayGateway;
      let lookupFailure; try { await gateway.registrationsForSessions(["kept"]); } catch(e) { lookupFailure = e.code; }
      console.log("RESULT:" + JSON.stringify({ health, poll, sessions: sessions.status, profile, relay: { status: relay.status, body: await relay.json() }, asset: asset.status, lookupFailure }));
      await gateway.close();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    `], { encoding: "utf8", timeout: 15000, env: {
      ...process.env, HOME: home, WOLFPACK_DIR: join(home, ".wolfpack"), WOLFPACK_TEST: "1", WOLFPACK_JWT_SECRET: "",
      WOLFPACK_TASK_ROOT: join(home, "tasks"), WOLFPACK_TASK_RELAY_ROOT: root, WOLFPACK_TASK_RELAY_STORAGE: "sqlite",
    } });
    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.split("\n").find(line => line.startsWith("RESULT:"));
    expect(line).toBeDefined();
    const output = JSON.parse(line!.slice(7));
    expect(result.stdout).not.toContain("replace terminated worker");
    expect(output.health).toMatchObject({ status: 200, body: { status: "ready", broker: { state: "ready" }, relay: { state: "unavailable", code: "RELAY_STORAGE_INVALID", retryable: false } } });
    expect(output.poll).toEqual({ status: 200, body: { pane: "terminal output" } });
    expect(output.sessions).toBe(200); expect(output.asset).toBe(200);
    for (const reply of [output.profile, output.relay]) expect(reply).toMatchObject({ status: 503, body: { ok: false, error: { code: "RELAY_STORAGE_INVALID", retryable: false } } });
    expect(output.lookupFailure).toBe("RELAY_STORAGE_INVALID");
    expect(relayJournalRows(root)).toEqual(before);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 20000);

for (const fault of ["construction", "termination", "timeout", "programming"] as const) test(`relay startup boundary: ${fault}`, () => {
  const home = mkdtempSync(join(tmpdir(), "relay-startup-fault-"));
  try {
    const result = spawnSync(process.execPath, ["-e", `
      import { spyOn } from "bun:test";
      import { Worker } from "node:worker_threads";
      const workers = new Set();
      const unref = Worker.prototype.unref, terminate = Worker.prototype.terminate;
      if (${JSON.stringify(fault)} !== "programming") spyOn(Worker.prototype, "unref").mockImplementation(function() {
        workers.add(this);
        if (["construction", "termination"].includes(${JSON.stringify(fault)}) && workers.size === 1) throw new Error("private native worker constructor failure");
        return unref.call(this);
      });
      if (${JSON.stringify(fault)} === "termination") spyOn(Worker.prototype, "terminate").mockImplementation(async function() {
        await terminate.call(this); // Stop the real private worker, but withhold confirmation from the owner.
        throw new Error("termination confirmation unavailable");
      });
      if (${JSON.stringify(fault)} === "timeout") spyOn(Worker.prototype, "postMessage").mockImplementation(() => undefined);
      const { server, startServer } = await import("./src/server/index.ts");
      const { MockBackend } = await import("./src/server/mock-backend.ts");
      const { createTaskRelayGateway } = await import("./src/task-relay/gateway.ts");
      const { operationalHealth } = await import("./src/server/operability.ts");
      const { createServerContext } = await import("./src/server/context.ts");
      const backend = new MockBackend({ sessions: ["kept"] });
      // Status reads alone cannot construct a worker.
      const cold = createServerContext({ backend });
      operationalHealth(cold); operationalHealth(cold);
      if (workers.size !== 0) throw new Error("health spawned a worker");
      const gateway = ${JSON.stringify(fault)} === "programming" ? { async initialize() { throw new TypeError("unrelated programming error"); } }
        : createTaskRelayGateway({ root: ${JSON.stringify(join(home, "relay"))}, storage: "sqlite", requestTimeoutMs: ${fault === "timeout" ? 20 : 1000} });
      try {
        await startServer(0, "127.0.0.1", { backend, taskRelayGateway: gateway });
        if (!server.listening) await new Promise(resolve => server.once("listening", resolve));
        const base = "http://127.0.0.1:" + server.address().port;
        const health = await (await fetch(base + "/api/health")).json();
        for(let i=0;i<5;i++) await (await fetch(base + "/api/health")).json();
        const beforeRecovery = workers.size;
        let recovery;
        if (["construction", "termination"].includes(${JSON.stringify(fault)})) {
          const cooldown = await gateway.volatile({ operation: "connect" });
          if (cooldown.ok || cooldown.error.code !== "RELAY_STORAGE_RECOVERING") throw new Error("missing construction cooldown");
          await Bun.sleep(cooldown.error.retryAfterMs + 20);
          try { await Promise.all([gateway.initialize(), gateway.initialize()]); } catch(e) {
            if (${JSON.stringify(fault)} !== "termination" || e.code !== "RELAY_STORAGE_RECOVERY_BLOCKED") throw e;
          }
          recovery = gateway.health();
        }
        console.log("RESULT:" + JSON.stringify({ health, workers: workers.size, beforeRecovery, recovery }));
      } catch(e) {
        if (${JSON.stringify(fault)} !== "programming") throw e;
        console.log("RESULT:" + JSON.stringify({ error: e.message, listening: server.listening }));
      } finally {
        if (gateway.close) await gateway.close();
        if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      }
    `], { encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: home, WOLFPACK_DIR: join(home, ".wolfpack"), WOLFPACK_TEST: "1", WOLFPACK_JWT_SECRET: "", WOLFPACK_TASK_ROOT: join(home, "tasks"), WOLFPACK_TASK_RELAY_ROOT: join(home, "relay") } });
    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.split("\n").find(line => line.startsWith("RESULT:"));
    expect(line).toBeDefined(); const output = JSON.parse(line!.slice(7));
    if (fault === "programming") expect(output).toEqual({ error: "unrelated programming error", listening: false });
    else expect(output).toMatchObject({ health: { status: "ready", relay: { state: "unavailable", code: "RELAY_UNAVAILABLE", retryable: true } } });
    if (fault === "construction") expect(output).toMatchObject({ beforeRecovery: 1, workers: 2, recovery: { state: "ready" } });
    if (fault === "termination") expect(output).toMatchObject({ beforeRecovery: 1, workers: 1, recovery: { state: "unavailable", code: "RELAY_STORAGE_RECOVERY_BLOCKED", retryable: false } });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// Characterize the operator's archive/fresh-root procedure with actual native stores and gateways.
// No product reset endpoint or automatic recovery state machine is introduced.
test("invalid relay stays blocked; explicit archival preserves evidence and starts a fresh epoch without old mail", async () => {
  const home = mkdtempSync(join(tmpdir(), "relay-explicit-recovery-")), root = join(home, "relay"), archive = join(home, "archive");
  const oldEpoch = seedInvalidRelayJournal(root), before = relayJournalRows(root);
  const gateway = createTaskRelayGateway({ root, storage: "sqlite" });
  let fresh: ReturnType<typeof createTaskRelayGateway> | undefined;
  try {
    await expect(gateway.initialize()).rejects.toThrow("RELAY_STORAGE_INVALID");
    for (let i = 0; i < 3; i++) {
      expect(gateway.health()).toMatchObject({ state: "unavailable", code: "RELAY_STORAGE_INVALID", retryable: false });
      expect(await gateway.volatile({ operation: "connect" })).toMatchObject({ ok: false, error: { code: "RELAY_STORAGE_INVALID" } });
    }
    expect(existsSync(archive)).toBe(false); expect(relayJournalRows(root)).toEqual(before);
    await gateway.close(); // Ownership release precedes any operator filesystem operation.
    mkdirSync(archive, { mode: 0o700 });
    // Failed archive operations cannot start an empty relay or discard the original.
    expect(() => renameSync(root, join(archive, "missing", "relay"))).toThrow();
    expect(relayJournalRows(root)).toEqual(before);
    renameSync(root, join(archive, "relay"));
    expect(existsSync(root)).toBe(false); // Interruption here leaves the original intact, not replayable.
    expect(relayJournalRows(join(archive, "relay"))).toEqual(before);
    expect(statSync(archive).mode & 0o077).toBe(0);
    const sessionId = randomUUID();
    fresh = createTaskRelayGateway({ root, storage: "sqlite", inspectSession: async () => ({ ok: true, session: "fresh", sessionId, projectPath: home, harness: "pi", alive: true }) });
    await fresh.initialize(); const epoch = await fresh.volatileEpoch(); expect(epoch).not.toBe(oldEpoch);
    const connected = await fresh.volatile({ operation: "connect", profile: fresh.profile, callerSession: sessionId, generation: randomUUID(), protocolVersions: [2] });
    expect(connected.ok).toBe(true);
    if (!connected.ok || connected.value.kind !== "connected") throw new Error("fresh connect failed");
    const request = { operation: "receive", profile: fresh.profile, callerSession: sessionId, endpoint: connected.value.endpoint, cursor: "0" };
    expect(await fresh.volatile({ ...request, epoch: oldEpoch })).toMatchObject({ ok: false, error: { code: "RELAY_RESET" } });
    const received = await fresh.volatile({ ...request, epoch });
    expect(received).toMatchObject({ ok: true, value: { deliveries: [] } });
    expect(relayJournalRows(join(archive, "relay"))).toEqual(before);
  } finally { await gateway.close(); await fresh?.close(); chmodSync(home, 0o700); rmSync(home, { recursive: true, force: true }); }
});
