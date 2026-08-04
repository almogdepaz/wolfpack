export const TASK_API_ROUTES = {
  send: "POST /api/tasks/v1/send",
  status: "GET /api/tasks/v1/status",
  inbox: "GET /api/tasks/v1/inbox",
  message: "POST /api/tasks/v1/message",
  complete: "POST /api/tasks/v1/complete",
  cancel: "POST /api/tasks/v1/cancel",
  delivered: "POST /api/tasks/v1/delivered",
  acknowledge: "POST /api/tasks/v1/ack",
  peerReceive: "POST /api/tasks/v1/peer/receive",
  peerEvent: "POST /api/tasks/v1/peer/event",
} as const;

export const TASK_API_ERROR = {
  INVALID_REQUEST: "INVALID_REQUEST",
  INVALID_CONTENT_TYPE: "INVALID_CONTENT_TYPE",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  CALLER_NOT_FOUND: "CALLER_NOT_FOUND",
  TARGET_NOT_FOUND: "TARGET_NOT_FOUND",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  TARGET_DEAD: "TARGET_DEAD",
  TARGET_NOT_PI: "TARGET_NOT_PI",
  PROJECT_MISMATCH: "PROJECT_MISMATCH",
  CALLER_MISMATCH: "CALLER_MISMATCH",
  IMMUTABLE_CONTENT_CONFLICT: "IMMUTABLE_CONTENT_CONFLICT",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  INVALID_REPLY: "INVALID_REPLY",
  OPEN_QUESTION_CONFLICT: "OPEN_QUESTION_CONFLICT",
  PEER_UNREACHABLE: "PEER_UNREACHABLE",
  PEER_AUTH_UNSUPPORTED: "PEER_AUTH_UNSUPPORTED",
  MALFORMED_UPSTREAM_RESPONSE: "MALFORMED_UPSTREAM_RESPONSE",
  STORE_UNAVAILABLE: "STORE_UNAVAILABLE",
} as const;

export const TASK_API_HTTP_STATUS = {
  INVALID_REQUEST: 400,
  INVALID_CONTENT_TYPE: 400,
  PAYLOAD_TOO_LARGE: 413,
  CALLER_NOT_FOUND: 404,
  TARGET_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  TARGET_DEAD: 422,
  TARGET_NOT_PI: 422,
  PROJECT_MISMATCH: 422,
  CALLER_MISMATCH: 409,
  IMMUTABLE_CONTENT_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  INVALID_REPLY: 409,
  OPEN_QUESTION_CONFLICT: 409,
  PEER_UNREACHABLE: 503,
  PEER_AUTH_UNSUPPORTED: 503,
  MALFORMED_UPSTREAM_RESPONSE: 502,
  STORE_UNAVAILABLE: 503,
} as const satisfies Record<keyof typeof TASK_API_ERROR, number>;

export const TASK_EVENT_TYPE = {
  CREATED: "task.created",
  RECEIVED: "task.received",
  RECEIPT_CONFIRMED: "task.receipt_confirmed",
  DELIVERED: "task.delivered",
  QUESTION: "task.question",
  ANSWER: "task.answer",
  INFORMATION: "task.information",
  MESSAGE_DELIVERED: "message.delivered",
  CANCEL_REQUESTED: "task.cancel_requested",
  COMPLETED: "task.completed",
  FAILED: "task.failed",
  CANCELLED: "task.cancelled",
  TIMED_OUT: "task.timed_out",
  PARENT_ACK_PENDING: "task.parent_ack_pending",
  PARENT_ACKNOWLEDGED: "task.parent_acknowledged",
  DELIVERY_FAILED: "event.delivery_failed",
  LATE_TERMINAL: "task.late_terminal",
} as const;

export const TASK_STATUS = {
  PENDING_DELIVERY: "pending_delivery",
  RECEIVED: "received",
  ACTIVE: "active",
  WAITING_FOR_PARENT: "waiting_for_parent",
  WAITING_FOR_RECEIVER: "waiting_for_receiver",
  CANCEL_REQUESTED: "cancel_requested",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out",
} as const;

// Initial limits; benchmark representative task payloads before changing them.
export const TASK_LIMITS = {
  TASK_BYTES: 16 * 1024,
  CONTEXT_SUMMARY_BYTES: 16 * 1024,
  ASSIGNMENT_ENVELOPE_BYTES: 48 * 1024,
  HTTP_BODY_BYTES: 64 * 1024,
  INBOX_PAGE_EVENTS: 50,
  INBOX_PAGE_BYTES: 256 * 1024,
  ARTIFACTS: 20,
} as const;

export type TaskApiErrorCode = (typeof TASK_API_ERROR)[keyof typeof TASK_API_ERROR];
export type TaskEventType = (typeof TASK_EVENT_TYPE)[keyof typeof TASK_EVENT_TYPE];
export type TaskTerminalEventType = "task.completed" | "task.failed" | "task.cancelled" | "task.timed_out";
export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];
export type TaskActor = "parent" | "receiver" | "sender";

export interface TaskAddress {
  readonly machine: string;
  readonly sessionId: string;
}

export interface ContextRef {
  readonly path: string;
  readonly selector: string | undefined;
  readonly purpose: string | undefined;
}

export interface TaskContext {
  readonly summary: string | undefined;
  readonly refs: readonly ContextRef[] | undefined;
}

export interface TaskMetadata {
  readonly phaseId: string | undefined;
  readonly issueId: string | undefined;
  readonly verificationTier: string | undefined;
  readonly rootCause: string | undefined;
}

export interface TaskResultInput {
  readonly summary: string;
  readonly result: Record<string, unknown> | undefined;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | undefined;
  readonly artifacts: readonly ArtifactInput[] | undefined;
  /** Gateway-only warnings belong to StoredTaskCompletion, never peer input. */
  readonly warnings?: never;
}

