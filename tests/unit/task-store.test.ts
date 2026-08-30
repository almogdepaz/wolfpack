import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { CanonicalTaskEvent, ImmutableTaskAssignment, TaskAddress, TaskParticipants } from "../../src/tasks/domain.ts";
import {
  TASK_LEDGER_ROLE,
  TaskStore,
  TaskStoreError,
  taskStorePaths,
} from "../../src/tasks/store.ts";

const PARENT: TaskAddress = { machine: "machine-a", sessionId: "parent" };
const RECEIVER: TaskAddress = { machine: "machine-b", sessionId: "receiver" };
const SENDER: TaskAddress = { machine: "machine-a", sessionId: "sender-gateway" };
const PARTICIPANTS: TaskParticipants = { parent: PARENT, receiver: RECEIVER, sender: SENDER };

function testRoot(): string {
  return mkdtempSync(join(tmpdir(), "wolfpack-task-store-"));
}

function assignment(taskId: string): ImmutableTaskAssignment {
  return {
    taskId,
    source: PARENT,
    target: RECEIVER,
    task: "inspect the durable ledger",
    createdAt: "2026-08-03T00:00:00.000Z",
    expiresAt: "2026-08-03T01:00:00.000Z",
    context: undefined,
    role: undefined,
    metadata: undefined,
    onCompletePrompt: undefined,
  };
}

function createdEvent(taskId: string, id = `created-${taskId}`): CanonicalTaskEvent {
  return {
    id,
    taskId,
    type: "task.created",
    actor: "parent",
    source: PARENT,
    destination: RECEIVER,
    sequence: "1",
    occurredAt: "2026-08-03T00:00:00.000Z",
    message: undefined,
    replyToMessageId: undefined,
    payload: { kind: "none" },
    completion: undefined,
  };
}

function receivedEvent(taskId: string): CanonicalTaskEvent {
  return {
    id: `received-${taskId}`,
    taskId,
    type: "task.received",
    actor: "receiver",
    source: RECEIVER,
    destination: PARENT,
    sequence: "2",
    occurredAt: "2026-08-03T00:00:00.000Z",
    message: undefined,
    replyToMessageId: undefined,
    payload: { kind: "none" },
    completion: undefined,
  };
}

function deliveredEvent(taskId: string): CanonicalTaskEvent {
  return {
    id: `delivered-${taskId}`,
    taskId,
    type: "task.delivered",
    actor: "receiver",
    source: RECEIVER,
    destination: PARENT,
    sequence: "3",
    occurredAt: "2026-08-03T00:00:00.000Z",
    message: undefined,
    replyToMessageId: undefined,
    payload: { kind: "delivery", injectedEventId: `created-${taskId}` },
    completion: undefined,
  };
}

async function createSender(store: TaskStore, taskId: string) {
  const opened = await store.createLedger({
    role: TASK_LEDGER_ROLE.SENDER,
    assignment: assignment(taskId),
    participants: PARTICIPANTS,
  });
  expect(opened.kind).toBe("created");
  if (opened.kind !== "created" && opened.kind !== "reused") throw new Error("expected an available sender ledger");
  return opened.ledger;
}

