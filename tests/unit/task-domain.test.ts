import { describe, expect, test } from "bun:test";
import {
  TASK_API_ERROR,
  TASK_API_HTTP_STATUS,
  TASK_API_ROUTES,
  TASK_LIMITS,
  acceptSenderEvent,
  allocateLocalDeliverySequence,
  createTaskState,
  generateUuidV7,
  hashImmutableAssignment,
  resolveAssignmentReceipt,
  resolveScopedIdempotency,
  taskPayloadBoundsError,
  validateTaskPayloadBounds,
} from "../../src/tasks/domain.ts";
import type {
  TaskAddress,
  TaskArtifactProjection,
  TaskCompletionProjection,
  TaskEventInput,
  TaskEventPayload,
  TaskResultInput,
  TaskStateSnapshot,
} from "../../src/tasks/domain.ts";

const TASK_ID = "018f6b48-4b1c-7000-8000-000000000001";
const PARENT: TaskAddress = { machine: "machine-a", sessionId: "parent" };
const RECEIVER: TaskAddress = { machine: "machine-b", sessionId: "receiver" };
const SENDER: TaskAddress = { machine: "machine-a", sessionId: "sender-gateway" };
const PARTICIPANTS = { parent: PARENT, receiver: RECEIVER, sender: SENDER } as const;

type StoredCompletionCannotBePeerInput = TaskCompletionProjection extends TaskResultInput ? never : true;
type ProjectionCannotReplaceReceiverFields = { readonly summary: string; readonly result: Record<string, unknown>; readonly error: { readonly code: string } } extends TaskCompletionProjection ? never : true;
type ParentCancellationCannotBeInput = { readonly type: "task.cancelled"; readonly actor: "parent" } extends TaskEventInput ? never : true;
type LateTerminalCannotBeInput = { readonly type: "task.late_terminal"; readonly actor: "sender" } extends TaskEventInput ? never : true;
type LateTerminalCannotReferenceNonterminal = { readonly kind: "late_terminal"; readonly originalType: "task.created"; readonly originalEventId: string } extends TaskEventPayload ? never : true;
const storedCompletionCannotBePeerInput: StoredCompletionCannotBePeerInput = true;
const projectionCannotReplaceReceiverFields: ProjectionCannotReplaceReceiverFields = true;
const parentCancellationCannotBeInput: ParentCancellationCannotBeInput = true;
const lateTerminalCannotBeInput: LateTerminalCannotBeInput = true;
const lateTerminalCannotReferenceNonterminal: LateTerminalCannotReferenceNonterminal = true;
void storedCompletionCannotBePeerInput;
void projectionCannotReplaceReceiverFields;
void parentCancellationCannotBeInput;
void lateTerminalCannotBeInput;
void lateTerminalCannotReferenceNonterminal;

function state(): TaskStateSnapshot {
  return createTaskState(TASK_ID, PARTICIPANTS);
}

function base(id: string): { readonly id: string; readonly taskId: string; readonly occurredAt: string } {
  return { id, taskId: TASK_ID, occurredAt: "2026-08-03T00:00:00.000Z" };
}

function created(id: string) {
  return { ...base(id), type: "task.created", actor: "parent", message: undefined, replyToMessageId: undefined, payload: { kind: "none" }, completion: undefined } as const satisfies TaskEventInput;
}

function received(id: string): TaskEventInput {
  return { ...base(id), type: "task.received", actor: "receiver", message: undefined, replyToMessageId: undefined, payload: { kind: "none" }, completion: undefined };
}

function delivered(id: string): TaskEventInput {
  return { ...base(id), type: "task.delivered", actor: "receiver", message: undefined, replyToMessageId: undefined, payload: { kind: "delivery", injectedEventId: "created" }, completion: undefined };
}

function question(id: string, actor: "parent" | "receiver", message: string): TaskEventInput {
  return { ...base(id), type: "task.question", actor, message, replyToMessageId: undefined, payload: { kind: "none" }, completion: undefined };
}