export interface ArtifactInput {
  readonly path: string;
  readonly mimeType: string | undefined;
  readonly description: string | undefined;
  /** Gateway-derived provenance is forbidden in untrusted completion input. */
  readonly machine?: never;
  readonly project?: never;
}

export interface StoredArtifactRef {
  readonly machine: string;
  readonly project: string;
  readonly path: string;
  readonly mimeType: string | undefined;
  readonly description: string | undefined;
  readonly sizeBytes: number | undefined;
  readonly modifiedAt: string | undefined;
}

export interface ImmutableTaskAssignment {
  readonly taskId: string;
  readonly source: TaskAddress;
  readonly target: TaskAddress;
  readonly task: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly context: TaskContext | undefined;
  readonly preflight?: { readonly requiredProject: string | undefined };
  readonly role: string | undefined;
  readonly metadata: TaskMetadata | undefined;
  readonly onCompletePrompt: string | undefined;
}

export interface TaskApiErrorEnvelope {
  readonly ok: false;
  readonly error: {
    readonly code: TaskApiErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly path?: string;
  };
}

export type TaskEventPayload =
  | { readonly kind: "none" }
  | {
    readonly kind: "receipt_confirmation";
    readonly receiptId: string;
    readonly assignmentHash: string;
    readonly createdEventId: string;
    readonly receivedEventId: string;
    readonly receivedEventSequence: string;
    readonly receivedEventOccurredAt: string;
  }
  | { readonly kind: "parent_ack"; readonly pendingAckEventId: string }
  | { readonly kind: "delivery"; readonly injectedEventId: string }
  | { readonly kind: "delivery_failure"; readonly code: string; readonly message: string }
  | { readonly kind: "late_terminal"; readonly originalType: TaskTerminalEventType; readonly originalEventId: string };

interface TaskEventBase {
  readonly id: string;
  readonly taskId: string;
  readonly occurredAt: string;
}

interface TaskEventFields<
  TType extends TaskEventType,
  TActor extends TaskActor,
  TPayload extends TaskEventPayload,
  TMessage extends string | undefined,
  TReplyToMessageId extends string | undefined,
  TCompletion extends TaskResultInput | undefined,
> extends TaskEventBase {
  readonly type: TType;
  readonly actor: TActor;
  readonly message: TMessage;
  readonly replyToMessageId: TReplyToMessageId;
  readonly payload: TPayload;
  readonly completion: TCompletion;
}

type NonePayload = { readonly kind: "none" };
type ReceiptConfirmationPayload = Extract<TaskEventPayload, { readonly kind: "receipt_confirmation" }>;
type ParentAcknowledgementPayload = Extract<TaskEventPayload, { readonly kind: "parent_ack" }>;
type DeliveryPayload = Extract<TaskEventPayload, { readonly kind: "delivery" }>;
type DeliveryFailurePayload = Extract<TaskEventPayload, { readonly kind: "delivery_failure" }>;
type LateTerminalPayload = Extract<TaskEventPayload, { readonly kind: "late_terminal" }>;

type TaskCreatedEventInput = TaskEventFields<"task.created", "parent", NonePayload, undefined, undefined, undefined>;
type TaskReceivedEventInput = TaskEventFields<"task.received", "receiver", NonePayload, undefined, undefined, undefined>;
type TaskReceiptConfirmedEventInput = TaskEventFields<"task.receipt_confirmed", "sender", ReceiptConfirmationPayload, undefined, undefined, undefined>;
type TaskDeliveredEventInput = TaskEventFields<"task.delivered", "receiver", DeliveryPayload, undefined, undefined, undefined>;
type TaskQuestionEventInput = TaskEventFields<"task.question", "parent" | "receiver", NonePayload, string, undefined, undefined>;
type TaskAnswerEventInput = TaskEventFields<"task.answer", "parent" | "receiver", NonePayload, string, string, undefined>;
type TaskInformationEventInput = TaskEventFields<"task.information", "parent" | "receiver", NonePayload, string, undefined, undefined>;
type MessageDeliveredEventInput = TaskEventFields<"message.delivered", "receiver", DeliveryPayload, undefined, undefined, undefined>;
type TaskCancelRequestedEventInput = TaskEventFields<"task.cancel_requested", "parent", NonePayload, undefined, undefined, undefined>;
type TaskCompletedEventInput = TaskEventFields<"task.completed", "receiver", NonePayload, undefined, undefined, TaskResultInput>;
type TaskFailedByReceiverEventInput = TaskEventFields<"task.failed", "receiver", NonePayload, undefined, undefined, TaskResultInput>;
type TaskFailedBySenderEventInput = TaskEventFields<"task.failed", "sender", NonePayload, undefined, undefined, TaskResultInput>;
type TaskCancelledByReceiverEventInput = TaskEventFields<"task.cancelled", "receiver", NonePayload, undefined, undefined, TaskResultInput>;
type TaskTimedOutEventInput = TaskEventFields<"task.timed_out", "sender", NonePayload, undefined, undefined, undefined>;
type TaskParentAckPendingEventInput = TaskEventFields<"task.parent_ack_pending", "sender", NonePayload, undefined, undefined, undefined>;
type TaskParentAcknowledgedEventInput = TaskEventFields<"task.parent_acknowledged", "sender", ParentAcknowledgementPayload, undefined, string, undefined>;
type DeliveryFailedEventInput = TaskEventFields<"event.delivery_failed", "sender", DeliveryFailurePayload, undefined, undefined, undefined>;
export type TaskEventInput =
  | TaskCreatedEventInput
  | TaskReceivedEventInput
  | TaskReceiptConfirmedEventInput
  | TaskDeliveredEventInput
  | TaskQuestionEventInput
  | TaskAnswerEventInput
  | TaskInformationEventInput
  | MessageDeliveredEventInput
  | TaskCancelRequestedEventInput
  | TaskCompletedEventInput
  | TaskFailedByReceiverEventInput
  | TaskFailedBySenderEventInput
  | TaskCancelledByReceiverEventInput
  | TaskTimedOutEventInput
  | TaskParentAckPendingEventInput
  | TaskParentAcknowledgedEventInput
  | DeliveryFailedEventInput;

