import { expect, test } from "bun:test";
import { assertNotificationFixtureHome } from "./run-notification-test.ts";
assertNotificationFixtureHome();
const { MockBackend } = await import("../../../src/server/mock-backend.ts");
const { createServerContext } = await import("../../../src/server/context.ts");
const { getSubscriptionCount } = await import("../../../src/server/push.ts");
const { defaultEventBus } = await import("../../../src/event-bus.ts");
const { BrokerBackend } = await import("../../../src/server/broker-backend.ts");
const { listParentNotifications } = await import("../../../src/server/parent-inbox.ts");
const { PROGRAM_STATUS_STATE } = await import("../../../src/program-status-contract.ts");
const { SESSION_SEND_DELIVERY, SESSION_SEND_OUTCOME } = await import("../../../src/session-send-contract.ts");

test("a child's program done reaches the parent inbox with no push or event subscribers", async () => {
  const backend = new MockBackend();
  const context = createServerContext({ backend, observationCacheTtlMs: 0 });
  try {
    expect(getSubscriptionCount()).toBe(0);
    expect(defaultEventBus.eventSubscriberCount()).toBe(0);
    const loadSettings = () => ({ agentCmd: "claude" });
    const parent = await backend.createSession("lead", "/tmp", "claude", loadSettings);
    // Without a child session the observer stays idle.
    expect(await context.sessionObservation.runSessionNotificationObservation()).toEqual([]);

    const parentSession = { wolfpackSessionId: parent.wolfpackSessionId, wolfpackSessionName: "lead" };
    const child = await backend.createSession("worker", "/tmp", "claude", loadSettings, { parentSession });
    backend.setProgramStatus("worker", { id: "", state: PROGRAM_STATUS_STATE.WORKING, updatedAtMs: Date.now() });
    expect((await context.sessionObservation.runSessionNotificationObservation()).length).toBeGreaterThan(0);
    expect(listParentNotifications(parent.wolfpackSessionId)).toEqual([]);

    backend.setProgramStatus("worker", { id: "", state: PROGRAM_STATUS_STATE.DONE, message: "tests pass", updatedAtMs: Date.now() });
    await context.sessionObservation.runSessionNotificationObservation();
    const inbox = listParentNotifications(parent.wolfpackSessionId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ message: "done: tests pass", from: "worker" });
    expect(inbox[0]!.childEvent).toMatchObject({
      kind: "wolfpack.child_event/v1",
      event: "done",
      state: "done",
      childSessionId: child.wolfpackSessionId,
      childName: "worker",
      parentSessionId: parent.wolfpackSessionId,
      seq: inbox[0]!.seq,
    });

    // The program keeps reporting done: no second event.
    backend.setProgramStatus("worker", { id: "", state: PROGRAM_STATUS_STATE.DONE, message: "tests pass", updatedAtMs: Date.now() + 1 });
    await context.sessionObservation.runSessionNotificationObservation();
    expect(listParentNotifications(parent.wolfpackSessionId)).toHaveLength(1);
  } finally {
    await context.sessionObservation.stopSessionNotificationObserver();
    await context.close();
  }
});

