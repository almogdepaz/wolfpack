import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import { createECDH } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { assertNotificationFixtureHome } from "./run-notification-test.ts";
import { isJsonObject, validateControlApiSchemaValue } from "../../control-api-schema-validator.ts";
import type { JsonObject } from "../../control-api-schema-validator.ts";
assertNotificationFixtureHome();
const { CONTROL_API_SCHEMA_ARTIFACT } = await import("../../../src/control-api/schema.ts");
const { addSubscription, removeSubscription, _testing } = await import("../../../src/server/push.ts");
const { createPushNotifyRoutes } = await import("../../../src/server/push-routes.ts");
const { EventBus } = await import("../../../src/event-bus.ts");
const { MockBackend } = await import("../../../src/server/mock-backend.ts");
const { listParentNotifications, clearParentInbox } = await import("../../../src/server/parent-inbox.ts");
const backend = new MockBackend({ sessions: ["parent"] });
const events = new EventBus();
const pushNotifyRoutes = createPushNotifyRoutes({ backend, events });
const fetcher = globalThis.fetch;
const artifact = JSON.parse(readFileSync(CONTROL_API_SCHEMA_ARTIFACT, "utf8")) as JsonObject;
function validateResponse(body: unknown): void {
  const http = artifact.http;
  const operation = isJsonObject(http) ? http.sendNotification : undefined;
  if (!isJsonObject(operation)) throw new Error("missing notify schema");
  expect(validateControlApiSchemaValue(operation.response, body, artifact)).toEqual([]);
}
const server = createServer((req, res) => {
  const route = pushNotifyRoutes[`${req.method} ${req.url}`];
  if (!route) { res.writeHead(404); res.end(); return; }
  void Promise.resolve(route(req, res)).catch(error => { res.writeHead(500); res.end(String(error)); });
});
let url: string;
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  url = `http://127.0.0.1:${address.port}/api/notify`;
});
beforeEach(() => { _testing.resetDebounce(); clearParentInbox("mock:parent"); });
afterAll(async () => { globalThis.fetch = fetcher; await new Promise<void>(resolve => server.close(() => resolve())); });
const notify = (target: Record<string, unknown> = {}) => fetcher(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "child ready for review", ...target }),
});
function pushServiceAnswers(status: number): void {
  globalThis.fetch = Object.assign(async () => new Response(null, { status }), { preconnect: fetcher.preconnect });
}
function enroll(endpoint: string): void {
  const client = createECDH("prime256v1"); client.generateKeys();
  addSubscription({ endpoint, keys: { p256dh: client.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 3).toString("base64url") } });
}