type ResultBearingTerminalTaskEventInput = TaskCompletedEventInput | TaskFailedByReceiverEventInput | TaskFailedBySenderEventInput | TaskCancelledByReceiverEventInput;
type NonResultTaskEventInput =
  | TaskCreatedEventInput
  | TaskReceivedEventInput
  | TaskReceiptConfirmedEventInput
  | TaskDeliveredEventInput
  | TaskQuestionEventInput
  | TaskAnswerEventInput
  | TaskInformationEventInput
  | MessageDeliveredEventInput
  | TaskCancelRequestedEventInput
  | TaskTimedOutEventInput
  | TaskParentAckPendingEventInput
  | TaskParentAcknowledgedEventInput
  | DeliveryFailedEventInput;

interface CanonicalEventFields {
  readonly source: TaskAddress;
  readonly destination: TaskAddress;
  readonly sequence: string;
}

type CanonicalTaskEventFor<TInput extends TaskEventInput, TCompletion extends StoredTaskCompletion | undefined> = Omit<TInput, "completion"> & CanonicalEventFields & { readonly completion: TCompletion };
type CanonicalLateTerminalEvent = Omit<TaskEventFields<"task.late_terminal", "sender", LateTerminalPayload, undefined, undefined, undefined>, "completion"> & CanonicalEventFields;

export type CanonicalTaskEvent =
  | CanonicalTaskEventFor<TaskCreatedEventInput, undefined>
  | CanonicalTaskEventFor<TaskReceivedEventInput, undefined>
  | CanonicalTaskEventFor<TaskReceiptConfirmedEventInput, undefined>
  | CanonicalTaskEventFor<TaskDeliveredEventInput, undefined>
  | CanonicalTaskEventFor<TaskQuestionEventInput, undefined>
  | CanonicalTaskEventFor<TaskAnswerEventInput, undefined>
  | CanonicalTaskEventFor<TaskInformationEventInput, undefined>
  | CanonicalTaskEventFor<MessageDeliveredEventInput, undefined>
  | CanonicalTaskEventFor<TaskCancelRequestedEventInput, undefined>
  | CanonicalTaskEventFor<TaskCompletedEventInput, StoredTaskCompletion>
  | CanonicalTaskEventFor<TaskFailedByReceiverEventInput, StoredTaskCompletion>
  | CanonicalTaskEventFor<TaskFailedBySenderEventInput, StoredTaskCompletion>
  | CanonicalTaskEventFor<TaskCancelledByReceiverEventInput, StoredTaskCompletion>
  | CanonicalTaskEventFor<TaskTimedOutEventInput, undefined>
  | CanonicalTaskEventFor<TaskParentAckPendingEventInput, undefined>
  | CanonicalTaskEventFor<TaskParentAcknowledgedEventInput, undefined>
  | CanonicalTaskEventFor<DeliveryFailedEventInput, undefined>
  | CanonicalLateTerminalEvent;

type AcceptedCanonicalTaskEvent = Exclude<CanonicalTaskEvent, CanonicalLateTerminalEvent>;

export interface VerifiedTaskPrincipal {
  readonly actor: TaskActor;
  readonly address: TaskAddress;
}

export interface TaskWarning {
  readonly code: string;
  readonly message: string;
}

export interface StoredTaskCompletion {
  readonly summary: string;
  readonly result: Record<string, unknown> | undefined;
  readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean } | undefined;
  readonly artifacts: readonly StoredArtifactRef[] | undefined;
  readonly warnings: readonly TaskWarning[];
}

export interface TaskParticipants {
  readonly parent: TaskAddress;
  readonly receiver: TaskAddress;
  /** Immutable gateway identity; caller input can never select it. */
  readonly sender: TaskAddress;
}

/** Gateway-derived enrichment for a terminal result; receiver fields remain immutable. */
export interface TaskArtifactProjection {
  readonly sourcePath: string;
  readonly machine: string;
  readonly project: string;
  readonly normalizedPath: string;
  readonly sizeBytes: number | undefined;
  readonly modifiedAt: string | undefined;
}

export interface TaskCompletionProjection {
  readonly artifacts: readonly TaskArtifactProjection[] | undefined;
  readonly warnings: readonly TaskWarning[];
  readonly summary?: never;
  readonly result?: never;
  readonly error?: never;
}

export interface TaskStateSnapshot {
  readonly taskId: string;
  readonly participants: TaskParticipants;
  readonly status: TaskStatus;
  readonly nextTaskSequence: string;
  readonly events: readonly CanonicalTaskEvent[];
  readonly openQuestionEventId: string | undefined;
  readonly terminalEventId: string | undefined;
  readonly pendingParentAckEventId: string | undefined;
  readonly parentAcknowledgedEventId: string | undefined;
  readonly lateTerminalEventIds: readonly string[];
  readonly completion: StoredTaskCompletion | undefined;
  readonly warnings: readonly TaskWarning[];
}

export type SenderEventAcceptance =
  | {
    readonly kind: "accepted";
    readonly event: CanonicalTaskEvent;
    readonly state: TaskStateSnapshot;
  }
  | {
    readonly kind: "duplicate";
    readonly acknowledgedEventId: string;
    readonly state: TaskStateSnapshot;
  }
  | {
    readonly kind: "late-terminal";
    readonly event: CanonicalTaskEvent;
    readonly state: TaskStateSnapshot;
  }
  | {
    readonly kind: "rejected";
    readonly code: typeof TASK_API_ERROR.CALLER_MISMATCH | typeof TASK_API_ERROR.INVALID_REPLY | typeof TASK_API_ERROR.INVALID_TRANSITION | typeof TASK_API_ERROR.OPEN_QUESTION_CONFLICT;
    readonly state: TaskStateSnapshot;
  };

