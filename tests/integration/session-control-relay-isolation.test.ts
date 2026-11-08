import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerRelayGateway } from "../../src/task-relay/worker-client.ts";
import { RELAY_WORKER_LIMITS } from "../../src/task-relay/worker-protocol.ts";
import { validateControlApiSchemaValue as validate } from "../control-api-schema-validator.ts";

// Isolate production singleton imports before loading the route factory.
const priorTest = process.env.WOLFPACK_TEST;
process.env.WOLFPACK_TEST = "1";
const { MockBackend } = await import("../../src/server/mock-backend.ts");
const { createServerContext } = await import("../../src/server/context.ts");
const { createSessionControlRoutes } = await import("../../src/server/session-control-routes.ts");
const { AssistantService } = await import("../../src/server/assistant-service.ts");
afterAll(() => {
  if (priorTest === undefined) delete process.env.WOLFPACK_TEST;
  else process.env.WOLFPACK_TEST = priorTest;
});

const LIVE_ID = "11111111-1111-4111-8111-111111111111";
const DEAD_ID = "22222222-2222-4222-8222-222222222222";
const schema = JSON.parse(readFileSync("docs/generated/control-api.schema.json", "utf8"));

class BackendFacts extends MockBackend {
  unavailable = false;
  constructor() { super({ sessions: ["live", "dead"] }); this.setSessionAlive("dead", false); }
  override async list() {
    if (this.unavailable) throw new Error("private broker failure");
    return super.list();
  }
  override async listIdentities() {
    const identities = await super.listIdentities();
    for (const identity of Object.values(identities)) {
      identity.wolfpackSessionId = identity.wolfpackSessionName === "live" ? LIVE_ID : DEAD_ID;
      identity.projectPath = "/fixture";
      identity.agentKind = "pi";
    }
    return identities;
  }
  override async inspectSession(selector: string) {
    if (this.unavailable) throw new Error("private broker failure");
    if (selector === "ambiguous") return { ok: false as const, code: "AMBIGUOUS" as const };
    return super.inspectSession(selector);
  }
}

