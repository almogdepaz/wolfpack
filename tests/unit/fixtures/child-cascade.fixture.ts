import { afterEach, beforeEach, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { assertNotificationFixtureHome } from "./run-notification-test.ts";
assertNotificationFixtureHome();
const { MockBackend } = await import("../../../src/server/mock-backend.ts");
const { BrokerBackend } = await import("../../../src/server/broker-backend.ts");
const { EventBus } = await import("../../../src/event-bus.ts");
const { createServerContext } = await import("../../../src/server/context.ts");
const { createRoutes } = await import("../../../src/server/routes.ts");
const { createSessionControlRoutes } = await import("../../../src/server/session-control-routes.ts");
const { __setTestBackend, getBackend } = await import("../../../src/server/backend.ts");
const { __resetChildEventsForTests } = await import("../../../src/server/child-events.ts");
const { __resetSessionDeathForTests } = await import("../../../src/server/session-death.ts");
const { __resetSessionCascadeForTests, startChildCleanupCascade } = await import("../../../src/server/session-cascade.ts");
const { CHILD_CLEANUP, CASCADE_OUTCOME } = await import("../../../src/session-cascade-contract.ts");
const { identityEnvVars, extractParentSessionFromEnv } = await import("../../../src/server/session-identity.ts");

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;
type Backend = InstanceType<typeof MockBackend>;

/** In-process request: the sandbox that runs these checks cannot bind ports. */
async function call(handler: Handler, body: unknown, url = "/", method = "POST"): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {}, method, url }) as unknown as IncomingMessage;
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

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50));
const loadSettings = () => ({ agentCmd: "claude" });
const peerCalls: string[] = [];
const realFetch = globalThis.fetch;
const previousBackend = getBackend();
let stopCascade: (() => void) | undefined;

beforeEach(() => {
  __resetChildEventsForTests();
  __resetSessionDeathForTests();
  __resetSessionCascadeForTests();
  peerCalls.length = 0;
  // The cascade is same-machine only: any network call is a failure.
  globalThis.fetch = (async (input: unknown) => {
    peerCalls.push(String(input));
    throw new Error("unexpected network call");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  stopCascade?.();
  stopCascade = undefined;
  globalThis.fetch = realFetch;
  __setTestBackend(previousBackend);
});

async function spawnChild(backend: Backend, name: string, parent: string, cleanup?: string) {
  const parentSession = { wolfpackSessionId: `mock:${parent}`, wolfpackSessionName: parent, ...(cleanup !== undefined && { cleanup }) };
  return backend.createSession(name, "/tmp", "claude", loadSettings, { parentSession } as never);
}

test("the cleanup policy rides the child env and survives an identity restore", () => {
  const parentSession = { wolfpackSessionId: "p-id", wolfpackSessionName: "lead", cleanup: CHILD_CLEANUP.OUTLIVE } as const;
  const env = identityEnvVars({ wolfpackSessionName: "kid", projectPath: "/tmp", agentKind: "claude", parentSession });
  expect(extractParentSessionFromEnv(env)).toEqual(parentSession);
  // A pre-upgrade child has no policy and never cascades.
  expect(extractParentSessionFromEnv([["WOLFPACK_PARENT_SESSION_ID", "p-id"], ["WOLFPACK_PARENT_SESSION_NAME", "lead"]]))
    .toEqual({ wolfpackSessionId: "p-id", wolfpackSessionName: "lead" });
  // An unknown policy value is no policy, not a failure.
  expect(extractParentSessionFromEnv([["WOLFPACK_PARENT_SESSION_ID", "p-id"], ["WOLFPACK_PARENT_SESSION_NAME", "lead"], ["WOLFPACK_PARENT_CLEANUP", "later"]]))
    .toEqual({ wolfpackSessionId: "p-id", wolfpackSessionName: "lead" });
});

test("killing a parent kills its cascade children recursively and keeps outlive and pre-upgrade children", async () => {
  const backend = new MockBackend();
  const kill = createRoutes(createServerContext({ backend, events: new EventBus() }))["POST /api/kill"] as Handler;
  await backend.createSession("lead", "/tmp", "claude", loadSettings);
  await spawnChild(backend, "kid", "lead", CHILD_CLEANUP.CASCADE);
  await spawnChild(backend, "grandkid", "kid", CHILD_CLEANUP.CASCADE);
  await spawnChild(backend, "keeper", "lead", CHILD_CLEANUP.OUTLIVE);
  await spawnChild(backend, "keeper-kid", "keeper", CHILD_CLEANUP.CASCADE);
  await spawnChild(backend, "legacy", "lead");
  await spawnChild(backend, "gone", "lead", CHILD_CLEANUP.CASCADE);
  backend.setSessionAlive("gone", false);
  await backend.createSession("stranger", "/tmp", "claude", loadSettings);

  const response = await call(kill, { session: "lead" });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ ok: true, session: "lead", sessionId: "mock:lead" });
  const cascaded = response.body.cascaded as Array<Record<string, unknown>>;
  expect([...cascaded].sort((a, b) => String(a.session).localeCompare(String(b.session)))).toEqual([
    { sessionId: "mock:gone", session: "gone", outcome: CASCADE_OUTCOME.ALREADY_GONE },
    { sessionId: "mock:grandkid", session: "grandkid", outcome: CASCADE_OUTCOME.KILLED },
    { sessionId: "mock:kid", session: "kid", outcome: CASCADE_OUTCOME.KILLED },
  ]);
  expect((await backend.list()).sort()).toEqual(["gone", "keeper", "keeper-kid", "legacy", "stranger"]);
  expect(peerCalls).toEqual([]);
});