export interface LocalDeliverySequence {
  readonly sequence: string;
  readonly nextSequence: string;
}

export interface TaskPayloadBoundsInput {
  readonly task: string | undefined;
  readonly contextSummary: string | undefined;
  readonly assignmentEnvelope: unknown;
  readonly httpBody: unknown;
}

export type TaskPayloadBoundViolation = "task" | "contextSummary" | "assignmentEnvelope" | "httpBody";

export interface AssignmentReceiptRecord {
  readonly source: TaskAddress;
  readonly taskId: string;
  readonly assignmentHash: string;
  readonly receiptId: string;
}

export interface AssignmentReceiptAttempt {
  readonly source: TaskAddress;
  readonly taskId: string;
  readonly assignmentHash: string;
}

export type AssignmentReceiptResolution =
  | { readonly kind: "available" }
  | { readonly kind: "receipt-reused"; readonly receiptId: string }
  | { readonly kind: "conflict"; readonly code: typeof TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT };

export interface IdempotencyScope {
  readonly machine: string;
  readonly sessionId: string;
  readonly key: string;
}

export interface ScopedIdempotencyRecord {
  readonly scope: IdempotencyScope;
  readonly assignmentHash: string;
  readonly taskId: string;
}

export type ScopedIdempotencyResolution =
  | { readonly kind: "available" }
  | { readonly kind: "reused"; readonly taskId: string }
  | { readonly kind: "conflict"; readonly code: typeof TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT };

type JsonValue =
  | boolean
  | null
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const ACTORS_BY_EVENT_TYPE: Readonly<Record<TaskEventType, readonly TaskActor[]>> = {
  [TASK_EVENT_TYPE.CREATED]: ["parent"],
  [TASK_EVENT_TYPE.RECEIVED]: ["receiver"],
  [TASK_EVENT_TYPE.RECEIPT_CONFIRMED]: ["sender"],
  [TASK_EVENT_TYPE.DELIVERED]: ["receiver"],
  [TASK_EVENT_TYPE.QUESTION]: ["parent", "receiver"],
  [TASK_EVENT_TYPE.ANSWER]: ["parent", "receiver"],
  [TASK_EVENT_TYPE.INFORMATION]: ["parent", "receiver"],
  [TASK_EVENT_TYPE.MESSAGE_DELIVERED]: ["receiver"],
  [TASK_EVENT_TYPE.CANCEL_REQUESTED]: ["parent"],
  [TASK_EVENT_TYPE.COMPLETED]: ["receiver"],
  [TASK_EVENT_TYPE.FAILED]: ["receiver", "sender"],
  [TASK_EVENT_TYPE.CANCELLED]: ["receiver"],
  [TASK_EVENT_TYPE.TIMED_OUT]: ["sender"],
  [TASK_EVENT_TYPE.PARENT_ACK_PENDING]: ["sender"],
  [TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED]: ["sender"],
  [TASK_EVENT_TYPE.DELIVERY_FAILED]: ["sender"],
  [TASK_EVENT_TYPE.LATE_TERMINAL]: ["sender"],
};