function answer(id: string, actor: "parent" | "receiver", message: string, replyToMessageId: string): TaskEventInput {
  return { ...base(id), type: "task.answer", actor, message, replyToMessageId, payload: { kind: "none" }, completion: undefined };
}

function information(id: string, actor: "parent" | "receiver", message: string): TaskEventInput {
  return { ...base(id), type: "task.information", actor, message, replyToMessageId: undefined, payload: { kind: "none" }, completion: undefined };
}

function cancelRequested(id: string): TaskEventInput {
  return { ...base(id), type: "task.cancel_requested", actor: "parent", message: undefined, replyToMessageId: undefined, payload: { kind: "none" }, completion: undefined };
}

function receiverTerminal(id: string, type: "task.completed" | "task.failed" | "task.cancelled"): Extract<TaskEventInput, { readonly actor: "receiver"; readonly completion: TaskResultInput }> {
  return {
    ...base(id),
    type,
    actor: "receiver",
    message: undefined,
    replyToMessageId: undefined,
    payload: { kind: "none" },
    completion: {
      summary: "terminal",
      result: { changed: true },
      error: undefined,
      artifacts: [{ path: "artifacts/result.json", mimeType: "application/json", description: "result" }],
    },
  };
}

function senderFailure(id: string) {
  return {
    ...base(id), type: "task.failed", actor: "sender", message: undefined, replyToMessageId: undefined, payload: { kind: "none" },
    completion: { summary: "initial peer receive failed", result: undefined, error: { code: "PEER_UNREACHABLE", message: "response lost", retryable: true }, artifacts: undefined },
  } as const satisfies TaskEventInput;
}

function artifactProjection(overrides: Partial<TaskArtifactProjection> = {}): TaskArtifactProjection {
  return {
    sourcePath: "artifacts/result.json",
    machine: RECEIVER.machine,
    project: "receiver-project",
    normalizedPath: "normalized/result.json",
    sizeBytes: undefined,
    modifiedAt: undefined,
    ...overrides,
  };
}

function invalidProjection(): TaskCompletionProjection {
  return { artifacts: [artifactProjection({ sourcePath: "unrelated.json", normalizedPath: "normalized/unrelated.json" })], warnings: [] };
}

function timedOut(id: string) {
  return { ...base(id), type: "task.timed_out", actor: "sender", message: undefined, replyToMessageId: undefined, payload: { kind: "none" }, completion: undefined } as const satisfies TaskEventInput;
}

function deliveryFailed(id: string): TaskEventInput {
  return { ...base(id), type: "event.delivery_failed", actor: "sender", message: undefined, replyToMessageId: undefined, payload: { kind: "delivery_failure", code: "OFFLINE", message: "offline" }, completion: undefined };
}

function parentAckPending(id: string): TaskEventInput {
  return { ...base(id), type: "task.parent_ack_pending", actor: "sender", message: undefined, replyToMessageId: undefined, payload: { kind: "none" }, completion: undefined };
}

function parentAcknowledged(id: string, pendingAckEventId: string): TaskEventInput {
  return { ...base(id), type: "task.parent_acknowledged", actor: "sender", message: undefined, replyToMessageId: pendingAckEventId, payload: { kind: "parent_ack", pendingAckEventId }, completion: undefined };
}

function projection(): TaskCompletionProjection {
  return {
    artifacts: [{ sourcePath: "artifacts/result.json", machine: RECEIVER.machine, project: "receiver-project", normalizedPath: "normalized/result.json", sizeBytes: 42, modifiedAt: "2026-08-03T00:00:00.000Z" }],
    warnings: [{ code: "ARTIFACT_UNAVAILABLE", message: "artifact inspected later" }],
  };
}

function storedCompletion() {
  return {
    summary: "terminal",
    result: { changed: true },
    error: undefined,
    artifacts: [{ machine: RECEIVER.machine, project: "receiver-project", path: "normalized/result.json", mimeType: "application/json", description: "result", sizeBytes: 42, modifiedAt: "2026-08-03T00:00:00.000Z" }],
    warnings: [{ code: "ARTIFACT_UNAVAILABLE", message: "artifact inspected later" }],
  } as const;
}