describe("task append-only store", () => {
  test("uses a machine-global default root and containment-safe generated ledger paths", () => {
    expect(taskStorePaths().root).toMatch(/\.wolfpack\/tasks$/);
    const root = testRoot();
    const paths = taskStorePaths(root, {
      role: TASK_LEDGER_ROLE.RECEIVER,
      sourceMachine: "../../machine-a",
      taskId: "../../task-id",
    });
    expect(relative(root, paths.ledgerPath).startsWith("..")).toBe(false);
    expect(relative(root, paths.quarantinePath).startsWith("..")).toBe(false);
    expect(paths.ledgerPath).not.toContain("../");
  });

  test("appends and fsyncs a real ledger record before acknowledging the append", async () => {
    const root = testRoot();
    const store = new TaskStore({ root });
    const ledger = await createSender(store, "task-fsync");
    const result = await store.appendOutboundIntent(ledger, {
      id: "completed-task-fsync",
      taskId: "task-fsync",
      type: "task.completed",
      actor: "receiver",
      occurredAt: "2026-08-03T00:00:00.000Z",
      message: undefined,
      replyToMessageId: undefined,
      payload: { kind: "none" },
      completion: {
        summary: "done",
        result: { _: 1, "!": 2, a: 3, A: 4 },
        error: undefined,
        artifacts: undefined,
      },
    });

    expect(result.kind).toBe("appended");
    expect(readFileSync(ledger.paths.ledgerPath, "utf-8")).toContain('"result":{"!":2,"A":4,"_":1,"a":3}');
  });

  test("serializes concurrent same-task mutation and reuses only exact duplicate records", async () => {
    const store = new TaskStore({ root: testRoot() });
    const ledger = await createSender(store, "task-concurrent");
    const event = createdEvent("task-concurrent");
    const results = await Promise.all(Array.from({ length: 16 }, () => store.appendEvent(ledger, event)));

    expect(results.filter((result) => result.kind === "appended")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "reused")).toHaveLength(15);
    await expect(store.appendEvent(ledger, { ...event, occurredAt: "2026-08-03T00:01:00.000Z" })).resolves.toMatchObject({
      kind: "conflict",
      code: "IMMUTABLE_CONTENT_CONFLICT",
    });
    await expect(store.createLedger({
      role: TASK_LEDGER_ROLE.SENDER,
      assignment: { ...assignment("task-concurrent"), task: "divergent immutable assignment" },
      participants: PARTICIPANTS,
    })).resolves.toMatchObject({ kind: "conflict", code: "IMMUTABLE_CONTENT_CONFLICT" });
  });

  test("allocates unique ordered machine delivery sequences across concurrent tasks", async () => {
    const root = testRoot();
    const store = new TaskStore({ root });
    const [first, second] = await Promise.all([createSender(store, "task-one"), createSender(store, "task-two")]);
    await Promise.all([store.appendEvent(first, createdEvent("task-one")), store.appendEvent(second, createdEvent("task-two"))]);
    const records = await Promise.all([
      store.appendInboxRecord(first, { id: "inbox-one", eventId: "created-task-one", occurredAt: "2026-08-03T00:00:01.000Z" }),
      store.appendInboxRecord(second, { id: "inbox-two", eventId: "created-task-two", occurredAt: "2026-08-03T00:00:01.000Z" }),
    ]);

    const sequences = records.map((record) => record.deliverySequence).sort((left, right) => Number(left) - Number(right));
    expect(sequences).toEqual(["1", "2"]);
  });

  test("rebuilds derived state and inbox index from ledgers when caches are absent or stale", async () => {
    const root = testRoot();
    const store = new TaskStore({ root });
    const ledger = await createSender(store, "task-rebuild");
    await store.appendEvent(ledger, createdEvent("task-rebuild"));
    await store.appendEvent(ledger, receivedEvent("task-rebuild"));
    await store.appendInboxRecord(ledger, { id: "inbox-rebuild", eventId: "received-task-rebuild", occurredAt: "2026-08-03T00:00:01.000Z" });
    rmSync(ledger.paths.cachePath);
    writeFileSync(taskStorePaths(root).inboxIndexPath, "{stale");

    const restarted = new TaskStore({ root });
    const rebuilt = await restarted.getLedger(ledger.key);
    expect(rebuilt?.state).toMatchObject({ status: "received", events: [{ id: "created-task-rebuild" }, { id: "received-task-rebuild" }] });
    expect(await restarted.inboxAfter("0")).toMatchObject({ events: [{ eventId: "received-task-rebuild", deliverySequence: "1" }], nextCursor: "1" });

    const nextLedger = await createSender(restarted, "task-rebuild-after-cache-loss");
    await restarted.appendEvent(nextLedger, createdEvent("task-rebuild-after-cache-loss"));
    expect(await restarted.appendInboxRecord(nextLedger, { id: "inbox-rebuild-after-cache-loss", eventId: "created-task-rebuild-after-cache-loss", occurredAt: "2026-08-03T00:00:02.000Z" })).toMatchObject({ deliverySequence: "2" });
  });

  test("uses the larger of durable delivery high-water and surviving inbox rows on restart", async () => {
    const root = testRoot();
    const store = new TaskStore({ root });
    const ledger = await createSender(store, "task-sequence-surviving");
    await store.appendEvent(ledger, createdEvent("task-sequence-surviving"));
    await store.appendInboxRecord(ledger, { id: "inbox-sequence-surviving", eventId: "created-task-sequence-surviving", occurredAt: "2026-08-03T00:00:01.000Z" });
    writeFileSync(taskStorePaths(root).deliverySequencePath, JSON.stringify({ version: 1, nextDeliverySequence: "1" }));

    const restarted = new TaskStore({ root });
    const next = await createSender(restarted, "task-sequence-after-surviving");
    await restarted.appendEvent(next, createdEvent("task-sequence-after-surviving"));
    expect(await restarted.appendInboxRecord(next, { id: "inbox-sequence-after-surviving", eventId: "created-task-sequence-after-surviving", occurredAt: "2026-08-03T00:00:02.000Z" })).toMatchObject({ deliverySequence: "2" });
  });

  test("retains delivery sequence high-water after quarantining an unavailable inbox ledger", async () => {
    const root = testRoot();
    const store = new TaskStore({ root });
    const first = await createSender(store, "task-sequence-quarantined");
    await store.appendEvent(first, createdEvent("task-sequence-quarantined"));
    expect(await store.appendInboxRecord(first, { id: "inbox-sequence-quarantined", eventId: "created-task-sequence-quarantined", occurredAt: "2026-08-03T00:00:01.000Z" })).toMatchObject({ deliverySequence: "1" });
    appendFileSync(first.paths.ledgerPath, "not-json\n");
    rmSync(first.paths.cachePath);
    rmSync(taskStorePaths(root).inboxIndexPath);

    const restarted = new TaskStore({ root });
    await restarted.initialize();
    expect(await restarted.getLedger(first.key)).toBeUndefined();
    expect(existsSync(first.paths.quarantinePath)).toBe(true);

    const next = await createSender(restarted, "task-sequence-after-quarantine");
    await restarted.appendEvent(next, createdEvent("task-sequence-after-quarantine"));
    expect(await restarted.appendInboxRecord(next, { id: "inbox-sequence-after-quarantine", eventId: "created-task-sequence-after-quarantine", occurredAt: "2026-08-03T00:00:02.000Z" })).toMatchObject({ deliverySequence: "2" });
  });

  test("reserves a durable delivery sequence before appending its inbox record", async () => {
    const root = testRoot();
    const store = new TaskStore({
      root,
      testHooks: {
        beforeFsync: (step) => {
          if (step === "delivery-sequence-file") throw new Error("reserved sequence write failed");
        },
        afterFsync: undefined,
      },
    });
    const ledger = await createSender(store, "task-sequence-reservation");
    await store.appendEvent(ledger, createdEvent("task-sequence-reservation"));

    await expect(store.appendInboxRecord(ledger, { id: "inbox-sequence-reservation", eventId: "created-task-sequence-reservation", occurredAt: "2026-08-03T00:00:01.000Z" })).rejects.toBeInstanceOf(TaskStoreError);
    expect(readFileSync(ledger.paths.ledgerPath, "utf-8")).not.toContain('"kind":"inbox"');
  });

  test("fails closed when durable delivery sequence metadata is malformed", async () => {
    const root = testRoot();
    writeFileSync(taskStorePaths(root).deliverySequencePath, "{malformed");

    await expect(createSender(new TaskStore({ root }), "task-malformed-delivery-sequence")).rejects.toBeInstanceOf(TaskStoreError);
    expect(readFileSync(taskStorePaths(root).deliverySequencePath, "utf-8")).toBe("{malformed");
  });

  test("keeps receiver inbox and outbox records in a replica ledger while deriving the shared task state", async () => {
    const store = new TaskStore({ root: testRoot() });
    const opened = await store.createLedger({
      role: TASK_LEDGER_ROLE.RECEIVER,
      assignment: assignment("task-replica"),
      participants: PARTICIPANTS,
    });
    expect(opened.kind).toBe("created");
    if (opened.kind !== "created") throw new Error("expected receiver replica");
    await store.appendEvent(opened.ledger, createdEvent("task-replica"));
    await store.appendEvent(opened.ledger, receivedEvent("task-replica"));
    await store.appendEvent(opened.ledger, deliveredEvent("task-replica"));
    await store.appendInboxRecord(opened.ledger, { id: "inbox-replica", eventId: "delivered-task-replica", occurredAt: "2026-08-03T00:00:01.000Z" });
    await store.appendOutboundIntent(opened.ledger, { id: "delivered-task-replica", taskId: "task-replica", type: "task.delivered", actor: "receiver", occurredAt: "2026-08-03T00:00:02.000Z", message: undefined, replyToMessageId: undefined, payload: { kind: "delivery", injectedEventId: "created-task-replica" }, completion: undefined });
    await store.appendOutboxAttempt(opened.ledger, { id: "outbox-replica", eventId: "delivered-task-replica", attempt: 1, occurredAt: "2026-08-03T00:00:02.000Z" });
    await store.appendOutboxDelivered(opened.ledger, { id: "outbox-delivered-replica", eventId: "delivered-task-replica", occurredAt: "2026-08-03T00:00:03.000Z" });
    await store.appendAcknowledgment(opened.ledger, { id: "ack-replica", eventId: "delivered-task-replica", occurredAt: "2026-08-03T00:00:03.000Z" });
    await store.appendDiagnostic(opened.ledger, { id: "diagnostic-replica", code: "OFFLINE", message: "offline", occurredAt: "2026-08-03T00:00:04.000Z" });
    await store.markCleanupEligible(opened.ledger, { id: "cleanup-replica", acknowledgedEventId: "ack-replica", occurredAt: "2026-08-03T00:00:05.000Z" });

    expect((await store.getLedger(opened.ledger.key))?.state.status).toBe("active");
    expect((await store.getLedger(opened.ledger.key))?.records.map((record) => record.kind)).toEqual([
      "event", "event", "event", "inbox", "outbox.intent", "outbox.attempt", "outbox.delivered", "acknowledgment", "diagnostic", "cleanup.eligible",
    ]);
    await expect(store.appendOutboxAttempt(await createSender(store, "task-not-replica"), { id: "wrong-role", eventId: "event", attempt: 1, occurredAt: "2026-08-03T00:00:02.000Z" })).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
  });

  test("writes and consults tombstones so delayed duplicate assignments cannot resurrect or diverge", async () => {
    const store = new TaskStore({ root: testRoot() });
    const ledger = await createSender(store, "task-tombstone");
    const tombstone = await store.writeTombstone(ledger, "2026-08-13T00:00:00.000Z");
    expect(await store.readTombstone(ledger.key)).toEqual(tombstone);

    await expect(store.createLedger({ role: TASK_LEDGER_ROLE.SENDER, assignment: assignment("task-tombstone"), participants: PARTICIPANTS })).resolves.toMatchObject({ kind: "tombstoned" });
    await expect(store.createLedger({
      role: TASK_LEDGER_ROLE.SENDER,
      assignment: { ...assignment("task-tombstone"), task: "different immutable content" },
      participants: PARTICIPANTS,
    })).resolves.toMatchObject({ kind: "conflict", code: "IMMUTABLE_CONTENT_CONFLICT" });
  });

  test("preserves and ignores a crash-truncated final line", async () => {
    const root = testRoot();
    const store = new TaskStore({ root });
    const ledger = await createSender(store, "task-truncated");
    await store.appendEvent(ledger, createdEvent("task-truncated"));
    appendFileSync(ledger.paths.ledgerPath, '{"kind":"event"');

    const restarted = new TaskStore({ root });
    const rebuilt = await restarted.getLedger(ledger.key);
    expect(rebuilt).toMatchObject({ state: { events: [{ id: "created-task-truncated" }] }, truncatedTailBytes: 16 });
    expect(readFileSync(ledger.paths.ledgerPath, "utf-8")).toEndWith('{"kind":"event"');
  });

  test("quarantines a midstream corrupt ledger without deleting its evidence", async () => {
    const root = testRoot();
    const store = new TaskStore({ root });
    const ledger = await createSender(store, "task-corrupt");
    await store.appendEvent(ledger, createdEvent("task-corrupt"));
    appendFileSync(ledger.paths.ledgerPath, "not-json\n");

    const restarted = new TaskStore({ root });
    await restarted.initialize();
    expect(await restarted.getLedger(ledger.key)).toBeUndefined();
    expect(existsSync(ledger.paths.quarantinePath)).toBe(true);
    expect(readFileSync(ledger.paths.quarantinePath, "utf-8")).toContain("not-json");
  });

  test("surfaces filesystem failures as STORE_UNAVAILABLE-compatible typed errors", async () => {
    const root = testRoot();
    const blockedRoot = join(root, "blocked");
    mkdirSync(blockedRoot);
    writeFileSync(join(blockedRoot, "ledgers"), "not a directory");
    const store = new TaskStore({ root: blockedRoot });

    await expect(store.createLedger({ role: TASK_LEDGER_ROLE.SENDER, assignment: assignment("task-unavailable"), participants: PARTICIPANTS })).rejects.toBeInstanceOf(TaskStoreError);
    await expect(store.createLedger({ role: TASK_LEDGER_ROLE.SENDER, assignment: assignment("task-unavailable"), participants: PARTICIPANTS })).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
  });

  test("fsyncs a fresh ledger directory chain bottom-up before its authoritative file", async () => {
    const root = join(testRoot(), "store");
    const steps: Array<{ readonly phase: string; readonly path: string }> = [];
    const store = new TaskStore({
      root,
      testHooks: {
        beforeFsync: (step, path) => steps.push({ phase: `before:${step}`, path }),
        afterFsync: (step, path) => steps.push({ phase: `after:${step}`, path }),
      },
    });
    const ledger = await createSender(store, "task-fsync-order");
    expect(steps.map(({ phase }) => phase)).toEqual([
      "before:ledger-parent-directory", "after:ledger-parent-directory",
      "before:ledger-parent-directory", "after:ledger-parent-directory",
      "before:ledger-parent-directory", "after:ledger-parent-directory",
      "before:ledger-file", "after:ledger-file", "before:ledger-directory", "after:ledger-directory",
    ]);
    expect(steps.filter(({ phase }) => phase === "after:ledger-parent-directory").map(({ path }) => path)).toEqual([
      dirname(root), root, join(root, "ledgers"),
    ]);
    expect(existsSync(ledger.paths.ledgerPath)).toBe(true);
    rmSync(ledger.paths.cachePath);
    mkdirSync(ledger.paths.cachePath);
    await expect(store.appendEvent(ledger, createdEvent("task-fsync-order"))).resolves.toMatchObject({ kind: "appended" });
    expect(readFileSync(ledger.paths.ledgerPath, "utf-8")).toContain('"id":"created-task-fsync-order"');
  });

  test("surfaces authoritative fsync failure before a ledger creation acknowledgement", async () => {
    const store = new TaskStore({
      root: testRoot(),
      testHooks: {
        beforeFsync: (step) => {
          if (step === "ledger-file") throw new Error("injected fsync failure");
        },
        afterFsync: undefined,
      },
    });
    await expect(store.createLedger({ role: TASK_LEDGER_ROLE.SENDER, assignment: assignment("task-fsync-failure"), participants: PARTICIPANTS })).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
  });

  test("reuses durable inbox and scoped-idempotency records across restart", async () => {
    const root = testRoot();
    const store = new TaskStore({ root });
    const receiver = await store.createLedger({ role: TASK_LEDGER_ROLE.RECEIVER, assignment: assignment("task-idempotency"), participants: PARTICIPANTS });
    const sender = await createSender(store, "task-idempotency");
    if (receiver.kind !== "created") throw new Error("expected receiver replica");
    const firstInbox = await store.appendInboxRecord(receiver.ledger, { id: "inbox-idempotency", eventId: "event-idempotency", occurredAt: "2026-08-03T00:00:01.000Z" });
    expect(await store.appendInboxRecord(receiver.ledger, { id: "inbox-idempotency", eventId: "event-idempotency", occurredAt: "2026-08-03T00:00:01.000Z" })).toEqual(firstInbox);
    await store.appendScopedIdempotency(sender, { id: "idempotency-1", scope: { machine: PARENT.machine, sessionId: PARENT.sessionId, key: "send-1" }, assignmentHash: sender.header.assignmentHash, taskId: sender.key.taskId });
    const restarted = new TaskStore({ root });
    const restartedSender = await restarted.getLedger(sender.key);
    if (!restartedSender) throw new Error("expected sender ledger after restart");
    await expect(restarted.appendScopedIdempotency(restartedSender, { id: "idempotency-2", scope: { machine: PARENT.machine, sessionId: PARENT.sessionId, key: "send-1" }, assignmentHash: sender.header.assignmentHash, taskId: sender.key.taskId })).resolves.toMatchObject({ kind: "reused" });
  });

  test("serializes concurrent caller idempotency across task ledgers", async () => {
    const store = new TaskStore({ root: testRoot() });
    const [first, second] = await Promise.all([createSender(store, "task-scope-one"), createSender(store, "task-scope-two")]);
    const scope = { machine: PARENT.machine, sessionId: PARENT.sessionId, key: "shared-send-key" };
    const results = await Promise.all([
      store.appendScopedIdempotency(first, { id: "scope-one", scope, assignmentHash: first.header.assignmentHash, taskId: first.key.taskId }),
      store.appendScopedIdempotency(second, { id: "scope-two", scope, assignmentHash: second.header.assignmentHash, taskId: second.key.taskId }),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(["appended", "conflict"]);
    const winner = results[0]?.kind === "appended" ? first : second;
    await expect(store.appendScopedIdempotency(winner, { id: "scope-retry", scope, assignmentHash: winner.header.assignmentHash, taskId: winner.key.taskId })).resolves.toMatchObject({ kind: "reused" });
  });

  test("reports retained unresolved and unacknowledged ledger count and byte growth", async () => {
    const store = new TaskStore({ root: testRoot() });
    const ledger = await createSender(store, "task-observability");
    await store.appendEvent(ledger, createdEvent("task-observability"));
    expect(await store.observability()).toMatchObject({ retainedLedgerCount: 1, retainedLedgerBytes: expect.any(Number) });
  });
});