const ALLOWED_EVENT_TYPES: Readonly<Record<TaskStatus, readonly TaskEventType[]>> = {
  [TASK_STATUS.PENDING_DELIVERY]: [
    TASK_EVENT_TYPE.CREATED,
    TASK_EVENT_TYPE.RECEIVED,
    TASK_EVENT_TYPE.CANCEL_REQUESTED,
    TASK_EVENT_TYPE.FAILED,
    TASK_EVENT_TYPE.TIMED_OUT,
  ],
  [TASK_STATUS.RECEIVED]: [
    TASK_EVENT_TYPE.RECEIPT_CONFIRMED,
    TASK_EVENT_TYPE.DELIVERED,
    TASK_EVENT_TYPE.QUESTION,
    TASK_EVENT_TYPE.INFORMATION,
    TASK_EVENT_TYPE.MESSAGE_DELIVERED,
    TASK_EVENT_TYPE.CANCEL_REQUESTED,
    TASK_EVENT_TYPE.COMPLETED,
    TASK_EVENT_TYPE.FAILED,
    TASK_EVENT_TYPE.CANCELLED,
    TASK_EVENT_TYPE.TIMED_OUT,
    TASK_EVENT_TYPE.PARENT_ACK_PENDING,
    TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED,
    TASK_EVENT_TYPE.DELIVERY_FAILED,
  ],
  [TASK_STATUS.ACTIVE]: [
    TASK_EVENT_TYPE.DELIVERED,
    TASK_EVENT_TYPE.QUESTION,
    TASK_EVENT_TYPE.ANSWER,
    TASK_EVENT_TYPE.INFORMATION,
    TASK_EVENT_TYPE.MESSAGE_DELIVERED,
    TASK_EVENT_TYPE.CANCEL_REQUESTED,
    TASK_EVENT_TYPE.COMPLETED,
    TASK_EVENT_TYPE.FAILED,
    TASK_EVENT_TYPE.CANCELLED,
    TASK_EVENT_TYPE.TIMED_OUT,
    TASK_EVENT_TYPE.PARENT_ACK_PENDING,
    TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED,
    TASK_EVENT_TYPE.DELIVERY_FAILED,
  ],
  [TASK_STATUS.WAITING_FOR_PARENT]: [
    TASK_EVENT_TYPE.DELIVERED,
    TASK_EVENT_TYPE.ANSWER,
    TASK_EVENT_TYPE.INFORMATION,
    TASK_EVENT_TYPE.MESSAGE_DELIVERED,
    TASK_EVENT_TYPE.CANCEL_REQUESTED,
    TASK_EVENT_TYPE.COMPLETED,
    TASK_EVENT_TYPE.FAILED,
    TASK_EVENT_TYPE.CANCELLED,
    TASK_EVENT_TYPE.TIMED_OUT,
    TASK_EVENT_TYPE.DELIVERY_FAILED,
  ],
  [TASK_STATUS.WAITING_FOR_RECEIVER]: [
    TASK_EVENT_TYPE.DELIVERED,
    TASK_EVENT_TYPE.ANSWER,
    TASK_EVENT_TYPE.INFORMATION,
    TASK_EVENT_TYPE.MESSAGE_DELIVERED,
    TASK_EVENT_TYPE.CANCEL_REQUESTED,
    TASK_EVENT_TYPE.COMPLETED,
    TASK_EVENT_TYPE.FAILED,
    TASK_EVENT_TYPE.CANCELLED,
    TASK_EVENT_TYPE.TIMED_OUT,
    TASK_EVENT_TYPE.DELIVERY_FAILED,
  ],
  [TASK_STATUS.CANCEL_REQUESTED]: [
    TASK_EVENT_TYPE.DELIVERED,
    TASK_EVENT_TYPE.INFORMATION,
    TASK_EVENT_TYPE.MESSAGE_DELIVERED,
    TASK_EVENT_TYPE.COMPLETED,
    TASK_EVENT_TYPE.FAILED,
    TASK_EVENT_TYPE.CANCELLED,
    TASK_EVENT_TYPE.TIMED_OUT,
    TASK_EVENT_TYPE.DELIVERY_FAILED,
  ],
  [TASK_STATUS.COMPLETED]: [
    TASK_EVENT_TYPE.DELIVERED,
    TASK_EVENT_TYPE.INFORMATION,
    TASK_EVENT_TYPE.MESSAGE_DELIVERED,
    TASK_EVENT_TYPE.PARENT_ACK_PENDING,
    TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED,
    TASK_EVENT_TYPE.DELIVERY_FAILED,
  ],
  [TASK_STATUS.FAILED]: [
    TASK_EVENT_TYPE.DELIVERED,
    TASK_EVENT_TYPE.INFORMATION,
    TASK_EVENT_TYPE.MESSAGE_DELIVERED,
    TASK_EVENT_TYPE.PARENT_ACK_PENDING,
    TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED,
    TASK_EVENT_TYPE.DELIVERY_FAILED,
  ],
  [TASK_STATUS.CANCELLED]: [
    TASK_EVENT_TYPE.DELIVERED,
    TASK_EVENT_TYPE.INFORMATION,
    TASK_EVENT_TYPE.MESSAGE_DELIVERED,
    TASK_EVENT_TYPE.PARENT_ACK_PENDING,
    TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED,
    TASK_EVENT_TYPE.DELIVERY_FAILED,
  ],
  [TASK_STATUS.TIMED_OUT]: [
    TASK_EVENT_TYPE.DELIVERED,
    TASK_EVENT_TYPE.INFORMATION,
    TASK_EVENT_TYPE.MESSAGE_DELIVERED,
    TASK_EVENT_TYPE.PARENT_ACK_PENDING,
    TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED,
    TASK_EVENT_TYPE.DELIVERY_FAILED,
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical task JSON cannot contain a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(stableJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, stableJson(value[key])]),
    );
  }
  throw new TypeError("canonical task JSON accepts only JSON values");
}

function incrementDecimal(sequence: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(sequence)) throw new TypeError("sequence must be a decimal integer");
  return (BigInt(sequence) + 1n).toString();
}

function withEvent(state: TaskStateSnapshot, event: CanonicalTaskEvent, changes: Partial<TaskStateSnapshot> = {}): TaskStateSnapshot {
  return {
    ...state,
    ...changes,
    nextTaskSequence: incrementDecimal(event.sequence),
    events: [...state.events, event],
  };
}

function sameAddress(left: TaskAddress, right: TaskAddress): boolean {
  return left.machine === right.machine && left.sessionId === right.sessionId;
}

function hasVerifiedAuthority(state: TaskStateSnapshot, event: TaskEventInput, principal: VerifiedTaskPrincipal): boolean {
  if (event.actor !== principal.actor) return false;
  if (event.actor === "sender") return sameAddress(principal.address, state.participants.sender);
  const source = event.actor === "parent" ? state.participants.parent : state.participants.receiver;
  return sameAddress(principal.address, source);
}

function destinationFor(state: TaskStateSnapshot, event: TaskEventInput | AcceptedCanonicalTaskEvent): TaskAddress {
  if (event.actor === "parent") return state.participants.receiver;
  if (event.actor === "receiver" || isTerminalEventType(event.type)) return state.participants.parent;
  return state.participants.receiver;
}

function isCoherentEvent(input: TaskEventInput | AcceptedCanonicalTaskEvent): boolean {
  switch (input.type) {
    case TASK_EVENT_TYPE.QUESTION:
    case TASK_EVENT_TYPE.INFORMATION:
      return input.payload.kind === "none" && input.message !== undefined && input.replyToMessageId === undefined;
    case TASK_EVENT_TYPE.ANSWER:
      return input.payload.kind === "none" && input.message !== undefined && input.replyToMessageId !== undefined;
    case TASK_EVENT_TYPE.COMPLETED:
    case TASK_EVENT_TYPE.FAILED:
      return input.payload.kind === "none" && input.completion !== undefined;
    case TASK_EVENT_TYPE.CANCELLED:
      return input.payload.kind === "none" && input.completion !== undefined;
    case TASK_EVENT_TYPE.RECEIPT_CONFIRMED:
      return input.payload.kind === "receipt_confirmation";
    case TASK_EVENT_TYPE.DELIVERED:
    case TASK_EVENT_TYPE.MESSAGE_DELIVERED:
      return input.payload.kind === "delivery" && input.payload.injectedEventId.length > 0;
    case TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED:
      return input.payload.kind === "parent_ack" && input.replyToMessageId === input.payload.pendingAckEventId;
    case TASK_EVENT_TYPE.DELIVERY_FAILED:
      return input.payload.kind === "delivery_failure";
    default:
      return input.payload.kind === "none" && input.message === undefined && input.completion === undefined;
  }
}