test("a queued typed note keeps the observer running and reaches the parent once it is idle", async () => {
  const backend = new MockBackend();
  const context = createServerContext({ backend, observationCacheTtlMs: 0 });
  const sends: { sessionId: string; sessionName: string; text: string }[] = [];
  const stopDelivery = context.childEventDelivery.startChildEventDelivery({
    hostEnvelope: async () => ({ kind: "unsupported" }),
    send: async (sessionId, sessionName, text) => {
      sends.push({ sessionId, sessionName, text });
      return { delivery: SESSION_SEND_DELIVERY.DELIVERED, outcome: SESSION_SEND_OUTCOME.SUBMITTED, observedMs: 1 };
    },
    typedNotesEnabled: () => true,
    lastViewerInputAt: () => undefined,
    now: Date.now,
  });
  try {
    const loadSettings = () => ({ agentCmd: "claude" });
    const parent = await backend.createSession("lead", "/tmp", "claude", loadSettings);
    backend.setProgramStatus("lead", { id: "", state: PROGRAM_STATUS_STATE.WORKING, updatedAtMs: Date.now() });
    const parentSession = { wolfpackSessionId: parent.wolfpackSessionId, wolfpackSessionName: "lead" };
    await backend.createSession("worker", "/tmp", "claude", loadSettings, { parentSession });
    backend.setProgramStatus("worker", { id: "", state: PROGRAM_STATUS_STATE.WORKING, updatedAtMs: Date.now() });
    await context.sessionObservation.runSessionNotificationObservation();
    backend.setProgramStatus("worker", { id: "", state: PROGRAM_STATUS_STATE.DONE, updatedAtMs: Date.now() });
    await context.sessionObservation.runSessionNotificationObservation();
    await new Promise(resolve => setTimeout(resolve, 0));
    // The parent is working: the note waits.
    expect(sends).toEqual([]);

    // With no live child left, only the queued note keeps the observer running.
    await backend.killSession("worker");
    expect((await context.sessionObservation.runSessionNotificationObservation()).length).toBeGreaterThan(0);
    expect(sends).toEqual([]);

    backend.setProgramStatus("lead", { id: "", state: PROGRAM_STATUS_STATE.IDLE, updatedAtMs: Date.now() });
    await context.sessionObservation.runSessionNotificationObservation();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ sessionId: parent.wolfpackSessionId, sessionName: "lead" });
    expect(sends[0]!.text).toContain("worker done");

    // Nothing queued and no live child: the observer is idle again.
    expect(await context.sessionObservation.runSessionNotificationObservation()).toEqual([]);
  } finally {
    stopDelivery();
    await context.sessionObservation.stopSessionNotificationObserver();
    await context.close();
  }
});

test("a live observation that started before a child's exit does not report the exit twice (review A3-1)", async () => {
  const parentId = "11111111-1111-4111-8111-111111111111";
  const childId = "22222222-2222-4222-8222-222222222222";
  let childAlive = true;
  const info = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, cwd: "/tmp", alive: true, cols: 120, rows: 40, pid: 1234, started_at_ms: Date.now() - 1000,
    exit_code: null, command: ["claude"], env: [], ...extra,
  });
  const client = {
    request: async (method: string) => {
      if (method !== "list_sessions") throw new Error(`unexpected broker request ${method}`);
      return {
        status: "ok",
        payload: {
          sessions: [
            info(parentId, "lead"),
            info(childId, "worker", {
              alive: childAlive,
              env: [["WOLFPACK_PARENT_SESSION_ID", parentId], ["WOLFPACK_PARENT_SESSION_NAME", "lead"]],
              program_status: { id: "", state: "working", updated_at_ms: Date.now() },
            }),
          ],
        },
      };
    },
  };
  const backend = new BrokerBackend(client as never, () => {});
  const context = createServerContext({ backend, observationCacheTtlMs: 0 });
  context.childEvents.noteChildCreated(childId, "worker", { wolfpackSessionId: parentId, wolfpackSessionName: "lead" });
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured = () => {};
  const captureEntered = new Promise<void>(resolve => { captured = resolve; });
  backend.capturePane = async (name: string) => {
    if (name === "worker") {
      captured();
      await gate;
    }
    return "unchanged";
  };
  try {
    // The pass reads the child as live, then waits on its capture.
    const observation = context.sessionObservation.runSessionNotificationObservation();
    await captureEntered;
    childAlive = false;
    backend.ingestEvent({ event: "session_exited", session_id: childId, exit_code: 3 });
    release();
    await observation;
    // The next table lists the child dead.
    await context.sessionObservation.runSessionNotificationObservation();
    const exits = listParentNotifications(parentId).filter(entry => entry.childEvent?.event === "exited");
    expect(exits).toHaveLength(1);
    expect(exits[0]!.childEvent).toMatchObject({ childSessionId: childId, exitCode: 3 });
  } finally {
    release();
    await context.sessionObservation.stopSessionNotificationObserver();
    await context.close();
  }
});