test("a child kill that fails is reported with its reason and its children are kept", async () => {
  class StuckBackend extends MockBackend {
    override async killSessionById(sessionId: string): Promise<void> {
      if (sessionId === "mock:stuck") throw new Error("broker refused");
      await super.killSessionById(sessionId);
    }
  }
  const backend = new StuckBackend();
  const kill = createRoutes(createServerContext({ backend, events: new EventBus() }))["POST /api/kill"] as Handler;
  await backend.createSession("lead", "/tmp", "claude", loadSettings);
  await spawnChild(backend, "stuck", "lead", CHILD_CLEANUP.CASCADE);
  await spawnChild(backend, "stuck-kid", "stuck", CHILD_CLEANUP.CASCADE);

  const response = await call(kill, { session: "lead" });
  expect(response.status).toBe(200);
  expect(response.body.cascaded).toEqual([
    { sessionId: "mock:stuck", session: "stuck", outcome: CASCADE_OUTCOME.FAILED, reason: "broker refused" },
  ]);
  expect((await backend.list()).sort()).toEqual(["stuck", "stuck-kid"]);
});

test("children lists each child's cleanup policy", async () => {
  const backend = new MockBackend();
  __setTestBackend(backend);
  const children = createSessionControlRoutes(createServerContext({ backend, events: new EventBus() }))["GET /api/session-control/children"] as Handler;
  await backend.createSession("lead", "/tmp", "claude", loadSettings);
  await spawnChild(backend, "kid", "lead", CHILD_CLEANUP.CASCADE);
  await spawnChild(backend, "keeper", "lead", CHILD_CLEANUP.OUTLIVE);
  await spawnChild(backend, "legacy", "lead");
  const response = await call(children, {}, "/api/session-control/children?session=lead", "GET");
  expect(response.status).toBe(200);
  expect((response.body.children as Array<Record<string, unknown>>).map(child => [child.session, child.cleanup])).toEqual([
    ["keeper", CHILD_CLEANUP.OUTLIVE],
    ["kid", CHILD_CLEANUP.CASCADE],
    ["legacy", CHILD_CLEANUP.NONE],
  ]);
});

const LEAD = "11111111-1111-4111-8111-111111111111";
const KID = "22222222-2222-4222-8222-222222222222";
const GRANDKID = "33333333-3333-4333-8333-333333333333";
const KEEPER = "44444444-4444-4444-8444-444444444444";
const LEGACY = "55555555-5555-4555-8555-555555555555";

interface FakeSession { id: string; name: string; alive: boolean; env: Array<[string, string]> }

function lineage(parentId: string, parentName: string, cleanup?: string): Array<[string, string]> {
  return [
    ["WOLFPACK_PARENT_SESSION_ID", parentId],
    ["WOLFPACK_PARENT_SESSION_NAME", parentName],
    ...(cleanup !== undefined ? [["WOLFPACK_PARENT_CLEANUP", cleanup] as [string, string]] : []),
  ];
}