function isTerminalEventType(type: TaskEventType): type is TaskTerminalEventType {
  return type === TASK_EVENT_TYPE.COMPLETED
    || type === TASK_EVENT_TYPE.FAILED
    || type === TASK_EVENT_TYPE.CANCELLED
    || type === TASK_EVENT_TYPE.TIMED_OUT;
}

function isTerminal(status: TaskStatus): boolean {
  return status === TASK_STATUS.COMPLETED
    || status === TASK_STATUS.FAILED
    || status === TASK_STATUS.CANCELLED
    || status === TASK_STATUS.TIMED_OUT;
}

function nextStatusForEvent(state: TaskStateSnapshot, event: TaskEventInput | AcceptedCanonicalTaskEvent): TaskStatus {
  switch (event.type) {
    case TASK_EVENT_TYPE.RECEIVED:
    case TASK_EVENT_TYPE.RECEIPT_CONFIRMED:
      return TASK_STATUS.RECEIVED;
    case TASK_EVENT_TYPE.DELIVERED:
      return state.status === TASK_STATUS.RECEIVED ? TASK_STATUS.ACTIVE : state.status;
    case TASK_EVENT_TYPE.QUESTION:
      return event.actor === "receiver" ? TASK_STATUS.WAITING_FOR_PARENT : TASK_STATUS.WAITING_FOR_RECEIVER;
    case TASK_EVENT_TYPE.ANSWER:
      return TASK_STATUS.ACTIVE;
    case TASK_EVENT_TYPE.CANCEL_REQUESTED:
      return state.status === TASK_STATUS.PENDING_DELIVERY ? TASK_STATUS.CANCELLED : TASK_STATUS.CANCEL_REQUESTED;
    case TASK_EVENT_TYPE.COMPLETED:
      return TASK_STATUS.COMPLETED;
    case TASK_EVENT_TYPE.FAILED:
      return TASK_STATUS.FAILED;
    case TASK_EVENT_TYPE.CANCELLED:
      return TASK_STATUS.CANCELLED;
    case TASK_EVENT_TYPE.TIMED_OUT:
      return TASK_STATUS.TIMED_OUT;
    default:
      return state.status;
  }
}

function validateTransition(state: TaskStateSnapshot, event: TaskEventInput | AcceptedCanonicalTaskEvent): "accepted" | typeof TASK_API_ERROR.INVALID_REPLY | typeof TASK_API_ERROR.OPEN_QUESTION_CONFLICT | typeof TASK_API_ERROR.INVALID_TRANSITION {
  if (event.taskId !== state.taskId) return TASK_API_ERROR.INVALID_TRANSITION;
  if (event.type === TASK_EVENT_TYPE.QUESTION && state.openQuestionEventId !== undefined) {
    return TASK_API_ERROR.OPEN_QUESTION_CONFLICT;
  }
  if (!ALLOWED_EVENT_TYPES[state.status].includes(event.type)) {
    return TASK_API_ERROR.INVALID_TRANSITION;
  }
  if (event.type === TASK_EVENT_TYPE.ANSWER) {
    const question = state.events.find((candidate) => candidate.id === state.openQuestionEventId);
    if (event.replyToMessageId !== state.openQuestionEventId || question?.actor === event.actor) {
      return TASK_API_ERROR.INVALID_REPLY;
    }
  }
  if ((event.type === TASK_EVENT_TYPE.DELIVERED || event.type === TASK_EVENT_TYPE.MESSAGE_DELIVERED)
    && (event.payload.kind !== "delivery" || !state.events.some((candidate) => candidate.id === event.payload.injectedEventId
      && candidate.destination.sessionId === state.participants.receiver.sessionId))) {
    return TASK_API_ERROR.INVALID_TRANSITION;
  }
  if (event.type === TASK_EVENT_TYPE.PARENT_ACK_PENDING
    && (!isTerminal(state.status) || state.pendingParentAckEventId !== undefined || state.parentAcknowledgedEventId !== undefined)) {
    return TASK_API_ERROR.INVALID_TRANSITION;
  }
  if (event.type === TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED
    && (state.pendingParentAckEventId === undefined || state.parentAcknowledgedEventId !== undefined
      || event.replyToMessageId !== state.pendingParentAckEventId || event.payload.kind !== "parent_ack"
      || event.payload.pendingAckEventId !== state.pendingParentAckEventId)) {
    return TASK_API_ERROR.INVALID_TRANSITION;
  }
  return "accepted";
}

export function createTaskState(taskId: string, participants: TaskParticipants): TaskStateSnapshot {
  return {
    taskId,
    participants,
    status: TASK_STATUS.PENDING_DELIVERY,
    nextTaskSequence: "1",
    events: [],
    openQuestionEventId: undefined,
    terminalEventId: undefined,
    pendingParentAckEventId: undefined,
    parentAcknowledgedEventId: undefined,
    lateTerminalEventIds: [],
    completion: undefined,
    warnings: [],
  };
}

function hasValidCompletionProjection(input: ResultBearingTerminalTaskEventInput, projection: TaskCompletionProjection): boolean {
  if (projection.artifacts === undefined) return true;
  if (projection.artifacts.length > TASK_LIMITS.ARTIFACTS) return false;
  const sourcePaths = new Set<string>();
  return projection.artifacts.every((artifact) => {
    if (typeof artifact.sourcePath !== "string" || artifact.sourcePath.length === 0 || sourcePaths.has(artifact.sourcePath)) return false;
    sourcePaths.add(artifact.sourcePath);
    return input.completion.artifacts?.some((candidate) => candidate.path === artifact.sourcePath) === true
      && typeof artifact.machine === "string" && artifact.machine.length > 0
      && typeof artifact.project === "string" && artifact.project.length > 0
      && typeof artifact.normalizedPath === "string" && artifact.normalizedPath.length > 0
      && (artifact.sizeBytes === undefined || (Number.isInteger(artifact.sizeBytes) && artifact.sizeBytes >= 0))
      && (artifact.modifiedAt === undefined || typeof artifact.modifiedAt === "string");
  });
}

