import { expect, test } from "bun:test";
import { assertNotificationFixtureHome } from "./run-notification-test.ts";
assertNotificationFixtureHome();
const { MockBackend } = await import("../../../src/server/mock-backend.ts");
const { __setTestBackend, getBackend } = await import("../../../src/server/backend.ts");
const { getSubscriptionCount } = await import("../../../src/server/push.ts");
const { defaultEventBus } = await import("../../../src/event-bus.ts");
const {
  __resetSessionObservationForTests,
  __runSessionNotificationObservationForTests,
  stopSessionNotificationObserver,
} = await import("../../../src/server/session-observation.ts");
const { __resetChildEventsForTests } = await import("../../../src/server/child-events.ts");
const { listParentNotifications } = await import("../../../src/server/parent-inbox.ts");
const { PROGRAM_STATUS_STATE } = await import("../../../src/program-status-contract.ts");
const { startChildEventDelivery } = await import("../../../src/server/child-event-delivery.ts");
const { SESSION_SEND_DELIVERY, SESSION_SEND_OUTCOME } = await import("../../../src/session-send-contract.ts");

test("a child's program done reaches the parent inbox with no push or event subscribers", async () => {
  const previousBackend = getBackend();
  const backend = new MockBackend();
  __setTestBackend(backend);
  __resetSessionObservationForTests();
  __resetChildEventsForTests();
  try {
    expect(getSubscriptionCount()).toBe(0);
    expect(defaultEventBus.eventSubscriberCount()).toBe(0);
    const loadSettings = () => ({ agentCmd: "claude" });
    const parent = await backend.createSession("lead", "/tmp", "claude", loadSettings);
    // Without a child session the observer stays idle.
    expect(await __runSessionNotificationObservationForTests()).toEqual([]);

    const parentSession = { wolfpackSessionId: parent.wolfpackSessionId, wolfpackSessionName: "lead" };
    const child = await backend.createSession("worker", "/tmp", "claude", loadSettings, { parentSession });
    backend.setProgramStatus("worker", { id: "", state: PROGRAM_STATUS_STATE.WORKING, updatedAtMs: Date.now() });
    expect((await __runSessionNotificationObservationForTests()).length).toBeGreaterThan(0);
    expect(listParentNotifications(parent.wolfpackSessionId)).toEqual([]);

    backend.setProgramStatus("worker", { id: "", state: PROGRAM_STATUS_STATE.DONE, message: "tests pass", updatedAtMs: Date.now() });
    await __runSessionNotificationObservationForTests();
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
    await __runSessionNotificationObservationForTests();
    expect(listParentNotifications(parent.wolfpackSessionId)).toHaveLength(1);
  } finally {
    await stopSessionNotificationObserver();
    __setTestBackend(previousBackend);
  }
});

test("a queued typed note keeps the observer running and reaches the parent once it is idle", async () => {
  const previousBackend = getBackend();
  const backend = new MockBackend();
  __setTestBackend(backend);
  __resetSessionObservationForTests();
  __resetChildEventsForTests();
  const sends: { sessionId: string; sessionName: string; text: string }[] = [];
  const stopDelivery = startChildEventDelivery({
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
    await __runSessionNotificationObservationForTests();
    backend.setProgramStatus("worker", { id: "", state: PROGRAM_STATUS_STATE.DONE, updatedAtMs: Date.now() });
    await __runSessionNotificationObservationForTests();
    await new Promise(resolve => setTimeout(resolve, 0));
    // The parent is working: the note waits.
    expect(sends).toEqual([]);

    // With no live child left, only the queued note keeps the observer running.
    await backend.killSession("worker");
    expect((await __runSessionNotificationObservationForTests()).length).toBeGreaterThan(0);
    expect(sends).toEqual([]);

    backend.setProgramStatus("lead", { id: "", state: PROGRAM_STATUS_STATE.IDLE, updatedAtMs: Date.now() });
    await __runSessionNotificationObservationForTests();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ sessionId: parent.wolfpackSessionId, sessionName: "lead" });
    expect(sends[0]!.text).toContain("worker done");

    // Nothing queued and no live child: the observer is idle again.
    expect(await __runSessionNotificationObservationForTests()).toEqual([]);
  } finally {
    stopDelivery();
    await stopSessionNotificationObserver();
    __setTestBackend(previousBackend);
  }
});
