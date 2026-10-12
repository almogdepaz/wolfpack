/**
 * GET /api/events — the SSE wire contract, filters, stream cap, subscriber
 * cleanup, and the observer-sourced session.state events. Drives the real
 * HTTP server against MockBackend.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.WOLFPACK_TEST = "1";
delete process.env.WOLFPACK_JWT_SECRET;

const PRIOR_ENV = {
  WOLFPACK_DEV_DIR: process.env.WOLFPACK_DEV_DIR,
  WOLFPACK_SESSION_IDENTITY_PATH: process.env.WOLFPACK_SESSION_IDENTITY_PATH,
  WOLFPACK_AGENT_RUNTIME_STATE_PATH: process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH,
} as const;
const TEST_DIR = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-events-sse-")));
process.env.WOLFPACK_DEV_DIR = TEST_DIR;
process.env.WOLFPACK_SESSION_IDENTITY_PATH = join(TEST_DIR, "session-identities.json");
process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH = join(TEST_DIR, "agent-runtime-state.json");

const { __resetJwtAuthConfig } = await import("../../src/test-hooks.ts");
const { __setTestBackend } = await import("../../src/server/backend.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
__resetJwtAuthConfig();
const mockBackend = new MockBackend({ sessions: [] });
__setTestBackend(mockBackend);

const { createServerInstance, __globalRateLimiter } = await import("../../src/server/index.ts") as any;
const { __resetEventBusForTests, eventSubscriberCount, publishEvent } = await import("../../src/server/event-bus.ts");
const { EVENTS_MAX_STREAMS } = await import("../../src/server/event-routes.ts");
const { shouldAuthenticateApiPath } = await import("../../src/server/http.ts");
const { parseSseEvents, WOLFPACK_EVENT_KIND } = await import("../../src/events-contract.ts");
const { __resetAgentRuntimeStateStoreForTests } = await import("../../src/server/agent-status.ts");
const {
  __resetSessionObservationForTests,
  __runSessionNotificationObservationForTests,
  observeDashboardSessions,
} = await import("../../src/server/session-observation.ts");
const { notifyProgramStatusChanged } = await import("../../src/server/program-status-signal.ts");
type WolfpackEvent = import("../../src/events-contract.ts").WolfpackEvent;

const { server } = createServerInstance();
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    (server as Server).listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${((server as Server).address() as AddressInfo).port}`;
      resolve();
    });
  });
});

beforeEach(() => {
  __globalRateLimiter._map.clear();
  __resetEventBusForTests();
  __resetAgentRuntimeStateStoreForTests();
  __resetSessionObservationForTests();
  mockBackend.setSessions([]);
});

afterAll(() => {
  (server as Server).close();
  __resetAgentRuntimeStateStoreForTests();
  rmSync(TEST_DIR, { recursive: true, force: true });
  for (const [key, value] of Object.entries(PRIOR_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface OpenStream {
  readonly response: Response;
  next(count: number): Promise<WolfpackEvent[]>;
  close(): void;
}

async function openStream(query = ""): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events${query}`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const buffered: WolfpackEvent[] = [];
  let pending = "";
  return {
    response,
    async next(count) {
      const deadline = Date.now() + 2_000;
      while (buffered.length < count) {
        const remaining = deadline - Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out waiting for ${count} events, got ${buffered.length}`)), Math.max(0, remaining));
        });
        const { done, value } = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
        if (done) throw new Error("stream ended");
        const parsed = parseSseEvents(pending + decoder.decode(value, { stream: true }));
        pending = parsed.rest;
        buffered.push(...parsed.events);
      }
      return buffered.splice(0, count);
    },
    close: () => controller.abort(),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

describe("GET /api/events", () => {
  test("is behind the API auth gate", () => {
    expect(shouldAuthenticateApiPath("/api/events")).toBe(true);
  });

  test("streams published events as SSE with ids", async () => {
    const stream = await openStream();
    try {
      expect(stream.response.status).toBe(200);
      expect(stream.response.headers.get("content-type")).toBe("text/event-stream");
      expect(stream.response.headers.get("cache-control")).toBe("no-cache");
      await waitFor(() => eventSubscriberCount() === 1);
      publishEvent({ kind: WOLFPACK_EVENT_KIND.SESSION_CREATED, sessionId: SESSION_ID, session: "wolf-1", cwd: "/tmp" });
      publishEvent({ kind: WOLFPACK_EVENT_KIND.SESSION_EXITED, sessionId: SESSION_ID, session: "wolf-1", reason: "killed", signal: 1 });
      const events = await stream.next(2);
      expect(events.map((event) => [event.id, event.kind])).toEqual([[1, "session.created"], [2, "session.exited"]]);
    } finally {
      stream.close();
    }
  });

  test("applies kinds and session filters", async () => {
    const stream = await openStream("?kinds=session.exited&session=wolf-2");
    try {
      await waitFor(() => eventSubscriberCount() === 1);
      publishEvent({ kind: WOLFPACK_EVENT_KIND.SESSION_CREATED, sessionId: SESSION_ID, session: "wolf-2", cwd: "/tmp" });
      publishEvent({ kind: WOLFPACK_EVENT_KIND.SESSION_EXITED, sessionId: SESSION_ID, session: "wolf-1", reason: "exit" });
      publishEvent({ kind: WOLFPACK_EVENT_KIND.SESSION_EXITED, sessionId: SESSION_ID, session: "wolf-2", reason: "exit", exitCode: 0 });
      const [event] = await stream.next(1);
      expect(event).toMatchObject({ id: 3, kind: "session.exited", session: "wolf-2" });
    } finally {
      stream.close();
    }
  });

  test("rejects an invalid filter with 400 before streaming", async () => {
    const response = await fetch(`${base}/api/events?kinds=session.bogus`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "unknown event kind: session.bogus" });
    expect(eventSubscriberCount()).toBe(0);
  });

  test("a client disconnect releases its subscription", async () => {
    const stream = await openStream();
    await waitFor(() => eventSubscriberCount() === 1);
    stream.close();
    await waitFor(() => eventSubscriberCount() === 0);
  });

  test("caps concurrent streams with 429", async () => {
    const streams: OpenStream[] = [];
    try {
      for (let index = 0; index < EVENTS_MAX_STREAMS; index++) streams.push(await openStream());
      await waitFor(() => eventSubscriberCount() === EVENTS_MAX_STREAMS);
      const rejected = await fetch(`${base}/api/events`);
      expect(rejected.status).toBe(429);
    } finally {
      for (const stream of streams) stream.close();
    }
    await waitFor(() => eventSubscriberCount() === 0);
    const reopened = await openStream();
    expect(reopened.response.status).toBe(200);
    reopened.close();
  });
});

describe("session.state events", () => {
  test("the observer runs for event subscribers and publishes runtime transitions after a baseline", async () => {
    mockBackend.setSessions(["agent-1"]);
    mockBackend.setCapturePane(async () => "first screen\n");
    mockBackend.setOutputSequence("agent-1", "1");

    // No push subscriptions and no event subscribers: the observer is idle.
    expect(await __runSessionNotificationObservationForTests()).toEqual([]);

    const stream = await openStream("?kinds=session.state");
    try {
      await waitFor(() => eventSubscriberCount() === 1);
      const baseline = await __runSessionNotificationObservationForTests();
      expect(baseline).toHaveLength(1);

      mockBackend.setCapturePane(async () => "second screen\n");
      mockBackend.setOutputSequence("agent-1", "2");
      const observed = await __runSessionNotificationObservationForTests();
      const runtimeState = observed[0]!.runtimeState;

      const [event] = await stream.next(1);
      expect(event).toMatchObject({
        kind: "session.state",
        session: "agent-1",
        state: runtimeState.state,
        label: runtimeState.label,
        transitionSequence: runtimeState.transitionSequence,
      });
      // Only program status (OSC 7501) reports put a message on the event;
      // other authorities' messages are diagnostics, not program text.
      expect(runtimeState.message).toBeDefined();
      expect(event).not.toHaveProperty("message");

      // Output stopping is itself a transition (back to idle). After that, an
      // unchanged screen must not republish: the stream is transitions, not a heartbeat.
      await __runSessionNotificationObservationForTests();
      await __runSessionNotificationObservationForTests();
      publishEvent({ kind: WOLFPACK_EVENT_KIND.SESSION_STATE, session: "sentinel", state: "idle", label: "sentinel", transitionSequence: 0 });
      const [settled, sentinel] = await stream.next(2);
      expect(settled).toMatchObject({ session: "agent-1", state: "idle", transitionSequence: runtimeState.transitionSequence + 1 });
      expect(sentinel).toMatchObject({ session: "sentinel" });
    } finally {
      stream.close();
    }
  });

  test("staggered dashboard and notification observers do not republish consumed output", async () => {
    mockBackend.setSessions(["agent-2"]);
    mockBackend.setCapturePane(async () => "screen a\n");
    mockBackend.setOutputSequence("agent-2", "1");

    const stream = await openStream("?kinds=session.state");
    try {
      await waitFor(() => eventSubscriberCount() === 1);
      // Both observers baseline screen a.
      await observeDashboardSessions();
      await __runSessionNotificationObservationForTests();

      // One output change, consumed by two dashboard polls: output, then idle.
      mockBackend.setCapturePane(async () => "screen b\n");
      mockBackend.setOutputSequence("agent-2", "2");
      await observeDashboardSessions();
      await observeDashboardSessions();
      const [output, idle] = await stream.next(2);
      expect(output).toMatchObject({ session: "agent-2", state: "output" });
      expect(idle).toMatchObject({ session: "agent-2", state: "idle" });

      // The lagging notification observer sees the same screen b: no new output.
      await __runSessionNotificationObservationForTests();
      publishEvent({ kind: WOLFPACK_EVENT_KIND.SESSION_STATE, session: "sentinel", state: "idle", label: "sentinel", transitionSequence: 0 });
      const [next] = await stream.next(1);
      expect(next).toMatchObject({ session: "sentinel" });
    } finally {
      stream.close();
    }
  });

  test("an OSC 7501 blocked report publishes needs-input with its typed kind and message", async () => {
    mockBackend.setSessions(["agent-4"]);
    mockBackend.setCapturePane(async () => "steady\n");
    mockBackend.setOutputSequence("agent-4", "1");

    const stream = await openStream("?kinds=session.state");
    try {
      await waitFor(() => eventSubscriberCount() === 1);
      await __runSessionNotificationObservationForTests();

      mockBackend.setProgramStatus("agent-4", {
        id: "",
        state: "blocked",
        kind: "question",
        message: "Which branch?",
        updatedAtMs: 1,
      });
      await __runSessionNotificationObservationForTests();
      const [blocked] = await stream.next(1);
      expect(blocked).toMatchObject({
        session: "agent-4",
        state: "needs-input",
        inputKind: "question",
        message: "Which branch?",
      });

      // A different request in the same state is published too.
      mockBackend.setProgramStatus("agent-4", {
        id: "",
        state: "blocked",
        kind: "permission",
        message: "Allow push?",
        updatedAtMs: 2,
      });
      await __runSessionNotificationObservationForTests();
      const [permission] = await stream.next(1);
      expect(permission).toMatchObject({
        session: "agent-4",
        state: "needs-input",
        inputKind: "permission",
        message: "Allow push?",
        transitionSequence: blocked!.kind === "session.state" ? blocked.transitionSequence + 1 : -1,
      });
    } finally {
      mockBackend.setProgramStatus("agent-4", undefined);
      stream.close();
    }
  });

  test("a broker program status change is published without waiting for the poll interval", async () => {
    mockBackend.setSessions(["agent-5"]);
    mockBackend.setCapturePane(async () => "steady\n");
    mockBackend.setOutputSequence("agent-5", "1");

    const stream = await openStream("?kinds=session.state");
    try {
      await waitFor(() => eventSubscriberCount() === 1);
      await __runSessionNotificationObservationForTests();

      mockBackend.setProgramStatus("agent-5", { id: "", state: "working", updatedAtMs: 1 });
      // Only the broker signal; no manual observation pass. stream.next waits
      // at most 2s, well under the 5s notification poll.
      const started = Date.now();
      notifyProgramStatusChanged("agent-5-id");
      notifyProgramStatusChanged("agent-5-id");
      const [working] = await stream.next(1);
      expect(working).toMatchObject({ session: "agent-5", state: "working" });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      mockBackend.setProgramStatus("agent-5", undefined);
      stream.close();
    }
  });

  test("broker-unavailable and recovery transitions are both published", async () => {
    mockBackend.setSessions(["agent-3"]);
    mockBackend.setCapturePane(async () => "steady\n");
    mockBackend.setOutputSequence("agent-3", "1");

    const stream = await openStream("?kinds=session.state");
    const listSessionFacts = mockBackend.listSessionFacts.bind(mockBackend);
    try {
      await waitFor(() => eventSubscriberCount() === 1);
      const [baseline] = await __runSessionNotificationObservationForTests();
      const baselineSequence = baseline!.runtimeState.transitionSequence;

      mockBackend.listSessionFacts = async () => { throw new Error("broker down"); };
      const [unavailable] = await __runSessionNotificationObservationForTests();
      expect(unavailable!.runtimeState.state).toBe("unknown");
      const [outage] = await stream.next(1);
      expect(outage).toMatchObject({ session: "agent-3", state: "unknown", transitionSequence: baselineSequence + 1 });

      mockBackend.listSessionFacts = listSessionFacts;
      const [recovered] = await __runSessionNotificationObservationForTests();
      const [recovery] = await stream.next(1);
      expect(recovery).toMatchObject({
        session: "agent-3",
        state: recovered!.runtimeState.state,
        transitionSequence: recovered!.runtimeState.transitionSequence,
      });
    } finally {
      mockBackend.listSessionFacts = listSessionFacts;
      stream.close();
    }
  });
});