function canonicalizeCompletion(input: ResultBearingTerminalTaskEventInput, projection: TaskCompletionProjection): StoredTaskCompletion {
  const artifacts = projection.artifacts?.map((artifact) => {
    const sourceArtifact = input.completion.artifacts?.find((candidate) => candidate.path === artifact.sourcePath);
    if (!sourceArtifact) throw new TypeError("gateway artifact projection must reference an input artifact");
    return {
      machine: artifact.machine,
      project: artifact.project,
      path: artifact.normalizedPath,
      mimeType: sourceArtifact.mimeType,
      description: sourceArtifact.description,
      sizeBytes: artifact.sizeBytes,
      modifiedAt: artifact.modifiedAt,
    };
  });
  return { summary: input.completion.summary, result: input.completion.result, error: input.completion.error, artifacts, warnings: projection.warnings };
}

function canonicalizeEvent(
  input: TaskEventInput,
  principal: VerifiedTaskPrincipal,
  destination: TaskAddress,
  sequence: string,
  projection: TaskCompletionProjection | undefined,
): AcceptedCanonicalTaskEvent {
  if (input.type === TASK_EVENT_TYPE.COMPLETED || input.type === TASK_EVENT_TYPE.FAILED || input.type === TASK_EVENT_TYPE.CANCELLED) {
    if (!projection) throw new TypeError("terminal events require gateway completion projection");
    return { ...input, completion: canonicalizeCompletion(input, projection), source: principal.address, destination, sequence };
  }
  return { ...input, source: principal.address, destination, sequence };
}

function applyCanonicalTaskEvent(state: TaskStateSnapshot, event: CanonicalTaskEvent): TaskStateSnapshot {
  const acceptedEvent = event.type === TASK_EVENT_TYPE.LATE_TERMINAL ? undefined : event;
  const status = acceptedEvent === undefined ? state.status : nextStatusForEvent(state, acceptedEvent);
  const openQuestionEventId = event.type === TASK_EVENT_TYPE.QUESTION
    ? event.id
    : event.type === TASK_EVENT_TYPE.ANSWER
      ? undefined
      : state.openQuestionEventId;
  const terminalEventId = isTerminalEventType(event.type) || (event.type === TASK_EVENT_TYPE.CANCEL_REQUESTED && status === TASK_STATUS.CANCELLED)
    ? event.id
    : state.terminalEventId;
  const pendingParentAckEventId = event.type === TASK_EVENT_TYPE.PARENT_ACK_PENDING
    ? event.id
    : state.pendingParentAckEventId;
  const parentAcknowledgedEventId = event.type === TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED
    ? event.id
    : state.parentAcknowledgedEventId;

  return withEvent(state, event, {
    status,
    openQuestionEventId,
    terminalEventId,
    pendingParentAckEventId,
    parentAcknowledgedEventId,
    completion: acceptedEvent?.completion ?? state.completion,
    warnings: acceptedEvent?.completion?.warnings ?? state.warnings,
  });
}

/** Replays validated canonical ledger events; malformed history is rejected by the caller. */
export function rebuildTaskState(
  taskId: string,
  participants: TaskParticipants,
  events: readonly CanonicalTaskEvent[],
): TaskStateSnapshot {
  let state = createTaskState(taskId, participants);
  for (const event of events) {
    if (event.taskId !== taskId || event.sequence !== state.nextTaskSequence) {
      throw new TypeError("canonical task ledger event has an invalid task id or sequence");
    }
    if (event.type === TASK_EVENT_TYPE.LATE_TERMINAL) {
      if (!isTerminal(state.status) || !sameAddress(event.source, participants.sender) || !sameAddress(event.destination, participants.receiver)) {
        throw new TypeError("canonical late-terminal event has invalid provenance");
      }
      state = applyCanonicalTaskEvent(state, event);
      continue;
    }

    const expectedSource = event.actor === "parent"
      ? participants.parent
      : event.actor === "receiver"
        ? participants.receiver
        : participants.sender;
    if (!sameAddress(event.source, expectedSource) || !sameAddress(event.destination, destinationFor(state, event))
      || !isCoherentEvent(event) || !ACTORS_BY_EVENT_TYPE[event.type].includes(event.actor)) {
      throw new TypeError("canonical task ledger event has invalid authority or shape");
    }
    if (validateTransition(state, event) !== "accepted") {
      throw new TypeError("canonical task ledger event has an invalid transition");
    }
    state = applyCanonicalTaskEvent(state, event);
  }
  return state;
}