/** A broker backend on a fake client: a session table plus kill requests. */
function brokerFixture(options: { onKill?: (id: string, backend: InstanceType<typeof BrokerBackend>) => void } = {}) {
  const sessions = new Map<string, FakeSession>();
  const add = (id: string, name: string, env: Array<[string, string]> = [], alive = true) => sessions.set(id, { id, name, alive, env });
  add(LEAD, "lead");
  add(KID, "kid", lineage(LEAD, "lead", CHILD_CLEANUP.CASCADE));
  add(GRANDKID, "grandkid", lineage(KID, "kid", CHILD_CLEANUP.CASCADE));
  add(KEEPER, "keeper", lineage(LEAD, "lead", CHILD_CLEANUP.OUTLIVE));
  add(LEGACY, "legacy", lineage(LEAD, "lead"));
  const kills: string[] = [];
  const state = { listFails: false };
  let backend: InstanceType<typeof BrokerBackend>;
  const client = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "list_sessions") {
        if (state.listFails) throw new Error("broker unavailable");
        return {
          status: "ok",
          payload: {
            sessions: [...sessions.values()].map(s => ({
              id: s.id, name: s.name, cwd: "/tmp", alive: s.alive, cols: 120, rows: 40, pid: 1234,
              started_at_ms: Date.now() - 1000, exit_code: null, command: ["claude"], env: s.env,
            })),
          },
        };
      }
      if (method === "kill_session") {
        const id = String(params.session_id);
        kills.push(id);
        const session = sessions.get(id);
        if (!session?.alive) return { status: "error", error: { code: "session_not_alive", message: "gone" } };
        session.alive = false;
        options.onKill?.(id, backend);
        return { status: "ok", payload: {} };
      }
      throw new Error(`unexpected broker request ${method}`);
    },
  };
  backend = new BrokerBackend(client as never, () => {});
  __setTestBackend(backend);
  stopCascade = startChildCleanupCascade(() => backend);
  return { backend, sessions, kills, state };
}

test("a parent's lifecycle exit cascades to its cascade children and grandchildren", async () => {
  const { backend, sessions, kills } = brokerFixture();
  await backend.listSessionFacts();
  sessions.get(LEAD)!.alive = false;
  backend.ingestEvent({ event: "session_exited", session_id: LEAD, exit_code: 0 });
  await waitFor(() => kills.length >= 2);
  await settle();
  expect(kills.sort()).toEqual([KID, GRANDKID].sort());
  expect(sessions.get(KEEPER)!.alive).toBe(true);
  expect(sessions.get(LEGACY)!.alive).toBe(true);
  expect(peerCalls).toEqual([]);
});

test("a parent listed gone in a later session table cascades", async () => {
  const { backend, sessions, kills } = brokerFixture();
  await backend.listSessionFacts();
  sessions.delete(LEAD);
  await backend.listSessionFacts();
  await waitFor(() => kills.length >= 2);
  await settle();
  expect(kills.sort()).toEqual([KID, GRANDKID].sort());
});

test("an unavailable session table is not death evidence", async () => {
  const { backend, state, kills } = brokerFixture();
  await backend.listSessionFacts();
  state.listFails = true;
  await expect(backend.listSessionFacts()).rejects.toThrow("broker unavailable");
  state.listFails = false;
  await backend.listSessionFacts();
  await settle();
  expect(kills).toEqual([]);
});

test("a parent already dead in the first table after a restart does not cascade", async () => {
  const { backend, sessions, kills } = brokerFixture();
  sessions.get(LEAD)!.alive = false;
  await backend.listSessionFacts();
  await backend.listSessionFacts();
  // A late exit frame for a session this boot never saw alive is no evidence either.
  backend.ingestEvent({ event: "session_exited", session_id: LEAD, exit_code: 0 });
  await settle();
  expect(kills).toEqual([]);
});

test("an explicit kill whose exit frame arrives during the kill cascades once", async () => {
  const { backend, kills } = brokerFixture({
    onKill: (id, broker) => broker.ingestEvent({ event: "session_exited", session_id: id, signal: 1 }),
  });
  await backend.listSessionFacts();
  const kill = createRoutes(createServerContext({ backend, events: new EventBus() }))["POST /api/kill"] as Handler;
  const response = await call(kill, { session: "lead" });
  expect(response.status).toBe(200);
  await settle();
  const cascaded = response.body.cascaded as Array<Record<string, unknown>>;
  expect(cascaded.map(entry => [entry.session, entry.outcome]).sort()).toEqual([
    ["grandkid", CASCADE_OUTCOME.KILLED],
    ["kid", CASCADE_OUTCOME.KILLED],
  ]);
  expect(kills.sort()).toEqual([LEAD, KID, GRANDKID].sort());
  expect(peerCalls).toEqual([]);
});
