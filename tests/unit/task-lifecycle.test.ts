import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalTaskEvent, ImmutableTaskAssignment, TaskAddress, TaskParticipants } from "../../src/tasks/domain.ts";
import { TASK_LEDGER_ROLE, TaskStore } from "../../src/tasks/store.ts";
import { TaskLifecycle } from "../../src/tasks/lifecycle.ts";

const PARENT: TaskAddress = { machine: "machine-a", sessionId: "parent" };
const RECEIVER: TaskAddress = { machine: "machine-b", sessionId: "receiver" };
const SENDER: TaskAddress = { machine: "machine-a", sessionId: "sender-gateway" };
const PARTICIPANTS: TaskParticipants = { parent: PARENT, receiver: RECEIVER, sender: SENDER };

function testRoot(): string {
  return mkdtempSync(join(tmpdir(), "wolfpack-task-lifecycle-"));
}

function assignment(taskId: string): ImmutableTaskAssignment {
  return {
    taskId,
    source: PARENT,
    target: RECEIVER,
    task: "inspect the lifecycle",
    createdAt: "2026-08-03T00:00:00.000Z",
    expiresAt: "2026-08-03T01:00:00.000Z",
    context: undefined,
    role: undefined,
    metadata: undefined,
    onCompletePrompt: undefined,
  };
}