export function acceptSenderEvent(
  state: TaskStateSnapshot,
  input: TaskEventInput,
  principal: VerifiedTaskPrincipal,
  projection?: TaskCompletionProjection,
): SenderEventAcceptance;
export function acceptSenderEvent(
  state: TaskStateSnapshot,
  input: ResultBearingTerminalTaskEventInput,
  principal: VerifiedTaskPrincipal,
  projection: TaskCompletionProjection,
): SenderEventAcceptance;
export function acceptSenderEvent(
  state: TaskStateSnapshot,
  input: NonResultTaskEventInput,
  principal: VerifiedTaskPrincipal,
): SenderEventAcceptance;
export function acceptSenderEvent(
  state: TaskStateSnapshot,
  input: TaskEventInput,
  principal: VerifiedTaskPrincipal,
  projection: TaskCompletionProjection | undefined = undefined,
): SenderEventAcceptance {
  if (!isCoherentEvent(input) || !ACTORS_BY_EVENT_TYPE[input.type].includes(input.actor) || !hasVerifiedAuthority(state, input, principal)) {
    return { kind: "rejected", code: TASK_API_ERROR.CALLER_MISMATCH, state };
  }
  if (input.taskId !== state.taskId) return { kind: "rejected", code: TASK_API_ERROR.INVALID_TRANSITION, state };
  const duplicate = state.events.find((event) => event.id === input.id);
  if (duplicate) return { kind: "duplicate", acknowledgedEventId: duplicate.id, state };

  if (isTerminalEventType(input.type) && isTerminal(state.status)) {
    const lateTerminalEvent: CanonicalTaskEvent = {
      id: input.id,
      taskId: input.taskId,
      type: TASK_EVENT_TYPE.LATE_TERMINAL,
      actor: "sender",
      source: state.participants.sender,
      destination: state.participants.receiver,
      sequence: state.nextTaskSequence,
      occurredAt: input.occurredAt,
      message: undefined,
      replyToMessageId: undefined,
      payload: {
        kind: "late_terminal",
        originalType: input.type,
        originalEventId: input.id,
      },
    };
    return {
      kind: "late-terminal",
      event: lateTerminalEvent,
      state: withEvent(state, lateTerminalEvent, { lateTerminalEventIds: [...state.lateTerminalEventIds, input.id] }),
    };
  }

  const validation = validateTransition(state, input);
  if (validation !== "accepted") return { kind: "rejected", code: validation, state };

  const requiresCompletionProjection = input.type === TASK_EVENT_TYPE.COMPLETED || input.type === TASK_EVENT_TYPE.FAILED || input.type === TASK_EVENT_TYPE.CANCELLED;
  if (requiresCompletionProjection && (projection === undefined || !hasValidCompletionProjection(input, projection))) {
    return { kind: "rejected", code: TASK_API_ERROR.INVALID_TRANSITION, state };
  }
  const source = input.actor === "sender" ? state.participants.sender : principal.address;
  const event = canonicalizeEvent(input, { ...principal, address: source }, destinationFor(state, input), state.nextTaskSequence, projection);

  return {
    kind: "accepted",
    event,
    state: applyCanonicalTaskEvent(state, event),
  };
}

export function allocateLocalDeliverySequence(lastObservedSequence: string): LocalDeliverySequence {
  const sequence = incrementDecimal(lastObservedSequence);
  return { sequence, nextSequence: incrementDecimal(sequence) };
}

function utf8ByteLength(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized === undefined) return 0;
  return new TextEncoder().encode(serialized).byteLength;
}

export function validateTaskPayloadBounds(input: TaskPayloadBoundsInput): readonly TaskPayloadBoundViolation[] {
  const violations: TaskPayloadBoundViolation[] = [];
  if (input.task !== undefined && utf8ByteLength(input.task) > TASK_LIMITS.TASK_BYTES) violations.push("task");
  if (input.contextSummary !== undefined && utf8ByteLength(input.contextSummary) > TASK_LIMITS.CONTEXT_SUMMARY_BYTES) {
    violations.push("contextSummary");
  }
  if (input.assignmentEnvelope !== undefined && utf8ByteLength(input.assignmentEnvelope) > TASK_LIMITS.ASSIGNMENT_ENVELOPE_BYTES) {
    violations.push("assignmentEnvelope");
  }
  if (input.httpBody !== undefined && utf8ByteLength(input.httpBody) > TASK_LIMITS.HTTP_BODY_BYTES) violations.push("httpBody");
  return violations;
}

export function taskPayloadBoundsError(violations: readonly TaskPayloadBoundViolation[]): TaskApiErrorEnvelope | undefined {
  if (violations.length === 0) return undefined;
  return {
    ok: false,
    error: {
      code: TASK_API_ERROR.PAYLOAD_TOO_LARGE,
      message: "task payload exceeds UTF-8 byte limits",
      retryable: false,
    },
  };
}

export function resolveAssignmentReceipt(
  records: readonly AssignmentReceiptRecord[],
  attempt: AssignmentReceiptAttempt,
): AssignmentReceiptResolution {
  const existing = records.find((record) => record.taskId === attempt.taskId && record.source.machine === attempt.source.machine);
  if (!existing) return { kind: "available" };
  if (existing.assignmentHash === attempt.assignmentHash) {
    return { kind: "receipt-reused", receiptId: existing.receiptId };
  }
  return { kind: "conflict", code: TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT };
}

export function resolveScopedIdempotency(
  records: readonly ScopedIdempotencyRecord[],
  scope: IdempotencyScope,
  assignmentHash: string,
): ScopedIdempotencyResolution {
  const existing = records.find((record) => record.scope.machine === scope.machine
    && record.scope.sessionId === scope.sessionId
    && record.scope.key === scope.key);
  if (!existing) return { kind: "available" };
  if (existing.assignmentHash === assignmentHash) return { kind: "reused", taskId: existing.taskId };
  return { kind: "conflict", code: TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT };
}

export function generateUuidV7(timestampMs: number = Date.now()): string {
  if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs > 0xffff_ffff_ffff) {
    throw new RangeError("UUIDv7 timestamp must be a 48-bit integer millisecond value");
  }
  const random = crypto.getRandomValues(new Uint8Array(10));
  const randomHex = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const timestamp = timestampMs.toString(16).padStart(12, "0");
  const variant = (Number.parseInt(randomHex[3] ?? "0", 16) & 0x3 | 0x8).toString(16);

  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${randomHex.slice(0, 3)}-${variant}${randomHex.slice(4, 7)}-${randomHex.slice(7, 19)}`;
}

export async function hashImmutableAssignment(assignment: unknown): Promise<string> {
  const canonical = JSON.stringify(stableJson(assignment));
  return new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
}