test("live exact parent target queues a structured entry and publishes an event", async () => {
  const seen: unknown[] = [];
  const unsubscribe = events.subscribeEvents({ session: "mock:parent" }, event => seen.push(event));
  try {
    const response = await notify({ sessionId: "mock:parent", sessionName: "parent", from: "child" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.parentInbox).toEqual({ queued: true, seq: 1 });
    expect(listParentNotifications("mock:parent")).toEqual([{ seq: 1, at: expect.any(String), message: "child ready for review", from: "child" }]);
    expect(seen).toEqual([expect.objectContaining({ kind: "parent_notified", session: "parent", sessionId: "mock:parent", seq: 1, message: "child ready for review", from: "child" })]);
  } finally { unsubscribe(); }
});

test("coalesced live broker response then exit cannot resurrect the parent inbox", async () => {
  const { BrokerClient } = await import("../../../src/broker/client.ts");
  const { BrokerBackend } = await import("../../../src/server/broker-backend.ts");
  const { FrameParser, encodeFrame, FRAME_KIND_CONTROL_REQUEST, FRAME_KIND_CONTROL_RESPONSE, FRAME_KIND_EVENT } = await import("../../../src/broker/codec.ts");
  const { appendParentNotification } = await import("../../../src/server/parent-inbox.ts");
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const dir = mkdtempSync("/tmp/wpn-inbox-");
  const socketPath = join(dir, "b.sock");
  const broker = createNetServer(socket => {
    const parser = new FrameParser();
    socket.on("data", chunk => {
      parser.push(chunk);
      for (const frame of parser.drain()) {
        if (frame.kind !== FRAME_KIND_CONTROL_REQUEST || frame.value.method !== "list_sessions") throw new Error("unexpected broker request");
        const session = { id, name: "parent", cwd: "/tmp/project", alive: true, cols: 80, rows: 24, pid: 123, started_at_ms: 1, exit_code: null, command: ["pi"], env: [["WOLFPACK_AGENT_KIND", "pi"]] };
        // Dispatch both valid frames before the inspection promise can resume.
        socket.write(Buffer.concat([
          Buffer.from(encodeFrame({ kind: FRAME_KIND_CONTROL_RESPONSE, value: { id: frame.value.id, status: "ok", payload: { kind: "list_sessions", sessions: [session] } } })),
          Buffer.from(encodeFrame({ kind: FRAME_KIND_EVENT, value: { event: "session_exited", session_id: id, exit_code: 0, final_seq: "0" } })),
        ]));
      }
    });
  });
  const raceEvents = new EventBus();
  const seen: string[] = [];
  const unsubscribe = raceEvents.subscribeEvents({}, event => seen.push(event.kind));
  let connected: () => void = () => {};
  const ready = new Promise<void>(resolve => { connected = resolve; });
  const client = new BrokerClient({ socketPath, onConnect: () => connected(), onEvent: event => raceBackend.ingestEvent(event) });
  const raceBackend = new BrokerBackend(client, raceEvents.publishEvent.bind(raceEvents));
  const route = createPushNotifyRoutes({ backend: raceBackend, events: raceEvents })["POST /api/notify"]!;
  const http = createServer((req, res) => {
    void Promise.resolve(route(req, res)).catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  try {
    await new Promise<void>(resolve => broker.listen(socketPath, resolve));
    client.start(); await ready;
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("missing HTTP address");
    appendParentNotification(id, { message: "before exit" });
    const response = await fetcher(`http://127.0.0.1:${address.port}/api/notify`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "late ready", sessionId: id, sessionName: "parent" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).parentInbox).toEqual({ queued: false, reason: "parent_not_found" });
    expect(seen).toEqual(["session.exited"]);
    expect(listParentNotifications(id)).toEqual([]);
    expect(raceEvents.eventSubscriberCount()).toBe(1);
  } finally {
    client.close(); unsubscribe(); clearParentInbox(id);
    await new Promise<void>(resolve => http.close(() => resolve()));
    await new Promise<void>(resolve => broker.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exit fence is exact-id scoped and released on success and inspection failure", async () => {
  const inspect = backend.inspectSession.bind(backend);
  const lookup = spyOn(backend, "inspectSession").mockImplementation(async selector => {
    expect(events.eventSubscriberCount()).toBe(1);
    events.publishEvent({ kind: "session.exited", sessionId: "other-id", session: "mock:parent", reason: "exit" });
    return inspect(selector);
  });
  try {
    expect((await (await notify({ sessionId: "mock:parent", sessionName: "parent" })).json()).parentInbox).toEqual({ queued: true, seq: 1 });
    expect(events.eventSubscriberCount()).toBe(0);
    lookup.mockImplementation(async () => {
      expect(events.eventSubscriberCount()).toBe(1);
      throw new Error("inspection offline");
    });
    expect((await (await notify({ sessionId: "mock:parent", sessionName: "parent" })).json()).parentInbox).toEqual({ queued: false, reason: "parent_not_found" });
    expect(events.eventSubscriberCount()).toBe(0);
  } finally { lookup.mockRestore(); }
});

test("unknown, dead, and mismatched targets never queue", async () => {
  backend.setSessionAlive("parent", false);
  expect((await (await notify({ sessionId: "mock:parent", sessionName: "parent" })).json()).parentInbox).toEqual({ queued: false, reason: "parent_not_found" });
  backend.setSessionAlive("parent", true);
  for (const target of [
    { sessionId: "missing", sessionName: "parent" },
    { sessionId: "mock:parent", sessionName: "wrong" },
    { sessionId: "parent", sessionName: "parent" },
  ]) {
    expect((await (await notify(target)).json()).parentInbox).toEqual({ queued: false, reason: "parent_not_found" });
  }
  expect(listParentNotifications("mock:parent")).toEqual([]);
});

test("sender is optional, unverified, and bounded by code points", async () => {
  expect((await notify({ from: "😀".repeat(100) })).status).toBe(200);
  expect((await notify({ from: "😀".repeat(101) })).status).toBe(400);
  expect((await notify({ from: 7 })).status).toBe(400);
});

test("no enrolled subscription is accepted but reported as not delivered", async () => {
  const response = await notify();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ ok: true, sent: 0, failed: 0, pruned: 0, delivered: false, reason: "no_subscriptions", parentInbox: { queued: false, reason: "no_parent" } });
  validateResponse(body);
});

test("a push service that rejects every endpoint reports delivery_failed", async () => {
  const endpoint = "https://fcm.googleapis.com/notify-rejected";
  enroll(endpoint);
  try {
    pushServiceAnswers(403);
    const response = await notify();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, sent: 0, failed: 1, pruned: 0, delivered: false, reason: "delivery_failed", parentInbox: { queued: false, reason: "no_parent" } });
    validateResponse(body);
  } finally { globalThis.fetch = fetcher; removeSubscription(endpoint); }
});

test("an accepted push is delivered without a reason", async () => {
  const endpoint = "https://fcm.googleapis.com/notify-accepted";
  enroll(endpoint);
  try {
    pushServiceAnswers(201);
    const response = await notify();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, sent: 1, failed: 0, pruned: 0, delivered: true, parentInbox: { queued: false, reason: "no_parent" } });
    validateResponse(body);
  } finally { globalThis.fetch = fetcher; removeSubscription(endpoint); }
});

test("an expired only subscription is pruned and leaves nothing to deliver to", async () => {
  const endpoint = "https://fcm.googleapis.com/notify-expired";
  enroll(endpoint);
  try {
    pushServiceAnswers(410);
    const response = await notify();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, sent: 0, failed: 0, pruned: 1, delivered: false, reason: "no_subscriptions", parentInbox: { queued: false, reason: "no_parent" } });
    validateResponse(body);
  } finally { globalThis.fetch = fetcher; removeSubscription(endpoint); }
});
