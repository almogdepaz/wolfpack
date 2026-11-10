import { beforeEach, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { assertNotificationFixtureHome } from "./run-notification-test.ts";
assertNotificationFixtureHome();
const { MockBackend } = await import("../../../src/server/mock-backend.ts");
const { EventBus } = await import("../../../src/event-bus.ts");
const { createServerContext } = await import("../../../src/server/context.ts");
const { createSessionControlRoutes } = await import("../../../src/server/session-control-routes.ts");
const { __resetChildEventsForTests, childMessageEvent, observeChildSession } = await import("../../../src/server/child-events.ts");
const { clearParentInbox, PARENT_INBOX_BOOT_ID } = await import("../../../src/server/parent-inbox.ts");

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** In-process GET: the sandbox that runs these checks cannot bind ports. */
function get(handler: Handler, url: string): { reply: Promise<Reply>; close: () => void } {
  const req = Object.assign(new EventEmitter(), { headers: {}, method: "GET", url }) as unknown as IncomingMessage;
  const emitter = new EventEmitter();
  const headers: Record<string, string> = {};
  let status = 200;
  const reply = new Promise<Reply>(resolve => {
    const res = Object.assign(emitter, {
      writeHead(code: number) { status = code; return res; },
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return res; },
      end(chunk?: string) { resolve({ status, headers, body: JSON.parse(chunk ?? "{}") as Record<string, unknown> }); return res; },
    });
    void handler(req, res as unknown as ServerResponse);
  });
  return { reply, close: () => emitter.emit("close") };
}

const backend = new MockBackend();
const ctx = createServerContext({ backend, events: new EventBus() });
const routes = createSessionControlRoutes(ctx);
const children = routes["GET /api/session-control/children"] as Handler;
const wait = routes["GET /api/session-control/children/wait"] as Handler;
const loadSettings = () => ({ agentCmd: "claude" });
const parent = await backend.createSession("lead", "/tmp", "claude", loadSettings);
const parentSession = { wolfpackSessionId: parent.wolfpackSessionId, wolfpackSessionName: "lead" };
const worker = await backend.createSession("worker", "/tmp", "claude", loadSettings, { parentSession });
const gone = await backend.createSession("gone", "/tmp", "claude", loadSettings, { parentSession });
await backend.createSession("stranger", "/tmp", "claude", loadSettings);
backend.setSessionAlive("gone", false);

const publish = () => {};
function observe(state: "working" | "idle") {
  observeChildSession({
    sessionId: worker.wolfpackSessionId,
    name: "worker",
    parentSession,
    alive: true,
    runtimeState: { state, authority: "fallback", freshness: "fresh", source: "screen-fallback", label: state, stale: false, observedAt: "t", changedAt: "t", transitionSequence: 1, unseen: false },
  }, publish);
}

beforeEach(() => {
  __resetChildEventsForTests();
  clearParentInbox(parent.wolfpackSessionId);
});

test("children lists only the parent's live children with settled state and the last event", async () => {
  observe("working");
  observe("idle");
  childMessageEvent(parent.wolfpackSessionId, "worker", "phase 1 done", publish);
  const { reply } = get(children, "/api/session-control/children?session=lead");
  const response = await reply;
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.body).toMatchObject({ ok: true, session: "lead", sessionId: parent.wolfpackSessionId, bootId: PARENT_INBOX_BOOT_ID });
  const list = response.body.children as Record<string, unknown>[];
  expect(list.map(child => child.session)).toEqual(["worker"]);
  expect(list[0]).toMatchObject({ sessionId: worker.wolfpackSessionId, settled: true, lastEvent: { event: "message", message: "phase 1 done" } });
  expect(typeof list[0]!.state).toBe("string");
});

test("children and wait reject a missing selector and an unknown session", async () => {
  expect((await get(children, "/api/session-control/children").reply).status).toBe(400);
  expect((await get(children, "/api/session-control/children?session=nobody").reply).status).toBe(404);
  expect((await get(wait, "/api/session-control/children/wait?children=any").reply).status).toBe(400);
  expect((await get(wait, "/api/session-control/children/wait?session=nobody&children=any&timeoutMs=50").reply).status).toBe(404);
});

test("wait rejects an invalid query with an INVALID_REQUEST envelope", async () => {
  for (const query of ["children=some", "children=any&timeoutMs=0", "children=any&timeoutMs=600001", "children=any&since=-1", "children=any&since=1.5", `children=any&bootId=${"x".repeat(101)}`]) {
    const response = await get(wait, `/api/session-control/children/wait?session=lead&${query}`).reply;
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_REQUEST");
  }
});

test("wait any returns a child event after since and a timeout is a 200 check-in", async () => {
  observe("working");
  const pending = get(wait, "/api/session-control/children/wait?session=lead&children=any&timeoutMs=5000");
  await new Promise(resolve => setTimeout(resolve, 10));
  childMessageEvent(parent.wolfpackSessionId, "worker", "ready", publish);
  const events = await pending.reply;
  expect(events.status).toBe(200);
  expect(events.body).toMatchObject({ ok: true, children: "any", outcome: "events", bootId: PARENT_INBOX_BOOT_ID, since: 0, cursor: 1 });
  const cursor = events.body.cursor as number;
  const timeout = await get(wait, `/api/session-control/children/wait?session=lead&children=any&timeoutMs=30&since=${cursor}&bootId=${PARENT_INBOX_BOOT_ID}`).reply;
  expect(timeout.status).toBe(200);
  expect(timeout.body).toMatchObject({ outcome: "timeout", events: [], since: cursor, cursor });
});

test("wait all reports the pending child on timeout and settled once it is idle", async () => {
  observe("working");
  const timeout = await get(wait, "/api/session-control/children/wait?session=lead&children=all&timeoutMs=30").reply;
  expect(timeout.body).toMatchObject({ outcome: "timeout", pending: [{ session: "worker", sessionId: worker.wolfpackSessionId }] });
  observe("idle");
  const settled = await get(wait, "/api/session-control/children/wait?session=lead&children=all&timeoutMs=5000").reply;
  expect(settled.body).toMatchObject({ outcome: "settled" });
  expect(settled.body.pending).toBeUndefined();
});

test("a client that goes away ends the wait without a reply", async () => {
  observe("working");
  const pending = get(wait, "/api/session-control/children/wait?session=lead&children=any&timeoutMs=100");
  await new Promise(resolve => setTimeout(resolve, 10));
  pending.close();
  const raced = await Promise.race([pending.reply.then(() => "replied"), new Promise(resolve => setTimeout(() => resolve("silent"), 250))]);
  expect(raced).toBe("silent");
});