function createdEvent(taskId: string): CanonicalTaskEvent {
  return {
    id: `created-${taskId}`,
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

function senderFailedEvent(taskId: string): CanonicalTaskEvent {
  return {
    id: `failed-${taskId}`,
    taskId,
    type: "task.failed",
    actor: "sender",
    source: SENDER,
    destination: PARENT,
    sequence: "2",
    occurredAt: "2026-08-03T00:10:00.000Z",
    message: undefined,
    replyToMessageId: undefined,
    payload: { kind: "none" },
    completion: {
      summary: "dispatch failed",
      result: undefined,
      error: { code: "OFFLINE", message: "offline", retryable: false },
      artifacts: undefined,
      warnings: [],
    },
  };
}

function parentAckPendingEvent(taskId: string): CanonicalTaskEvent {
  return {
    id: `ack-pending-${taskId}`,
    taskId,
    type: "task.parent_ack_pending",
    actor: "sender",
    source: SENDER,
    destination: RECEIVER,
    sequence: "3",
    occurredAt: "2026-08-03T00:20:00.000Z",
    message: undefined,
    replyToMessageId: undefined,
    payload: { kind: "none" },
    completion: undefined,
  };
}

function parentAcknowledgedEvent(taskId: string): CanonicalTaskEvent {
  return {
    id: `acknowledged-${taskId}`,
    taskId,
    type: "task.parent_acknowledged",
    actor: "sender",
    source: SENDER,
    destination: RECEIVER,
    sequence: "4",
    occurredAt: "2026-08-03T00:30:00.000Z",
    message: undefined,
    replyToMessageId: `ack-pending-${taskId}`,
    payload: { kind: "parent_ack", pendingAckEventId: `ack-pending-${taskId}` },
    completion: undefined,
  };
}

async function createLedger(store: TaskStore, role: "sender" | "receiver", taskId: string) {
  const opened = await store.createLedger({ role, assignment: assignment(taskId), participants: PARTICIPANTS });
  if (opened.kind !== "created") throw new Error("expected task ledger");
  await store.appendEvent(opened.ledger, createdEvent(taskId));
  return opened.ledger;
}

async function createSender(store: TaskStore, taskId: string) {
  return createLedger(store, TASK_LEDGER_ROLE.SENDER, taskId);
}

async function appendTerminal(ledger: Awaited<ReturnType<typeof createSender>>, store: TaskStore, acknowledged: boolean): Promise<void> {
  await store.appendEvent(ledger, senderFailedEvent(ledger.key.taskId));
  if (!acknowledged) return;
  await store.appendEvent(ledger, parentAckPendingEvent(ledger.key.taskId));
  await store.appendEvent(ledger, parentAcknowledgedEvent(ledger.key.taskId));
}

describe("task lifecycle", () => {
  test("expires overdue sender-owned nonterminal tasks through a canonical timeout event", async () => {
    const store = new TaskStore({ root: testRoot() });
    const ledger = await createSender(store, "task-expired");
    const lifecycle = new TaskLifecycle(store, {
      now: () => new Date("2026-08-03T01:00:00.000Z"),
      generateId: () => "timeout-task-expired",
    });

    const committed = await lifecycle.sweep();

    expect(committed).toMatchObject([{ id: "timeout-task-expired", type: "task.timed_out", actor: "sender", destination: PARENT, occurredAt: "2026-08-03T01:00:00.000Z" }]);
    expect((await store.getLedger(ledger.key))?.state.status).toBe("timed_out");
  });

  test("uses a clock-derived UUIDv7 for default lifecycle event IDs", async () => {
    const now = new Date("2026-08-03T01:00:00.000Z");
    const store = new TaskStore({ root: testRoot() });
    await createSender(store, "task-default-timeout-id");
    const lifecycle = new TaskLifecycle(store, { now: () => now });

    const [event] = await lifecycle.sweep();

    expect(event?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(event?.id.replaceAll("-", "").slice(0, 12)).toBe(now.getTime().toString(16).padStart(12, "0"));
  });

  test("never times out a receiver replica", async () => {
    const store = new TaskStore({ root: testRoot() });
    const ledger = await createLedger(store, TASK_LEDGER_ROLE.RECEIVER, "task-receiver-expired");
    const lifecycle = new TaskLifecycle(store, {
      now: () => new Date("2026-08-03T01:00:00.000Z"),
      generateId: () => "must-not-be-used",
    });

    expect(await lifecycle.sweep()).toEqual([]);
    expect((await store.getLedger(ledger.key))?.state.status).toBe("pending_delivery");
  });

  test("reconciles only rebuilt startup pending sender dispatches once", async () => {
    const root = testRoot();
    const initial = new TaskStore({ root });
    const ledger = await createSender(initial, "task-interrupted-dispatch");
    const restarted = new TaskStore({ root });
    const lifecycle = new TaskLifecycle(restarted, {
      now: () => new Date("2026-08-03T00:30:00.000Z"),
      generateId: () => "interrupted-dispatch-failure",
    });

    const startup = await lifecycle.initialize();

    expect(startup.interruptedDispatchEvents).toMatchObject([{
      id: "interrupted-dispatch-failure",
      type: "task.failed",
      actor: "sender",
      destination: PARENT,
      completion: { summary: "initial task dispatch was interrupted before receiver receipt", error: { code: "INITIAL_DISPATCH_INTERRUPTED", retryable: false } },
    }]);
    expect((await restarted.getLedger(ledger.key))?.state.status).toBe("failed");
    expect(await lifecycle.initialize()).toEqual({ timedOutEvents: [], interruptedDispatchEvents: [] });
  });

  test("does not recover a sender ledger created during the current process", async () => {
    const store = new TaskStore({ root: testRoot() });
    const ledger = await createSender(store, "task-current-process");
    const lifecycle = new TaskLifecycle(store, {
      now: () => new Date("2026-08-03T00:30:00.000Z"),
      generateId: () => "must-not-recover",
    });

    expect(await lifecycle.initialize()).toEqual({ timedOutEvents: [], interruptedDispatchEvents: [] });
    expect((await store.getLedger(ledger.key))?.state.status).toBe("pending_delivery");
  });

  test("tombstones and removes an unconfirmed receiver receipt after its ten-minute orphan expiry", async () => {
    const store = new TaskStore({ root: testRoot() });
    const opened = await store.createLedger({
      role: TASK_LEDGER_ROLE.RECEIVER,
      assignment: assignment("task-provisional-orphan"),
      participants: PARTICIPANTS,
    });
    if (opened.kind !== "created") throw new Error("expected provisional receiver ledger");
    const ledger = opened.ledger;
    await store.appendPeerReceipt(ledger, {
      id: "peer.receipt:orphan",
      source: PARENT,
      taskId: ledger.key.taskId,
      assignmentHash: ledger.header.assignmentHash,
      createdEventId: "created-provisional-orphan",
      receiptId: "orphan",
    });
    const lifecycle = new TaskLifecycle(store, { now: () => new Date("2026-08-03T00:10:00.000Z") });

    await lifecycle.sweep();

    expect(await store.getLedger(ledger.key)).toBeUndefined();
    expect(await store.readTombstone(ledger.key)).toMatchObject({
      key: ledger.key,
      assignmentHash: ledger.header.assignmentHash,
      writtenAt: "2026-08-03T00:10:00.000Z",
    });
  });

  test("retains unacknowledged sender terminals but tombstones acknowledged payloads after ten days", async () => {
    const root = testRoot();
    const store = new TaskStore({ root });
    const acknowledged = await createSender(store, "task-retained-sender");
    const unacknowledged = await createSender(store, "task-unacknowledged-sender");
    const acknowledgementPending = await createSender(store, "task-acknowledgement-pending-sender");
    await appendTerminal(acknowledged, store, true);
    await appendTerminal(unacknowledged, store, false);
    await appendTerminal(acknowledgementPending, store, false);
    await store.appendEvent(acknowledgementPending, parentAckPendingEvent(acknowledgementPending.key.taskId));
    const lifecycle = new TaskLifecycle(store, { now: () => new Date("2026-08-13T00:30:00.000Z") });

    await lifecycle.sweep();

    expect(await store.getLedger(acknowledged.key)).toBeUndefined();
    expect(await store.readTombstone(acknowledged.key)).toMatchObject({ key: acknowledged.key, assignmentHash: acknowledged.header.assignmentHash });
    expect(await store.getLedger(unacknowledged.key)).toBeDefined();
    expect(await store.getLedger(acknowledgementPending.key)).toMatchObject({
      state: { status: "failed", pendingParentAckEventId: "ack-pending-task-acknowledgement-pending-sender", parentAcknowledgedEventId: undefined },
    });
    expect(existsSync(acknowledged.paths.ledgerPath)).toBe(false);
  });

  test("uses only a durable receiver cleanup eligibility record for replica retention", async () => {
    const store = new TaskStore({ root: testRoot() });
    const ledger = await createLedger(store, TASK_LEDGER_ROLE.RECEIVER, "task-retained-receiver");
    await appendTerminal(ledger, store, false);
    await store.appendAcknowledgment(ledger, { id: "receiver-ack", eventId: "ack-pending-task-retained-receiver", occurredAt: "2026-08-03T00:30:00.000Z" });
    const lifecycle = new TaskLifecycle(store, { now: () => new Date("2026-08-13T00:30:00.000Z") });

    await lifecycle.sweep();
    expect(await store.getLedger(ledger.key)).toBeDefined();

    await store.markCleanupEligible(ledger, { id: "receiver-cleanup", acknowledgedEventId: "receiver-ack", occurredAt: "2026-08-03T00:30:00.000Z" });
    await lifecycle.sweep();
    expect(await store.getLedger(ledger.key)).toBeUndefined();
  });

  test("requires and reuses the exact durable receiver acknowledgment for cleanup eligibility", async () => {
    const store = new TaskStore({ root: testRoot() });
    const ledger = await createLedger(store, TASK_LEDGER_ROLE.RECEIVER, "task-exact-receiver-ack");
    await appendTerminal(ledger, store, false);

    await expect(store.markCleanupEligible(ledger, { id: "wrong-cleanup", acknowledgedEventId: "missing-ack", occurredAt: "2026-08-03T00:30:00.000Z" })).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
    await store.appendAcknowledgment(ledger, { id: "receiver-ack", eventId: "ack-pending-task-exact-receiver-ack", occurredAt: "2026-08-03T00:30:00.000Z" });
    expect(await store.appendAcknowledgment(ledger, { id: "receiver-ack", eventId: "ack-pending-task-exact-receiver-ack", occurredAt: "2026-08-03T00:30:00.000Z" })).toMatchObject({ kind: "reused", record: { id: "receiver-ack" } });
    await store.markCleanupEligible(ledger, { id: "receiver-cleanup", acknowledgedEventId: "receiver-ack", occurredAt: "2026-08-03T00:30:00.000Z" });
    expect(await store.markCleanupEligible(ledger, { id: "receiver-cleanup", acknowledgedEventId: "receiver-ack", occurredAt: "2026-08-03T00:30:00.000Z" })).toMatchObject({ kind: "reused", record: { id: "receiver-cleanup" } });
  });

  test("retains tombstones for a second ten-day window then removes only the generated file", async () => {
    const store = new TaskStore({ root: testRoot() });
    const ledger = await createSender(store, "task-tombstone-retention");
    await appendTerminal(ledger, store, true);
    let now = new Date("2026-08-13T00:30:00.000Z");
    const lifecycle = new TaskLifecycle(store, { now: () => now });

    await lifecycle.sweep();
    expect(await store.readTombstone(ledger.key)).toBeDefined();
    now = new Date("2026-08-23T00:30:00.000Z");
    await lifecycle.sweep();

    expect(await store.readTombstone(ledger.key)).toBeUndefined();
  });

  test("durably creates the tombstone directory before unlinking an acknowledged ledger", async () => {
    const steps: Array<{ readonly phase: string; readonly path: string }> = [];
    const root = testRoot();
    const store = new TaskStore({
      root,
      testHooks: {
        beforeFsync: (step, path) => steps.push({ phase: `before:${step}`, path }),
        afterFsync: (step, path) => steps.push({ phase: `after:${step}`, path }),
      },
    });
    const ledger = await createSender(store, "task-tombstone-directory");
    await appendTerminal(ledger, store, true);
    steps.length = 0;
    const lifecycle = new TaskLifecycle(store, { now: () => new Date("2026-08-13T00:30:00.000Z") });

    await lifecycle.sweep();

    const rootLinkFsync = steps.findIndex((step) => step.phase === "after:ledger-parent-directory" && step.path === root);
    const ledgerUnlink = steps.findIndex((step) => step.phase === "before:cleanup-ledger-directory");
    expect(rootLinkFsync).toBeGreaterThanOrEqual(0);
    expect(ledgerUnlink).toBeGreaterThan(rootLinkFsync);
    expect(existsSync(ledger.paths.tombstonePath)).toBe(true);
    expect(existsSync(ledger.paths.ledgerPath)).toBe(false);
  });

  test("retries payload cleanup after a crash between deletion and in-memory index removal", async () => {
    let failAfterDeletion = true;
    const store = new TaskStore({
      root: testRoot(),
      testHooks: {
        beforeFsync: undefined,
        afterFsync: (step) => {
          if (step === "cleanup-ledger-directory" && failAfterDeletion) throw new Error("simulated crash after ledger unlink");
        },
      },
    });
    const ledger = await createSender(store, "task-partial-cleanup");
    await appendTerminal(ledger, store, true);
    const lifecycle = new TaskLifecycle(store, { now: () => new Date("2026-08-13T00:30:00.000Z") });

    await expect(lifecycle.sweep()).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
    expect(existsSync(ledger.paths.ledgerPath)).toBe(false);
    failAfterDeletion = false;
    await lifecycle.sweep();

    expect(await store.getLedger(ledger.key)).toBeUndefined();
    expect(await store.readTombstone(ledger.key)).toBeDefined();
  });

  test("unlinks an in-root generated ledger symlink without touching its external target", async () => {
    const root = testRoot();
    const store = new TaskStore({ root });
    const ledger = await createSender(store, "task-symlink-cleanup");
    await appendTerminal(ledger, store, true);
    const externalRoot = mkdtempSync(join(tmpdir(), "wolfpack-task-lifecycle-external-"));
    const externalLedger = join(externalRoot, "ledger.jsonl");
    renameSync(ledger.paths.ledgerPath, externalLedger);
    const externalContents = readFileSync(externalLedger, "utf-8");
    symlinkSync(externalLedger, ledger.paths.ledgerPath);
    const lifecycle = new TaskLifecycle(store, { now: () => new Date("2026-08-13T00:30:00.000Z") });

    await lifecycle.sweep();

    expect(existsSync(ledger.paths.ledgerPath)).toBe(false);
    expect(existsSync(externalLedger)).toBe(true);
    expect(readFileSync(externalLedger, "utf-8")).toBe(externalContents);
  });
});
