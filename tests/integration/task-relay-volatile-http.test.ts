import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket, type AddressInfo } from "node:net";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { validateControlApiSchemaValue as validate, type JsonObject } from "../control-api-schema-validator.ts";

const names = ["WOLFPACK_TEST", "WOLFPACK_TASK_RELAY_ROOT", "WOLFPACK_TASK_RELAY_PROFILE", "WOLFPACK_JWT_SECRET", "WOLFPACK_JWT_AUDIENCE"];
const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
process.env.WOLFPACK_TEST = "1";
const root = mkdtempSync(join(tmpdir(), "wolfpack-volatile-http-"));
const relayRoot = join(root, "relay"); mkdirSync(relayRoot); mkdirSync(join(root, "project"));
const sentinel = join(relayRoot, "relay-state.json");
writeFileSync(sentinel, "not JSON: historical relay state must not be read or rewritten\n");
const original = readFileSync(sentinel);
const secret = "synthetic-volatile-http-secret-not-a-production-credential";
const token = (() => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const value = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: "fixture", aud: "volatile-http", exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return `${value}.${createHmac("sha256", secret).update(value).digest("base64url")}`;
})();
const { __setTestBackend } = await import("../../src/server/backend.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
const { __resetJwtAuthConfig } = await import("../../src/test-hooks.ts");
const { getTaskRelayGateway, getTaskRelayProfile, __resetTaskRelayGatewayForTests } = await import("../../src/task-relay/gateway.ts");
const { WorkerRelayGateway } = await import("../../src/task-relay/worker-client.ts");
const { createServerInstance } = await import("../../src/server/index.ts");
const { VOLATILE_HTTP_LIMITS } = await import("../../src/server/volatile-relay-routes.ts");
const { buildControlApiSchema } = await import("../../src/control-api/schema.ts");
const { RELAY_ID } = await import("../../src/task-relay/domain.ts");
const schema = buildControlApiSchema() as JsonObject;
class PiBackend extends MockBackend {
  override async listIdentities() {
    return Object.fromEntries(["sender", "receiver"].map(name => [name, { wolfpackSessionId: `${name}-id`, wolfpackSessionName: name, projectPath: join(root, "project"), agentKind: "pi" as const, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]));
  }
}
const { server, wss } = createServerInstance();
let base = "", gateway: InstanceType<typeof WorkerRelayGateway>;
const path = "/api/task-relay/volatile-v1";
const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
beforeAll(async () => { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
beforeEach(async () => {
  await __resetTaskRelayGatewayForTests();
  process.env.WOLFPACK_TASK_RELAY_ROOT = relayRoot; process.env.WOLFPACK_TASK_RELAY_PROFILE = "volatile-v1";
  process.env.WOLFPACK_JWT_SECRET = secret; process.env.WOLFPACK_JWT_AUDIENCE = "volatile-http"; __resetJwtAuthConfig();
  __setTestBackend(new PiBackend({ sessions: ["sender", "receiver"] }));
  gateway = getTaskRelayGateway() as InstanceType<typeof WorkerRelayGateway>;
  expect(gateway).toBeInstanceOf(WorkerRelayGateway); await gateway.initialize();
});
afterAll(async () => {
  try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); wss.close(); }
  finally {
    await __resetTaskRelayGatewayForTests();
    expect(readFileSync(sentinel)).toEqual(original);
    rmSync(root, { recursive: true, force: true });
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    __resetJwtAuthConfig();
  }
});
async function post(body: unknown, route = path) {
  const response = await fetch(base + route, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await response.json() as any;
  if (route === path) expect(validate({ $ref: "#/$defs/VolatileResponse" }, payload, schema)).toEqual([]);
  return { response, body: payload };
}
async function connect(callerSession: string) {
  const { response, body } = await post({ operation: "connect", profile: "volatile-v1", callerSession, generation: randomUUID(), protocolVersions: [2] });
  expect(response.status).toBe(200);
  return { profile: "volatile-v1", epoch: body.epoch as string, callerSession, endpoint: body.value.endpoint as { relay: string; id: string } };
}
function envelope(source: { relay: string; id: string }, target: { relay: string; id: string }) {
  return { source, target, envelopeId: randomUUID(), protocolVersion: 2, payload: { opaque: "synthetic payload" }, createdAt: new Date().toISOString() };
}

test("normal default is memory-owned, selection is frozen, and explicit compatibility mode never silently migrates state", async () => {
  await __resetTaskRelayGatewayForTests(); delete process.env.WOLFPACK_TASK_RELAY_PROFILE;
  expect(getTaskRelayProfile()).toBe("volatile-v1");
  const defaultBinding = await connect("sender");
  expect(defaultBinding.epoch).toBeString();
  expect(readFileSync(sentinel)).toEqual(original);
  await __resetTaskRelayGatewayForTests(); process.env.WOLFPACK_TASK_RELAY_PROFILE = "durable-v2";
  expect(getTaskRelayProfile()).toBe("durable-v2");
  const result = await post({ operation: "connect", profile: "volatile-v1" });
  expect(result.response.status).toBe(409); expect(result.body.error).toMatchObject({ code: "RELAY_PROFILE_REQUIRED", retryable: false });
  const info = await (await fetch(base + "/api/task-relay/profile", { headers })).json();
  expect(validate({ $ref: "#/$defs/TaskRelayProfileResponse" }, info, schema)).toEqual([]);
  expect(info).toMatchObject({ profile: "durable-v2", federation: "existing-v2-policy" });
  process.env.WOLFPACK_TASK_RELAY_PROFILE = "typo"; expect(() => getTaskRelayGateway()).toThrow("invalid WOLFPACK_TASK_RELAY_PROFILE");
  expect(readFileSync(sentinel)).toEqual(original);
  process.env.WOLFPACK_TASK_RELAY_PROFILE = "volatile-v1"; gateway = getTaskRelayGateway() as typeof gateway;
  process.env.WOLFPACK_TASK_RELAY_PROFILE = "durable-v2";
  expect(getTaskRelayProfile()).toBe("volatile-v1"); expect(getTaskRelayGateway()).toBe(gateway);
});

test("real middleware protects metadata and both ingress lanes; valid JWT does not authorize peers", async () => {
  for (const route of ["/api/task-relay/profile", path, `${path}/peer`]) {
    const method = route.endsWith("profile") ? "GET" : "POST";
    expect((await fetch(base + route, { method })).status).toBe(401);
    expect((await fetch(base + route, { method, headers: { ...headers, origin: "https://untrusted.invalid" } })).status).toBe(403);
  }
  const info = await (await fetch(base + "/api/task-relay/profile", { headers })).json();
  expect(validate({ $ref: "#/$defs/TaskRelayProfileResponse" }, info, schema)).toEqual([]);
  expect(info).toMatchObject({ profile: "volatile-v1", epoch: await gateway.volatileEpoch(), federation: "verified-same-user-v1" });
  const binding = await connect("sender");
  for (const operation of ["receivePeer", "resolvePeer"]) {
    expect((await post({ ...binding, operation, origin: "https://claimed.example.ts.net" })).body.error.code).toBe("INVALID_REQUEST");
  }
  const receiver = await connect("receiver");
  const peer = await post({ operation: "receivePeer", profile: "volatile-v1", epoch: binding.epoch, sourceEpoch: randomUUID(),
    origin: "https://claimed.example.ts.net", envelope: envelope(binding.endpoint, receiver.endpoint) }, `${path}/peer`);
  expect(peer.response.status).toBe(403); expect(peer.body.error).toMatchObject({ code: "PEER_POLICY_REQUIRED", retryable: false });
  expect((await post({ ...binding, operation: "resolve", target: { relay: `${RELAY_ID}:peer:${randomUUID()}`, id: randomUUID() } })).body.error.code).toBe("CROSS_RELAY_ENDPOINT");
  const health = await post({ ...binding, operation: "health" }); expect(health.body.value.store.routes).toBe(0); expect(health.body.value.store.activeItems).toBe(0);
});

test("legacy routes cannot enter the volatile engine; discovery reports its explicit live transport",  async () => {
  const binding = await connect("sender");
  const { taskRelayRoutes } = await import("../../src/server/task-relay-routes.ts");
  for (const key of Object.keys(taskRelayRoutes)) {
    const [method, route] = key.split(" ");
    const response = await fetch(base + route, { method, headers, ...(method === "POST" && { body: "{}" }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "INCOMPATIBLE_PROTOCOL", retryable: false } });
  }
  expect(await gateway.endpointForSession("sender-id")).toBeUndefined();
  expect(await gateway.endpointsForSessions(["sender-id"])).toEqual(new Map());
  const registration = (await gateway.registrationsForSessions(["sender-id"])).get("sender-id");
  expect(registration).toMatchObject({ profile: binding.profile, epoch: binding.epoch, endpoint: binding.endpoint });
  expect(validate({ $ref: "#/$defs/TaskRelayRegistration" }, registration, schema)).toEqual([]);
  const statusResponse = await fetch(base + "/api/session-control/status?session=sender", { headers });
  expect(statusResponse.headers.get("cache-control")).toBe("no-store");
  const status = await statusResponse.json() as any;
  expect(status.taskEndpoint).toEqual(binding.endpoint); expect(status.taskTransport).toEqual(registration);
  const listResponse = await fetch(base + "/api/session-control/list", { headers });
  expect(listResponse.headers.get("cache-control")).toBe("no-store");
  const list = await listResponse.json() as any;
  expect(list.sessions.find((s: any) => s.sessionId === "sender-id").taskTransport).toEqual(registration);
  expect((await post({ ...binding, operation: "health" })).body.value.store.activeItems).toBe(0);
  await post({ ...binding, operation: "disconnect" });
  const retired = await (await fetch(base + "/api/session-control/status?session=sender", { headers })).json() as any;
  expect(retired.taskEndpoint).toBeUndefined(); expect(retired.taskTransport).toBeUndefined();
});

test("HTTP delivers opaque content, checks full conflicts, and preserves individual ACKs and reset epochs", async () => {
  const a = await connect("sender"), b = await connect("receiver");
  const first = envelope(a.endpoint, b.endpoint), second = envelope(a.endpoint, b.endpoint);
  const send = await post({ ...a, operation: "send", envelope: first }); expect(send.body.value.forwarding).toBe("local");
  expect((await post({ ...a, operation: "send", envelope: first })).body.value).toMatchObject({ acceptanceId: send.body.value.acceptanceId, duplicate: true });
  expect((await post({ ...a, operation: "send", envelope: { ...first, payload: { opaque: "changed" } } })).body.error.code).toBe("ENVELOPE_CONFLICT");
  expect((await post({ ...a, operation: "send", envelope: { ...first, createdAt: new Date(Date.parse(first.createdAt) + 1).toISOString() } })).body.error.code).toBe("ENVELOPE_CONFLICT");
  await post({ ...a, operation: "send", envelope: second });
  expect((await post({ ...b, callerSession: "sender", operation: "receive", cursor: "0" })).body.error.code).toBe("SOURCE_MISMATCH");
  const page = await post({ ...b, operation: "receive", cursor: "0" }); expect(page.body.value.deliveries.map((item: any) => item.cursor)).toEqual(["1", "2"]);
  expect(page.body.value.deliveries[0].envelope).toEqual(first);
  expect((await post({ ...b, operation: "acknowledge", envelopeId: second.envelopeId })).body.value.duplicate).toBe(false);
  expect((await post({ ...b, operation: "acknowledge", envelopeId: second.envelopeId })).body.value.duplicate).toBe(true);
  expect((await post({ ...b, operation: "receive", cursor: "0" })).body.value.deliveries.map((item: any) => item.cursor)).toEqual(["1"]);
  await __resetTaskRelayGatewayForTests(); gateway = getTaskRelayGateway() as typeof gateway; await gateway.initialize();
  expect((await post({ ...b, operation: "receive", cursor: "0" })).body).toMatchObject({ ok: false, error: { code: "RELAY_RESET", retryable: false, mayHaveBeenDelivered: true } });
  expect(await gateway.volatileEpoch()).not.toBe(b.epoch);
  const fresh = await connect("receiver"); expect(fresh.endpoint).not.toEqual(b.endpoint);
  expect((await post({ ...fresh, operation: "receive", cursor: "0" })).body.value).toMatchObject({ deliveries: [], nextCursor: "0" });
  expect(readFileSync(sentinel)).toEqual(original);
});

test("malformed/oversized bodies and unsupported content types fail before admission", async () => {
  const binding = await connect("sender");
  for (const [body, type, status] of [["{", "application/json", 400], ["x".repeat(VOLATILE_HTTP_LIMITS.bodyBytes + 1), "application/json", 413], ["{}", "application/jsonp", 400], [Buffer.concat([Buffer.from('{"operation":"connect","profile":"volatile-v1","callerSession":"sender","generation":"'), Buffer.from([0xff]), Buffer.from('","protocolVersions":[2]}')]), "application/json", 400]] as const) {
    const response = await fetch(base + path, { method: "POST", headers: { ...headers, "content-type": type }, body });
    expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", retryable: false } });
  }
  expect((await post({ ...binding, operation: "health" })).body.value.store.activeItems).toBe(0);
});

function partial(): { req: Socket; opened: Promise<void>; response: Promise<number> } {
  let open!: () => void, failOpen!: (error: Error) => void;
  const opened = new Promise<void>((resolve, reject) => { open = resolve; failOpen = reject; });
  const req = createConnection({ host: "127.0.0.1", port: Number(new URL(base).port) });
  const response = new Promise<number>((resolve, reject) => {
    let received = "", settled = false;
    req.on("connect", () => req.write(`POST ${path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: ${headers.authorization}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`, open));
    req.on("data", chunk => { received += chunk.toString(); const status = /^HTTP\/1\.1 ([0-9]{3})/.exec(received); if (status) { settled = true; resolve(Number(status[1])); } });
    req.on("error", error => { failOpen(error); reject(error); });
    req.on("close", () => { if (!settled) reject(new Error("partial request closed before response")); });
  });
  void response.catch(() => undefined);
  return { req, opened, response };
}
test("body deadline and pre-body concurrency cap release abandoned request slots", async () => {
  const slow = partial();
  try { await slow.opened; expect(await slow.response).toBe(408); } finally { slow.req.destroy(); }
  const held = Array.from({ length: VOLATILE_HTTP_LIMITS.requests }, partial);
  try {
    await Promise.all(held.map(item => item.opened));
    // Observe actual admission; socket-write completion alone is not server admission.
    let status = 0;
    for (let attempt = 0; attempt < 30; attempt++) {
      status = (await fetch(base + "/api/task-relay/profile", { headers })).status;
      if (status === 503) break;
      await Bun.sleep(10);
    }
    expect(status).toBe(503);
    const denied = await post({ operation: "connect", profile: "volatile-v1", callerSession: "sender", generation: "blocked", protocolVersions: [2] });
    expect(denied.body.error).toMatchObject({ code: "RELAY_CAPACITY", retryable: true });
  } finally { for (const item of held) item.req.destroy(); await Promise.allSettled(held.map(item => item.response)); }
  let recovered = 0;
  for (let attempt = 0; attempt < 30; attempt++) { recovered = (await fetch(base + "/api/task-relay/profile", { headers })).status; if (recovered === 200) break; await Bun.sleep(10); }
  expect(recovered).toBe(200); await connect("sender");
}, 10_000);

const piSource = process.env.WOLFPACK_PI_TASKS_SOURCE, piRevision = process.env.WOLFPACK_PI_TASKS_REVISION;
if (Boolean(piSource) !== Boolean(piRevision)) throw new Error("both trusted pi-tasks source and exact revision are required");
test.skipIf(!piSource)("actual pinned pi-tasks core/SQLite traverses production HTTP middleware and persists reset/rebind", async () => {
  if (!piSource || !isAbsolute(piSource) || !/^[a-f0-9]{40}$/.test(piRevision!)) throw new Error("invalid trusted pi-tasks source selection");
  expect(execFileSync("git", ["-C", piSource, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(piRevision!);
  expect(execFileSync("git", ["-C", piSource, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()).toBe("");
  const { createTaskStore, createVolatileTaskSession } = await import(pathToFileURL(join(piSource, "src/index.ts")).href);
  const af = join(root, "a.sqlite"), bf = join(root, "b.sqlite");
  const aStore = createTaskStore({ path: af }); let bStore = createTaskStore({ path: bf });
  const authenticatedFetch = ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, headers: { ...init?.headers, authorization: headers.authorization } })) as typeof fetch;
  const open = (callerSession: string, store: any) => createVolatileTaskSession({ callerSession, store, url: base + path, fetch: authenticatedFetch });
  const a = open("sender", aStore); let b = open("receiver", bStore);
  try {
    const ac = await a.connect(); let bc = await b.connect();
    const task = await ac.createTask({ target: bc.endpoint, task: "real HTTP adapter fixture", timeoutMs: 60_000 });
    const deliveries = await bc.receive(); expect(deliveries.map((item: any) => item.cursor)).toEqual(["1"]);
    await bc.acknowledgeRelayDelivery("1"); b.close(); bStore.close();
    bStore = createTaskStore({ path: bf }); b = open("receiver", bStore); bc = await b.connect();
    expect(await bc.receive()).toEqual([]);
    expect(bStore.getReceiveCursor()).toBe("1");
    await __resetTaskRelayGatewayForTests(); gateway = getTaskRelayGateway() as typeof gateway; await gateway.initialize();
    await expect(bc.receive()).rejects.toMatchObject({ code: "RELAY_RESET", retryable: false });
    expect(b.status().state).toBe("reset");
    b.close(); bStore.close(); bStore = createTaskStore({ path: bf }); b = open("receiver", bStore);
    await expect(b.connect()).rejects.toMatchObject({ code: "RELAY_REBIND_REQUIRED", retryable: false });
    const fresh = await b.rebind(); expect(fresh.endpoint).not.toEqual(bc.endpoint); expect(bStore.getReceiveCursor()).toBe("0");
    expect(bStore.getTask(task.taskId)).toBeDefined();
    await fresh.createTask({ target: fresh.endpoint, task: "new epoch", timeoutMs: 60_000 });
    expect((await fresh.receive()).map((item: any) => item.cursor)).toEqual(["1"]);
    await __resetTaskRelayGatewayForTests(); process.env.WOLFPACK_TASK_RELAY_PROFILE = "durable-v2";
    await expect(fresh.receive()).rejects.toMatchObject({ code: "RELAY_RESET", retryable: false });
    expect(b.status().state).toBe("reset");
    b.close(); bStore.close(); bStore = createTaskStore({ path: bf }); b = open("receiver", bStore);
    await expect(b.connect()).rejects.toMatchObject({ code: "RELAY_REBIND_REQUIRED", retryable: false });
  } finally { a.close(); b.close(); aStore.close(); bStore.close(); }
}, 15_000);