async function fixture(pinned = false) {
  const root = mkdtempSync(join(tmpdir(), "session-relay-isolation-"));
  const backend = new BackendFacts();
  let blocked = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const gateway = new WorkerRelayGateway({ root, requestTimeoutMs: 1000, inspectSession: async selector => {
    if (blocked) await gate;
    return backend.inspectSession(selector);
  } });
  const config = pinned ? { devDir: "/tmp", port: 19846, pinnedSessions: [{ name: "live", cwd: "/fixture", command: ["pi"], harness: "pi" }] } : null;
  const routes = createSessionControlRoutes(createServerContext({ backend, taskRelayGateway: gateway, config,
    assistantService: new AssistantService({ root, readConfig: () => config }) }));
  const server = createServer((req, res) => {
    const route = routes[`GET ${new URL(req.url!, "http://localhost").pathname}`];
    if (!route) { res.writeHead(404).end(); return; }
    void route(req, res);
  });
  await gateway.initialize();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const read = async (path: string) => {
    const response = await fetch(`${origin}/api/session-control/${path}`, { signal: AbortSignal.timeout(2000) });
    expect(response.headers.get("cache-control")).toBe("no-store");
    return { status: response.status, body: await response.json() };
  };
  const connect = () => gateway.volatile({ operation: "connect", profile: "volatile-v1", callerSession: "live", generation: "fixture", protocolVersions: [2] });
  return {
    backend, gateway, read, connect,
    block: () => { blocked = true; },
    release,
    close: async () => {
      release();
      await gateway.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function assertDegraded(body: any) {
  expect(body).toMatchObject({ ok: true, session: "live", sessionId: LIVE_ID,
    terminal: { exists: true, alive: true, status: "ready" }, taskRelay: { status: "unavailable" } });
  expect(body.taskRelay.recovery).toContain("wolfpack service restart --server-only");
  expect(body.taskRelay.recovery).toContain("explicitly rebind");
  // Recovery must not turn optional relay failure into accidental terminal loss.
  expect(body.taskRelay.recovery).toMatch(/preserves sessions only with a verified independently owned broker/);
  expect(body.taskRelay.recovery).toMatch(/server child terminates an invocation-owned broker and its sessions/);
  expect(body.taskRelay.recovery).toMatch(/unknown ownership, do not restart unless you explicitly accept session loss/);
  expect(body.taskRelay.recovery).toContain("Interrupted mutations may have committed");
  expect(body.taskRelay.recovery).toContain("do not automatically replay tasks");
  expect(body).not.toHaveProperty("taskEndpoint");
  expect(body).not.toHaveProperty("taskTransport");
  expect(validate({ $ref: "#/$defs/SessionStatus" }, body, schema)).toEqual([]);
}

test("list adds runtime stop facts without changing terminal or identity fields", async () => {
  const { getAgentRuntimeStateStore } = await import("../../src/server/agent-status.ts");
  const store = getAgentRuntimeStateStore();
  const at = "2026-11-01T10:00:00.000Z";
  const input = { sessionKey: LIVE_ID, broker: { state: "alive" as const, observedAt: at }, sources: [], fallback: { rawOutputChanged: true, observedAt: at } };
  store.reduce(input);
  const stopped = store.reduce({ ...input, fallback: { ...input.fallback, rawOutputChanged: false } });
  const f = await fixture();
  try {
    const list = await f.read("list");
    expect(list.status).toBe(200);
    const live = list.body.sessions.find((s: any) => s.sessionId === LIVE_ID);
    expect(live).toMatchObject({ ok: true, session: "live", sessionId: LIVE_ID, state: "active", projectDir: "/fixture", harness: "pi", terminal: { exists: true, alive: true, status: "ready" }, runtime: { state: "idle", changedAt: at, stoppedAt: at, unseen: true, stopped: true, pinned: false } });
    expect(validate({ $ref: "#/$defs/SessionStatus" }, live, schema)).toEqual([]);
    const { stoppedAt: _, pinned: __, ...olderRuntime } = live.runtime;
    expect(validate({ $ref: "#/$defs/SessionStatus" }, { ...live, runtime: olderRuntime }, schema)).toEqual([]);
    store.acknowledge(LIVE_ID, stopped.transitionSequence);
    expect((await f.read("list")).body.sessions.find((s: any) => s.sessionId === LIVE_ID).runtime).toMatchObject({ unseen: false, stopped: false });
    expect((await f.read("list")).body.sessions.find((s: any) => s.sessionId === DEAD_ID).runtime).toEqual({ state: "unknown", changedAt: null, stoppedAt: null, unseen: false, stopped: false, pinned: false });
  } finally { await f.close(); }
});

test("list runtime facts expose server-owned pinned processes", async () => {
  const f = await fixture(true);
  try {
    expect((await f.read("list")).body.sessions.find((s: any) => s.sessionId === LIVE_ID).runtime.pinned).toBe(true);
  } finally { await f.close(); }
});

test("healthy reads distinguish a live registration from absent registration without changing payloads", async () => {
  const f = await fixture();
  try {
    const absent = await f.read(`status?session=${LIVE_ID}`);
    expect(absent.status).toBe(200);
    expect(absent.body).not.toHaveProperty("taskRelay");
    expect(absent.body).not.toHaveProperty("taskEndpoint");
    const connected = await f.connect();
    if (!connected.ok || connected.value.kind !== "connected") throw new Error("fixture connection failed");
    const status = await f.read(`status?session=${LIVE_ID}`);
    expect(status.status).toBe(200);
    expect(status.body.taskEndpoint).toEqual(connected.value.endpoint);
    expect(status.body.taskTransport).toEqual({ profile: "volatile-v1", epoch: connected.epoch,
      endpoint: connected.value.endpoint, leaseExpiresAt: connected.value.leaseExpiresAt });
    expect(status.body).not.toHaveProperty("taskRelay");
    // A registration can outlive terminal liveness; it must not confer readiness.
    f.backend.setSessionAlive("dead", true);
    expect(await f.gateway.volatile({ operation: "connect", profile: "volatile-v1", callerSession: "dead", generation: "fixture", protocolVersions: [2] })).toMatchObject({ ok: true });
    f.backend.setSessionAlive("dead", false);
    const list = await f.read("list");
    expect(list.status).toBe(200);
    expect(list.body.sessions.find((s: any) => s.sessionId === LIVE_ID).taskTransport).toEqual(status.body.taskTransport);
    const dead = list.body.sessions.find((s: any) => s.sessionId === DEAD_ID);
    expect(dead.terminal).toEqual({ exists: true, alive: false, status: "dead" });
    expect(dead).not.toHaveProperty("taskEndpoint");
    expect(dead).not.toHaveProperty("taskTransport");
  } finally { await f.close(); }
});

test("real worker timeout preserves live list/status truth but task operations remain reset and uncertain", async () => {
  const f = await fixture();
  try {
    expect(await f.connect()).toMatchObject({ ok: true });
    f.block();
    expect(await f.connect()).toMatchObject({ ok: false, error: { code: "RELAY_RESET", retryable: false, mayHaveBeenDelivered: true } });
    const [list, status] = await Promise.all([f.read("list"), f.read(`status?session=${LIVE_ID}`)]);
    expect(status.status).toBe(200);
    assertDegraded(status.body);
    expect(list.status).toBe(200);
    expect(list.body.sessions.map((s: any) => s.sessionId).sort()).toEqual([LIVE_ID, DEAD_ID]);
    assertDegraded(list.body.sessions.find((s: any) => s.sessionId === LIVE_ID));
    expect(await f.connect()).toMatchObject({ ok: false, error: { code: "RELAY_RESET", retryable: false, mayHaveBeenDelivered: true } });
    await expect(f.gateway.volatileEpoch()).rejects.toBeDefined();
  } finally { await f.close(); }
});

test("closed relay cannot mask dead/missing/ambiguous facts or true broker unavailability", async () => {
  const f = await fixture();
  try {
    await f.gateway.close();
    const lookup = spyOn(f.gateway, "registrationsForSessions");
    try {
      const dead = await f.read(`status?session=${DEAD_ID}`);
      expect(dead).toMatchObject({ status: 410, body: { ok: false, sessionId: DEAD_ID,
        terminal: { exists: true, alive: false, status: "dead" }, error: { code: "SESSION_DEAD" } } });
      for (const [selector, status, code] of [["missing", 404, "SESSION_NOT_FOUND"], ["ambiguous", 409, "AMBIGUOUS_SELECTOR"]] as const) {
        const result = await f.read(`status?session=${selector}`);
        expect(result).toMatchObject({ status, body: { ok: false, error: { code } } });
        expect(result.body).not.toHaveProperty("taskEndpoint");
      }
      expect(lookup).not.toHaveBeenCalled();
      f.backend.unavailable = true;
      expect(await f.read(`status?session=${LIVE_ID}`)).toMatchObject({ status: 503, body: {
        error: { code: "BACKEND_UNAVAILABLE" }, terminal: { exists: false, alive: false, status: "unavailable" } } });
      expect(await f.read("list")).toEqual({ status: 503, body: { error: "backend unavailable" } });
      f.backend.unavailable = false;
      f.backend.setSessions([]);
      expect(await f.read("list")).toEqual({ status: 200, body: { sessions: [] } });
      expect(lookup).not.toHaveBeenCalled();
    } finally { lookup.mockRestore(); }
  } finally { await f.close(); }
});

test("bounded admission failure degrades reads only for that request, without poisoning healthy enrichment", async () => {
  const f = await fixture();
  const pending: ReturnType<typeof f.connect>[] = [];
  try {
    f.block();
    for (let i = 0; i < RELAY_WORKER_LIMITS.regularRequests; i++) pending.push(f.connect());
    const list = await f.read("list");
    expect(list.status).toBe(200);
    assertDegraded(list.body.sessions.find((s: any) => s.sessionId === LIVE_ID));
    const status = await f.read(`status?session=${LIVE_ID}`);
    expect(status.status).toBe(200);
    assertDegraded(status.body);
    f.release();
    expect((await Promise.all(pending)).every(result => result.ok)).toBe(true);
    const recovered = await f.read(`status?session=${LIVE_ID}`);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toHaveProperty("taskEndpoint");
    expect(recovered.body).not.toHaveProperty("taskRelay");
  } finally { f.release(); await Promise.all(pending); await f.close(); }
});