function acceptEvent(stateSnapshot: TaskStateSnapshot, input: TaskEventInput, actor = input.actor) {
  const address = actor === "parent" ? PARENT : actor === "receiver" ? RECEIVER : SENDER;
  if (input.type === "task.completed" || input.type === "task.failed" || (input.type === "task.cancelled" && input.actor === "receiver")) {
    return acceptSenderEvent(stateSnapshot, input, { actor, address }, projection());
  }
  return acceptSenderEvent(stateSnapshot, input, { actor, address });
}

function accept(stateSnapshot: TaskStateSnapshot, input: TaskEventInput): TaskStateSnapshot {
  const result = acceptEvent(stateSnapshot, input);
  expect(result.kind).toBe("accepted");
  if (result.kind !== "accepted") throw new Error("expected accepted event");
  return result.state;
}

describe("task domain", () => {
  test("locks versioned routes and stable task error codes", () => {
    expect(TASK_API_ROUTES).toEqual({
      send: "POST /api/tasks/v1/send", status: "GET /api/tasks/v1/status", inbox: "GET /api/tasks/v1/inbox", message: "POST /api/tasks/v1/message", complete: "POST /api/tasks/v1/complete", cancel: "POST /api/tasks/v1/cancel", delivered: "POST /api/tasks/v1/delivered", acknowledge: "POST /api/tasks/v1/ack", peerReceive: "POST /api/tasks/v1/peer/receive", peerEvent: "POST /api/tasks/v1/peer/event",
    });
    expect(Object.keys(TASK_API_HTTP_STATUS).sort()).toEqual(Object.values(TASK_API_ERROR).sort());
    expect(TASK_API_HTTP_STATUS.MALFORMED_UPSTREAM_RESPONSE).toBe(502);
  });

  test("hashes immutable assignments with stable key ordering", async () => {
    const assignment = { taskId: TASK_ID, source: PARENT, target: RECEIVER, task: "inspect the diff", createdAt: "2026-08-03T00:00:00.000Z", expiresAt: "2026-08-03T01:00:00.000Z", context: { refs: [{ path: "src/tasks/domain.ts", purpose: "contract" }] } };
    expect(await hashImmutableAssignment(assignment)).toBe("7052cc6b8713a911567a89a78e8fe4991127503ea54865d9ecd9bfcecb9e979a");
    const { context: _context, ...withoutOptionals } = assignment;
    expect(await hashImmutableAssignment({ ...withoutOptionals, context: undefined, role: undefined })).toBe(await hashImmutableAssignment(withoutOptionals));
    await expect(hashImmutableAssignment({ invalid: Number.NaN })).rejects.toThrow("non-finite");
  });

  test("generates UUIDv7 identifiers and independent local delivery sequences", () => {
    const first = generateUuidV7(1_722_643_200_000);
    const second = generateUuidV7(1_722_643_200_001);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first < second).toBe(true);
    expect(allocateLocalDeliverySequence("41")).toEqual({ sequence: "42", nextSequence: "43" });
  });

  test("requires immutable participants and rejects an unauthorized duplicate before acknowledging it", () => {
    const createdEvent = created("created");
    const accepted = acceptEvent(state(), createdEvent);
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind !== "accepted") throw new Error("expected created");
    const forgedDuplicate = acceptSenderEvent(accepted.state, createdEvent, { actor: "parent", address: RECEIVER });
    expect(forgedDuplicate).toMatchObject({ kind: "rejected", code: TASK_API_ERROR.CALLER_MISMATCH });
  });

  test("derives waiting directions, validates replies, and leaves diagnostics state-neutral", () => {
    let current = accept(state(), created("created"));
    current = accept(current, received("received"));
    current = accept(current, delivered("delivered"));
    current = accept(current, question("question", "receiver", "which branch?"));
    expect(acceptEvent(current, question("second-question", "parent", "which test?"))).toMatchObject({ kind: "rejected", code: TASK_API_ERROR.OPEN_QUESTION_CONFLICT });
    expect(acceptEvent(current, answer("bad-answer", "parent", "main", "second-question"))).toMatchObject({ kind: "rejected", code: TASK_API_ERROR.INVALID_REPLY });
    current = accept(current, answer("answer", "parent", "main", "question"));
    current = accept(current, information("information", "parent", "use bun"));
    const diagnostic = acceptEvent(current, deliveryFailed("delivery-failure"));
    expect(diagnostic).toMatchObject({ kind: "accepted", event: { destination: RECEIVER } });
    current = accept(current, deliveryFailed("delivery-failure"));
    expect(current).toMatchObject({ status: "active", openQuestionEventId: undefined });
  });

  test("canonicalizes terminal completion only through gateway provenance and preserves it in state", () => {
    let current = accept(state(), created("created"));
    current = accept(current, received("received"));
    current = accept(current, receiverTerminal("completed", "task.completed"));
    expect(current.completion).toEqual(storedCompletion());
    expect(current.events.at(-1)).toMatchObject({ completion: storedCompletion(), source: RECEIVER, destination: PARENT, sequence: "3" });
    expect(current.warnings).toEqual(storedCompletion().warnings);
  });

  test("keeps assignment delivery evidence state-neutral after every post-receipt advancement", () => {
    const receivedState = () => accept(accept(state(), created("created")), received("received"));
    const cases: ReadonlyArray<readonly [string, TaskStateSnapshot]> = [
      ["active", accept(receivedState(), delivered("first-delivery"))],
      ["waiting_for_parent", accept(receivedState(), question("receiver-question", "receiver", "which branch?"))],
      ["waiting_for_receiver", accept(receivedState(), question("parent-question", "parent", "which test?"))],
      ["cancel_requested", accept(receivedState(), cancelRequested("cancel-request"))],
      ["completed", accept(receivedState(), receiverTerminal("completed", "task.completed"))],
      ["failed", accept(receivedState(), receiverTerminal("failed", "task.failed"))],
      ["cancelled", accept(receivedState(), receiverTerminal("cancelled", "task.cancelled"))],
      ["timed_out", accept(receivedState(), timedOut("timed-out"))],
    ];

    expect(acceptEvent(state(), delivered("pending-delivery"))).toMatchObject({ kind: "rejected", code: TASK_API_ERROR.INVALID_TRANSITION });
    expect(accept(receivedState(), delivered("received-delivery")).status).toBe("active");
    for (const [status, current] of cases) {
      const result = acceptEvent(current, delivered(`delivery-after-${status}`));
      expect(result).toMatchObject({ kind: "accepted", state: { status } });
    }
  });

  test("records delivery evidence after terminal completion without reopening the task", () => {
    let current = accept(state(), created("created"));
    current = accept(current, received("received"));
    current = accept(current, receiverTerminal("completed", "task.completed"));
    const terminalEventId = current.terminalEventId;

    current = accept(current, delivered("late-delivery"));

    expect(current).toMatchObject({ status: "completed", terminalEventId });
    expect(current.events.filter((event) => event.type === "task.delivered")).toHaveLength(1);
    expect(current.events.at(-1)).toMatchObject({
      type: "task.delivered",
      payload: { kind: "delivery", injectedEventId: "created" },
    });
  });

  test("rejects projections that introduce artifacts not declared by receiver completion", () => {
    let current = accept(state(), created("created"));
    current = accept(current, received("received"));
    const result = acceptSenderEvent(current, receiverTerminal("completed", "task.completed"), { actor: "receiver", address: RECEIVER }, invalidProjection());
    expect(result).toMatchObject({ kind: "rejected", code: TASK_API_ERROR.INVALID_TRANSITION });
  });

  test("rejects artifact projections beyond the stored completion limit", () => {
    let current = accept(state(), created("created"));
    current = accept(current, received("received"));
    const result = acceptSenderEvent(current, receiverTerminal("completed", "task.completed"), { actor: "receiver", address: RECEIVER }, { artifacts: Array.from({ length: TASK_LIMITS.ARTIFACTS + 1 }, () => artifactProjection()), warnings: [] });
    expect(result).toMatchObject({ kind: "rejected", code: TASK_API_ERROR.INVALID_TRANSITION });
  });

  test("rejects duplicate artifact projection source paths", () => {
    let current = accept(state(), created("created"));
    current = accept(current, received("received"));
    const result = acceptSenderEvent(current, receiverTerminal("completed", "task.completed"), { actor: "receiver", address: RECEIVER }, { artifacts: [artifactProjection(), artifactProjection({ normalizedPath: "normalized/copy.json" })], warnings: [] });
    expect(result).toMatchObject({ kind: "rejected", code: TASK_API_ERROR.INVALID_TRANSITION });
  });

  test.each([
    ["blank machine", { machine: "" }],
    ["blank project", { project: "" }],
    ["blank normalized path", { normalizedPath: "" }],
    ["negative artifact size", { sizeBytes: -1 }],
    ["fractional artifact size", { sizeBytes: 1.5 }],
  ] as const)("rejects projection with %s", (_name, overrides) => {
    let current = accept(state(), created("created"));
    current = accept(current, received("received"));
    const result = acceptSenderEvent(current, receiverTerminal("completed", "task.completed"), { actor: "receiver", address: RECEIVER }, { artifacts: [artifactProjection(overrides)], warnings: [] });
    expect(result).toMatchObject({ kind: "rejected", code: TASK_API_ERROR.INVALID_TRANSITION });
  });

  test("accepts sender initial-response-loss failures with preserved completion fields", () => {
    const result = acceptSenderEvent(accept(state(), created("created")), senderFailure("sender-failed"), { actor: "sender", address: SENDER }, { artifacts: undefined, warnings: [{ code: "PEER_UNREACHABLE", message: "response lost" }] });
    expect(result).toMatchObject({
      kind: "accepted",
      event: { actor: "sender", type: "task.failed", destination: PARENT, completion: { summary: "initial peer receive failed", error: { code: "PEER_UNREACHABLE", message: "response lost", retryable: true }, artifacts: undefined, warnings: [{ code: "PEER_UNREACHABLE", message: "response lost" }] } },
    });
  });

  test("derives pending cancellation immediately but requires cancel_requested after receipt", () => {
    const immediate = accept(state(), cancelRequested("immediate-cancel"));
    expect(immediate).toMatchObject({ status: "cancelled", completion: undefined });

    let deliveredState = accept(state(), created("created"));
    deliveredState = accept(deliveredState, received("received"));
    deliveredState = accept(deliveredState, cancelRequested("cancel-request"));
    expect(deliveredState).toMatchObject({ status: "cancel_requested", completion: undefined });
    deliveredState = accept(deliveredState, receiverTerminal("cancelled", "task.cancelled"));
    expect(deliveredState).toMatchObject({ status: "cancelled", completion: storedCompletion() });
  });

  test("rejects a foreign terminal before duplicate or late-terminal handling", () => {
    let current = accept(state(), created("created"));
    current = accept(current, received("received"));
    current = accept(current, receiverTerminal("completed", "task.completed"));
    const foreignDuplicate = { ...receiverTerminal("completed", "task.cancelled"), taskId: "018f6b48-4b1c-7000-8000-000000000099" };
    const result = acceptSenderEvent(current, foreignDuplicate, { actor: "receiver", address: RECEIVER }, projection());
    expect(result).toMatchObject({ kind: "rejected", code: TASK_API_ERROR.INVALID_TRANSITION, state: { events: current.events, lateTerminalEventIds: [] } });
  });

  test("preserves first terminal state and uses the bound sender for late-terminal provenance", () => {
    let current = accept(state(), created("created"));
    current = accept(current, received("received"));
    current = accept(current, receiverTerminal("completed", "task.completed"));
    const late = acceptEvent(current, receiverTerminal("cancelled", "task.cancelled"));
    expect(late).toMatchObject({
      kind: "late-terminal",
      event: { type: "task.late_terminal", actor: "sender", source: SENDER, destination: RECEIVER, payload: { kind: "late_terminal", originalType: "task.cancelled", originalEventId: "cancelled" } },
      state: { status: "completed", lateTerminalEventIds: ["cancelled"] },
    });
  });

  test("derives every sender event source from immutable sender authority", () => {
    const current = accept(state(), created("created"));
    const result = acceptSenderEvent(current, timedOut("timeout"), { actor: "sender", address: { ...SENDER } });
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("expected sender timeout");
    expect(result.event.source).toBe(SENDER);
    expect(result.event.destination).toBe(PARENT);
  });

  test("allows only sender-owned timeout and one ordered parent acknowledgement", () => {
    let current = accept(state(), created("created"));
    current = accept(current, timedOut("timeout"));
    expect(acceptEvent(current, parentAcknowledged("direct-ack", "missing"))).toMatchObject({ kind: "rejected", code: TASK_API_ERROR.INVALID_TRANSITION });
    current = accept(current, parentAckPending("ack-pending"));
    expect(current.events.at(-1)).toMatchObject({ destination: RECEIVER });
    current = accept(current, parentAcknowledged("acknowledged", "ack-pending"));
    expect(acceptEvent(current, parentAckPending("ack-pending-2"))).toMatchObject({ kind: "rejected", code: TASK_API_ERROR.INVALID_TRANSITION });
    expect(current.parentAcknowledgedEventId).toBe("acknowledged");
    expect(current.events.at(-1)).toMatchObject({ destination: RECEIVER });
  });

  test("reuses receipts by sender machine plus task id and hash, not sender session", () => {
    const records = [{ source: PARENT, taskId: TASK_ID, assignmentHash: "a".repeat(64), receiptId: "receipt-1" }] as const;
    expect(resolveAssignmentReceipt(records, { source: { machine: PARENT.machine, sessionId: "different-session" }, taskId: TASK_ID, assignmentHash: "a".repeat(64) })).toEqual({ kind: "receipt-reused", receiptId: "receipt-1" });
    expect(resolveAssignmentReceipt(records, { source: { machine: PARENT.machine, sessionId: "different-session" }, taskId: TASK_ID, assignmentHash: "b".repeat(64) })).toMatchObject({ kind: "conflict" });
    expect(resolveAssignmentReceipt(records, { source: RECEIVER, taskId: TASK_ID, assignmentHash: "a".repeat(64) })).toEqual({ kind: "available" });
  });

  test("scopes idempotency to the originating parent address", () => {
    const scope = { machine: "machine-a", sessionId: "parent", key: "send-1" };
    const records = [{ scope, assignmentHash: "a".repeat(64), taskId: TASK_ID }] as const;
    expect(resolveScopedIdempotency(records, scope, "a".repeat(64))).toEqual({ kind: "reused", taskId: TASK_ID });
    expect(resolveScopedIdempotency(records, { ...scope, sessionId: "other-parent" }, "a".repeat(64))).toEqual({ kind: "available" });
  });

  test("measures task payload limits in UTF-8 bytes", () => {
    expect(validateTaskPayloadBounds({ task: "é".repeat(TASK_LIMITS.TASK_BYTES / 2), contextSummary: undefined, assignmentEnvelope: undefined, httpBody: undefined })).toEqual([]);
    const violations = validateTaskPayloadBounds({ task: "é".repeat(TASK_LIMITS.TASK_BYTES / 2 + 1), contextSummary: "x", assignmentEnvelope: { task: "x".repeat(TASK_LIMITS.ASSIGNMENT_ENVELOPE_BYTES) }, httpBody: "x".repeat(TASK_LIMITS.HTTP_BODY_BYTES + 1) });
    expect(violations).toEqual(["task", "assignmentEnvelope", "httpBody"]);
    expect(taskPayloadBoundsError(violations)).toMatchObject({ error: { code: TASK_API_ERROR.PAYLOAD_TOO_LARGE } });
  });
});
