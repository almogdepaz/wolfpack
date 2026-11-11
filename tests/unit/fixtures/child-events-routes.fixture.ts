import { afterEach, beforeEach, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { assertNotificationFixtureHome } from "./run-notification-test.ts";
assertNotificationFixtureHome();
const { MockBackend } = await import("../../../src/server/mock-backend.ts");
const { EventBus } = await import("../../../src/event-bus.ts");
const { createServerContext } = await import("../../../src/server/context.ts");
const { createPushNotifyRoutes } = await import("../../../src/server/push-routes.ts");
const { createSessionControlRoutes } = await import("../../../src/server/session-control-routes.ts");
const { _testing } = await import("../../../src/server/push.ts");
const { clearParentInbox, listParentNotifications, PARENT_INBOX_BOOT_ID } = await import("../../../src/server/parent-inbox.ts");
const { WOLFPACK_EVENT_KIND } = await import("../../../src/events-contract.ts");

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

/** In-process request: the sandbox that runs these checks cannot bind ports. */
async function call(handler: Handler, body: unknown, url = "/"): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {}, method: "POST", url }) as unknown as IncomingMessage;
  let status = 0;
  let text = "";
  const done = new Promise<void>(resolve => {
    const res = {
      writeHead(code: number) { status = code; return res; },
      setHeader() { return res; },
      end(chunk?: string) { text = chunk ?? ""; resolve(); return res; },
    };
    void handler(req, res as unknown as ServerResponse);
  });
  await done;
  return { status, body: JSON.parse(text) as Record<string, unknown> };
}

const backend = new MockBackend();
const events = new EventBus();
const published: unknown[] = [];
events.subscribeEvents({}, event => { published.push(event); });
let ctx = createServerContext({ backend, events });
let notify = createPushNotifyRoutes(ctx)["POST /api/notify"]!;
let routes = createSessionControlRoutes(ctx);
afterEach(async () => { await ctx.close(); });

const loadSettings = () => ({ agentCmd: "claude" });
const parent = await backend.createSession("lead", "/tmp", "claude", loadSettings);
const parentSession = { wolfpackSessionId: parent.wolfpackSessionId, wolfpackSessionName: "lead" };
const child = await backend.createSession("worker", "/tmp", "claude", loadSettings, { parentSession });

function runtime(state: "working" | "idle") {
  return { state, authority: "fallback", freshness: "fresh", source: "screen-fallback", label: state, stale: false, observedAt: "t", changedAt: "t", transitionSequence: 1, unseen: false } as const;
}
function observe(state: "working" | "idle") {
  ctx.childEvents.observeChildSession({ sessionId: child.wolfpackSessionId, name: "worker", parentSession, alive: true, runtimeState: runtime(state) }, body => events.publishEvent(body));
}

beforeEach(async () => {
  await ctx.close();
  ctx = createServerContext({ backend, events: events });
  routes = createSessionControlRoutes(ctx);
  notify = createPushNotifyRoutes(ctx)["POST /api/notify"]!;
  _testing.resetDebounce();
  clearParentInbox(parent.wolfpackSessionId);
  published.length = 0;
});

test("notify-parent from a known child is a structured message event and keeps parent_notified", async () => {
  observe("working");
  const response = await call(notify, { message: "phase 1 done", from: "worker", sessionId: parent.wolfpackSessionId, sessionName: "lead" });
  expect(response.status).toBe(200);
  const inbox = listParentNotifications(parent.wolfpackSessionId);
  expect(inbox).toHaveLength(1);
  expect(response.body.parentInbox).toEqual({ queued: true, seq: inbox[0]!.seq });
  expect(inbox[0]).toMatchObject({ message: "phase 1 done", from: "worker" });
  expect(inbox[0]!.childEvent).toMatchObject({ event: "message", message: "phase 1 done", childSessionId: child.wolfpackSessionId, seq: inbox[0]!.seq });
  expect(published.map(event => (event as { kind: string }).kind)).toEqual([WOLFPACK_EVENT_KIND.CHILD_EVENT, WOLFPACK_EVENT_KIND.PARENT_NOTIFIED]);
  expect(published[1]).toMatchObject({ seq: inbox[0]!.seq, message: "phase 1 done", from: "worker" });

  const inboxResponse = await call(routes["GET /api/session-control/inbox"] as Handler, {}, "/api/session-control/inbox?session=lead");
  expect(inboxResponse.body).toMatchObject({ bootId: PARENT_INBOX_BOOT_ID, sessionId: parent.wolfpackSessionId });
});

test("notify-parent from an unknown sender stays a plain notification", async () => {
  await call(notify, { message: "hello", from: "stranger", sessionId: parent.wolfpackSessionId, sessionName: "lead" });
  const inbox = listParentNotifications(parent.wolfpackSessionId);
  expect(inbox).toEqual([{ seq: 1, at: expect.any(String), message: "hello", from: "stranger" }]);
  expect(published.map(event => (event as { kind: string }).kind)).toEqual([WOLFPACK_EVENT_KIND.PARENT_NOTIFIED]);
});

test("a submitted send arms a heuristic child; noEnter does not", async () => {
  observe("idle");
  expect((await call(routes["POST /api/session-control/send"] as Handler, { session: "worker", text: "draft", noEnter: true })).status).toBe(200);
  observe("working");
  observe("idle");
  expect(listParentNotifications(parent.wolfpackSessionId)).toEqual([]);
  const sent = await call(routes["POST /api/session-control/send"] as Handler, { session: "worker", text: "do it" });
  expect(sent.body.ok).toBe(true);
  observe("working");
  observe("idle");
  expect(listParentNotifications(parent.wolfpackSessionId).map(entry => entry.childEvent?.event)).toEqual(["done"]);
});

test("a send right after spawn, before any observer pass, arms the child", async () => {
  const sent = await call(routes["POST /api/session-control/send"] as Handler, { session: "worker", text: "do it" });
  expect(sent.body.ok).toBe(true);
  observe("working");
  observe("idle");
  expect(listParentNotifications(parent.wolfpackSessionId).map(entry => entry.childEvent?.event)).toEqual(["done"]);
});

test("a heuristic child that finishes while the send observation still waits is done", async () => {
  observe("idle");
  backend.duringSendObservation = () => {
    observe("working");
    observe("idle");
  };
  try {
    const sent = await call(routes["POST /api/session-control/send"] as Handler, { session: "worker", text: "do it" });
    expect(sent.body.ok).toBe(true);
  } finally {
    backend.duringSendObservation = null;
  }
  expect(listParentNotifications(parent.wolfpackSessionId).map(entry => entry.childEvent?.event)).toEqual(["done"]);
});
