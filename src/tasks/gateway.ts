import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AGENT_KIND } from "../agent-kind.ts";
import { getBackend } from "../server/backend.ts";
import type { SessionInspectionResult } from "../session-status-contract.ts";
import {
  TASK_API_ERROR,
  TASK_API_HTTP_STATUS,
  TASK_EVENT_TYPE,
  TASK_LIMITS,
  TASK_STATUS,
  generateUuidV7,
  hashImmutableAssignment,
  taskPayloadBoundsError,
  validateTaskPayloadBounds,
} from "./domain.ts";
import type {
  ArtifactInput,
  CanonicalTaskEvent,
  ContextRef,
  ImmutableTaskAssignment,
  TaskAddress,
  TaskApiErrorCode,
  TaskArtifactProjection,
  TaskCompletionProjection,
  TaskEventInput,
  TaskParticipants,
  TaskResultInput,
  TaskWarning,
} from "./domain.ts";
import { TaskLifecycle } from "./lifecycle.ts";
import { getMachineId } from "./machine-id.ts";
import { TASK_LEDGER_ROLE, TaskStore } from "./store.ts";
import type { TaskLedger } from "./store.ts";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_BYTES = TASK_LIMITS.TASK_BYTES;
const INTERNAL_EVENT_TYPES = new Set<string>([
  TASK_EVENT_TYPE.CREATED,
  TASK_EVENT_TYPE.RECEIVED,
  TASK_EVENT_TYPE.RECEIPT_CONFIRMED,
  TASK_EVENT_TYPE.PARENT_ACK_PENDING,
  TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED,
]);

type TaskResponse<T> = { readonly ok: true } & T;
type PeerFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type TaskFailure = { readonly ok: false; readonly error: { readonly code: TaskApiErrorCode; readonly message: string; readonly retryable: boolean }; readonly status: number };
type GatewayResult<T> = TaskResponse<T> | TaskFailure;
type Inspection = Extract<SessionInspectionResult, { readonly ok: true }>;

interface GatewayOptions {
  readonly root: string | undefined;
  /** Test-only injected durable store for deterministic post-canonical crash recovery. */
  readonly store?: TaskStore;
  readonly now?: () => Date;
  /** Narrow deterministic seams for bounded direct-peer delivery tests. */
  readonly peerFetch?: PeerFetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly peerOrigin?: string;
}

interface SendInput {
  readonly callerSession: string;
  readonly to: TaskAddress;
  readonly task: string;
  readonly context: { readonly summary?: string; readonly refs?: readonly ContextRef[] } | undefined;
  readonly role: string | undefined;
  readonly preflight: { readonly requiredProject?: string } | undefined;
  readonly metadata: ImmutableTaskAssignment["metadata"];
  readonly onCompletePrompt: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly idempotencyKey: string | undefined;
  readonly rawBody: unknown;
}

function failure(code: TaskApiErrorCode, message: string, retryable = false): TaskFailure {
  return { ok: false, status: TASK_API_HTTP_STATUS[code], error: { code, message, retryable } };
}

function assignmentEnvelope(input: SendInput): Omit<SendInput, "rawBody"> {
  return {
    callerSession: input.callerSession,
    to: input.to,
    task: input.task,
    context: input.context,
    role: input.role,
    preflight: input.preflight,
    metadata: input.metadata,
    onCompletePrompt: input.onCompletePrompt,
    timeoutMs: input.timeoutMs,
    idempotencyKey: input.idempotencyKey,
  };
}

async function serialize<T>(locks: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key);
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (locks.get(key) === current) locks.delete(key);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, max = TASK_LIMITS.TASK_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= max;
}

function sameAddress(left: TaskAddress, right: TaskAddress): boolean {
  return left.machine === right.machine && left.sessionId === right.sessionId;
}

function terminalEvent(status: "completed" | "failed" | "cancelled"): "task.completed" | "task.failed" | "task.cancelled" {
  return status === "completed" ? TASK_EVENT_TYPE.COMPLETED : status === "failed" ? TASK_EVENT_TYPE.FAILED : TASK_EVENT_TYPE.CANCELLED;
}

export class TaskGateway {
  readonly #store: TaskStore;
  readonly #lifecycle: TaskLifecycle;
  readonly #machineId: string;
  readonly #now: () => Date;
  readonly #peerFetch: PeerFetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #peerOrigin: string | undefined;
  #initialized: Promise<void> | undefined;
  readonly #idempotencyLocks = new Map<string, Promise<void>>();
  readonly #peerDeliveryLocks = new Map<string, Promise<void>>();

  constructor(options: GatewayOptions = { root: undefined }) {
    this.#store = options.store ?? new TaskStore({ root: options.root });
    this.#now = options.now ?? (() => new Date());
    this.#lifecycle = new TaskLifecycle(this.#store, { now: this.#now });
    this.#machineId = getMachineId(options.root);
    this.#peerFetch = options.peerFetch ?? fetch;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#random = options.random ?? Math.random;
    this.#peerOrigin = options.peerOrigin;
  }

  get machineId(): string {
    return this.#machineId;
  }

  async initialize(): Promise<void> {
    this.#initialized ??= this.#lifecycle.initialize().then(async (result) => {
      await this.#reconcileCanonicalEvents();
      for (const event of [...result.timedOutEvents, ...result.interruptedDispatchEvents]) {
        await this.#appendBoth(event.taskId, event);
        await this.#forwardSenderEvent(event.taskId, event.id);
      }
    });
    return this.#initialized;
  }

  async send(input: SendInput, idempotencyLocked = false): Promise<GatewayResult<{ readonly taskId: string; readonly eventId: string; readonly sequence: string; readonly warnings: readonly TaskWarning[] }>> {
    const bounds = taskPayloadBoundsError(validateTaskPayloadBounds({ task: input.task, contextSummary: input.context?.summary, assignmentEnvelope: assignmentEnvelope(input), httpBody: input.rawBody }));
    if (bounds) return { ...bounds, status: 413 };
    if (!isNonEmptyString(input.task) || !this.#validAddress(input.to) || !this.#validOptionalFields(input)) return failure(TASK_API_ERROR.INVALID_REQUEST, "invalid task send request");
    if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < MIN_TIMEOUT_MS || input.timeoutMs > MAX_TIMEOUT_MS)) {
      return failure(TASK_API_ERROR.INVALID_REQUEST, "timeoutMs must be an integer from 1000ms through 24h");
    }
    await this.#sweep();
    const caller = await this.#resolve(input.callerSession, "caller");
    if (!caller.ok) return caller;
    if (input.idempotencyKey !== undefined && !idempotencyLocked) {
      const scope = `${this.#machineId}\u0000${caller.value.sessionId}\u0000${input.idempotencyKey}`;
      return serialize(this.#idempotencyLocks, scope, () => this.send(input, true));
    }
    const remote = input.to.machine !== "local" && input.to.machine !== this.#machineId;
    if (remote && process.env.WOLFPACK_JWT_SECRET?.trim()) {
      return failure(TASK_API_ERROR.PEER_AUTH_UNSUPPORTED, "peer federation requires WOLFPACK_JWT_SECRET to be unset");
    }
    const peerOrigin = remote ? this.#localPeerOrigin() : undefined;
    if (remote && (!this.#isPeerOrigin(input.to.machine) || peerOrigin === undefined)) {
      return failure(TASK_API_ERROR.PEER_UNREACHABLE, "remote task delivery requires canonical configured tailnet HTTPS origins", true);
    }
    if (remote && input.context?.refs?.some((ref) => isAbsolute(ref.path))) {
      return failure(TASK_API_ERROR.INVALID_REQUEST, "remote assignments cannot include absolute context refs");
    }
    const target = remote ? undefined : await this.#resolve(input.to.sessionId, "target");
    if (target !== undefined && !target.ok) return target;
    if (target !== undefined && target.value.harness !== AGENT_KIND.PI) return failure(TASK_API_ERROR.TARGET_NOT_PI, "target session is not a Pi harness");
    if (target !== undefined && input.preflight?.requiredProject !== undefined && input.preflight.requiredProject !== basename(target.value.projectPath)) {
      return failure(TASK_API_ERROR.PROJECT_MISMATCH, "target project does not match preflight");
    }
    const taskId = generateUuidV7(this.#now().getTime());
    const parent: TaskAddress = { machine: peerOrigin ?? this.#machineId, sessionId: caller.value.sessionId };
    const receiver: TaskAddress = { machine: remote ? input.to.machine : this.#machineId, sessionId: remote ? input.to.sessionId : target!.value.sessionId };
    const assignment: ImmutableTaskAssignment = {
      taskId,
      source: parent,
      target: receiver,
      task: input.task,
      createdAt: this.#now().toISOString(),
      expiresAt: new Date(this.#now().getTime() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS)).toISOString(),
      context: input.context === undefined ? undefined : { summary: input.context.summary, refs: input.context.refs },
      preflight: input.preflight === undefined ? undefined : { requiredProject: input.preflight.requiredProject },
      role: input.role,
      metadata: input.metadata,
      onCompletePrompt: input.onCompletePrompt,
    };
    const participants: TaskParticipants = { parent, receiver, sender: { machine: peerOrigin ?? this.#machineId, sessionId: "gateway" } };
    const assignmentHash = await hashImmutableAssignment(assignment);
    const existing = input.idempotencyKey === undefined ? undefined : await this.#findIdempotency(parent, input.idempotencyKey);
    if (existing) {
      const ledger = (await this.#store.ledgers()).find((candidate) => candidate.key.role === TASK_LEDGER_ROLE.SENDER
        && candidate.key.taskId === existing.taskId);
      const event = ledger?.state.events.find((candidate) => candidate.type === TASK_EVENT_TYPE.CREATED);
      if (!ledger || !event) return failure(TASK_API_ERROR.STORE_UNAVAILABLE, "idempotent task ledger is unavailable", true);
      const replayHash = await hashImmutableAssignment({
        ...assignment,
        taskId: ledger.header.assignment.taskId,
        createdAt: ledger.header.assignment.createdAt,
        expiresAt: ledger.header.assignment.expiresAt,
      });
      if (existing.assignmentHash !== replayHash) return failure(TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT, "idempotency key was already used for different assignment");
      return { ok: true, taskId: existing.taskId, eventId: event.id, sequence: event.sequence, warnings: ledger.state.warnings };
    }
    const senderCreated = await this.#store.createLedger({ role: TASK_LEDGER_ROLE.SENDER, assignment, participants });
    if (senderCreated.kind === "conflict") return failure(TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT, "task id conflicts with immutable assignment");
    if (senderCreated.kind === "tombstoned") return failure(TASK_API_ERROR.TASK_NOT_FOUND, "task payload was retained only as a tombstone");
    if (!remote) {
      const receiverCreated = await this.#store.createLedger({ role: TASK_LEDGER_ROLE.RECEIVER, assignment, participants });
      if (receiverCreated.kind !== "created" && receiverCreated.kind !== "reused") return failure(TASK_API_ERROR.STORE_UNAVAILABLE, "receiver task ledger unavailable", true);
    }
    const created = await this.#accept(taskId, this.#event(taskId, TASK_EVENT_TYPE.CREATED, "parent"), { actor: "parent", address: parent });
    if (!created.ok) return created;
    if (input.idempotencyKey !== undefined) {
      const senderLedger = await this.#senderLedger(taskId);
      const idempotency = await this.#store.appendScopedIdempotency(senderLedger, { id: `idempotency:${input.idempotencyKey}`, scope: { machine: parent.machine, sessionId: parent.sessionId, key: input.idempotencyKey }, assignmentHash, taskId });
      if (idempotency.kind === "conflict") return failure(TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT, "idempotency key conflicts");
    }
    if (remote) {
      const receipt = await this.#postPeerReceive(receiver.machine, { source: parent, assignment, assignmentHash, createdEventId: created.eventId });
      if (!receipt.ok) {
        await this.#recordInitialPeerFailure(taskId, participants.sender, receipt.error.message);
        return receipt;
      }
      const received = await this.#accept(taskId, this.#event(taskId, TASK_EVENT_TYPE.RECEIVED, "receiver"), { actor: "receiver", address: receiver });
      if (!received.ok) return received;
      const receivedEvent = (await this.#senderLedger(taskId)).state.events.find((event) => event.id === received.eventId);
      if (!receivedEvent) return failure(TASK_API_ERROR.STORE_UNAVAILABLE, "canonical receipt event disappeared", true);
      const confirmation = {
        id: generateUuidV7(this.#now().getTime()), taskId, type: TASK_EVENT_TYPE.RECEIPT_CONFIRMED, actor: "sender", occurredAt: this.#now().toISOString(),
        message: undefined, replyToMessageId: undefined,
        payload: { kind: "receipt_confirmation" as const, receiptId: receipt.receiptId, assignmentHash, createdEventId: created.eventId, receivedEventId: received.eventId, receivedEventSequence: received.sequence, receivedEventOccurredAt: receivedEvent.occurredAt }, completion: undefined,
      } as TaskEventInput;
      const confirmed = await this.#accept(taskId, confirmation, { actor: "sender", address: participants.sender });
      if (!confirmed.ok) return confirmed;
      await this.#forwardSenderEvent(taskId, confirmed.eventId);
      return { ok: true, taskId, eventId: created.eventId, sequence: created.sequence, warnings: [] };
    }
    const received = await this.#accept(taskId, this.#event(taskId, TASK_EVENT_TYPE.RECEIVED, "receiver"), { actor: "receiver", address: receiver });
    if (!received.ok) return received;
    const receivedEvent = (await this.#senderLedger(taskId)).state.events.find((event) => event.id === received.eventId);
    if (!receivedEvent) return failure(TASK_API_ERROR.STORE_UNAVAILABLE, "canonical receipt event disappeared", true);
    const confirmed = await this.#accept(taskId, {
      id: generateUuidV7(this.#now().getTime()), taskId, type: TASK_EVENT_TYPE.RECEIPT_CONFIRMED, actor: "sender", occurredAt: this.#now().toISOString(),
      message: undefined, replyToMessageId: undefined,
      payload: { kind: "receipt_confirmation", receiptId: generateUuidV7(this.#now().getTime()), assignmentHash, createdEventId: created.eventId, receivedEventId: received.eventId, receivedEventSequence: received.sequence, receivedEventOccurredAt: receivedEvent.occurredAt }, completion: undefined,
    } as TaskEventInput, { actor: "sender", address: participants.sender });
    if (!confirmed.ok) return confirmed;
    const receiverLedger = await this.#receiverLedger(taskId);
    const createdEvent = (await this.#senderLedger(taskId)).state.events.find((event) => event.id === created.eventId);
    if (!createdEvent) throw new Error("canonical assignment event disappeared before inbox delivery");
    await this.#store.appendInboxRecord(receiverLedger, { id: `inbox:${created.eventId}`, eventId: created.eventId, occurredAt: createdEvent.occurredAt });
    const warnings = this.#contextWarnings(input.context?.refs, caller.value.projectPath, target!.value.projectPath);
    if (warnings.length > 0) {
      const occurredAt = this.#now().toISOString();
      for (const warning of warnings) {
        await this.#store.appendDiagnostic(await this.#senderLedger(taskId), { id: `warning:sender:${warning.code}:${warning.message}`, code: warning.code, message: warning.message, occurredAt });
        await this.#store.appendDiagnostic(await this.#receiverLedger(taskId), { id: `warning:receiver:${warning.code}:${warning.message}`, code: warning.code, message: warning.message, occurredAt });
      }
    }
    return { ok: true, taskId, eventId: created.eventId, sequence: created.sequence, warnings };
  }

  async status(callerSession: string, taskId: string): Promise<GatewayResult<{ readonly task: ImmutableTaskAssignment; readonly status: string; readonly events: readonly CanonicalTaskEvent[]; readonly completion: unknown; readonly warnings: readonly TaskWarning[] }>> {
    if (!isNonEmptyString(callerSession) || !isNonEmptyString(taskId)) return failure(TASK_API_ERROR.INVALID_REQUEST, "invalid task status query");
    await this.#sweep();
    const caller = await this.#resolve(callerSession, "caller");
    if (!caller.ok) return caller;
    const ledger = await this.#localLedger(taskId);
    if (!ledger) return failure(TASK_API_ERROR.TASK_NOT_FOUND, "task not found");
    if (!this.#isParticipant(ledger, caller.value.sessionId)) return failure(TASK_API_ERROR.CALLER_MISMATCH, "caller is not a task participant");
    return { ok: true, task: ledger.header.assignment, status: ledger.state.status, events: ledger.state.events, completion: ledger.state.completion, warnings: this.#warningsFor(ledger) };
  }

  async inbox(callerSession: string, cursor: string, includeAcknowledged: boolean): Promise<GatewayResult<{ readonly events: readonly CanonicalTaskEvent[]; readonly nextCursor: string; readonly hasMore: boolean }>> {
    if (!isNonEmptyString(callerSession) || !/^(0|[1-9][0-9]*)$/.test(cursor)) return failure(TASK_API_ERROR.INVALID_REQUEST, "invalid inbox query");
    await this.#sweep();
    const caller = await this.#resolve(callerSession, "caller");
    if (!caller.ok) return caller;
    const entries = (await this.#store.inboxAfter(cursor)).events;
    const events: CanonicalTaskEvent[] = [];
    let nextCursor = cursor;
    let usedBytes = 0;
    let scanned = 0;
    for (const entry of entries) {
      const ledger = await this.#store.getLedger(entry.key);
      const event = ledger?.state.events.find((candidate) => candidate.id === entry.eventId);
      scanned += 1;
      if (!ledger || !event || !this.#visibleToSession(ledger, event, caller.value.sessionId)) {
        nextCursor = entry.deliverySequence;
        continue;
      }
      const acknowledged = ledger.records.some((record) => record.kind === "acknowledgment" && record.eventId === event.id)
        || (ledger.state.parentAcknowledgedEventId !== undefined && event.destination.sessionId === ledger.header.participants.parent.sessionId);
      if (!includeAcknowledged && acknowledged) {
        nextCursor = entry.deliverySequence;
        continue;
      }
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (events.length === TASK_LIMITS.INBOX_PAGE_EVENTS || usedBytes + bytes > TASK_LIMITS.INBOX_PAGE_BYTES) {
        scanned -= 1;
        break;
      }
      events.push(event);
      usedBytes += bytes;
      nextCursor = entry.deliverySequence;
    }
    const hasMore = scanned < entries.length;
    return { ok: true, events, nextCursor, hasMore };
  }

  async message(input: { readonly callerSession: string; readonly taskId: string; readonly type: string; readonly message: string; readonly replyToMessageId: string | undefined; readonly rawBody: unknown }): Promise<GatewayResult<{ readonly taskId: string; readonly eventId: string; readonly sequence: string }>> {
    if (!isNonEmptyString(input.callerSession) || !isNonEmptyString(input.taskId) || !isNonEmptyString(input.message, MAX_MESSAGE_BYTES)
      || !["question", "answer", "information"].includes(input.type) || (input.replyToMessageId !== undefined && !isNonEmptyString(input.replyToMessageId))) return failure(TASK_API_ERROR.INVALID_REQUEST, "invalid task message");
    if (validateTaskPayloadBounds({ task: input.message, contextSummary: undefined, assignmentEnvelope: input, httpBody: input.rawBody }).length > 0) return failure(TASK_API_ERROR.PAYLOAD_TOO_LARGE, "task message exceeds UTF-8 byte limits");
    await this.#sweep();
    const caller = await this.#resolve(input.callerSession, "caller");
    if (!caller.ok) return caller;
    const ledger = await this.#localLedger(input.taskId);
    if (!ledger) return failure(TASK_API_ERROR.TASK_NOT_FOUND, "task not found");
    const actor = ledger.header.participants.parent.sessionId === caller.value.sessionId ? "parent" : ledger.header.participants.receiver.sessionId === caller.value.sessionId ? "receiver" : undefined;
    if (!actor) return failure(TASK_API_ERROR.CALLER_MISMATCH, "caller is not a task participant");
    const type = input.type === "question" ? TASK_EVENT_TYPE.QUESTION : input.type === "answer" ? TASK_EVENT_TYPE.ANSWER : TASK_EVENT_TYPE.INFORMATION;
    const event = {
      id: generateUuidV7(this.#now().getTime()), taskId: input.taskId, type, actor, occurredAt: this.#now().toISOString(),
      message: input.message, replyToMessageId: input.replyToMessageId, payload: { kind: "none" }, completion: undefined,
    } as TaskEventInput;
    if (ledger.key.role === TASK_LEDGER_ROLE.SENDER) {
      const accepted = await this.#accept(input.taskId, event, { actor, address: actor === "parent" ? ledger.header.participants.parent : ledger.header.participants.receiver });
      if (!accepted.ok) return accepted;
      const delivered = await this.#forwardSenderEvent(input.taskId, accepted.eventId);
      return delivered.ok ? accepted : delivered;
    }
    if (actor !== "receiver") return failure(TASK_API_ERROR.CALLER_MISMATCH, "remote replica accepts only its receiver actions");
    return this.#forwardReceiverEvent(ledger, event);
  }

  async complete(input: { readonly callerSession: string; readonly taskId: string; readonly status: "completed" | "failed" | "cancelled"; readonly result: TaskResultInput; readonly rawBody: unknown }): Promise<GatewayResult<{ readonly taskId: string; readonly eventId: string; readonly sequence: string }>> {
    if (!isNonEmptyString(input.callerSession) || !isNonEmptyString(input.taskId) || !isNonEmptyString(input.result?.summary) || !["completed", "failed", "cancelled"].includes(input.status)) return failure(TASK_API_ERROR.INVALID_REQUEST, "invalid task completion");
    if (validateTaskPayloadBounds({ task: input.result.summary, contextSummary: undefined, assignmentEnvelope: input, httpBody: input.rawBody }).length > 0) return failure(TASK_API_ERROR.PAYLOAD_TOO_LARGE, "task completion exceeds UTF-8 byte limits");
    await this.#sweep();
    const caller = await this.#resolve(input.callerSession, "caller");
    if (!caller.ok) return caller;
    const ledger = await this.#localLedger(input.taskId);
    if (!ledger) return failure(TASK_API_ERROR.TASK_NOT_FOUND, "task not found");
    if (ledger.header.participants.receiver.sessionId !== caller.value.sessionId) return failure(TASK_API_ERROR.CALLER_MISMATCH, "only the receiver may complete a task");
    const projection = this.#artifactProjection(input.result.artifacts, caller.value.projectPath);
    const event = {
      id: generateUuidV7(this.#now().getTime()), taskId: input.taskId, type: terminalEvent(input.status), actor: "receiver", occurredAt: this.#now().toISOString(),
      message: undefined, replyToMessageId: undefined, payload: { kind: "none" }, completion: input.result,
    } as TaskEventInput;
    if (ledger.key.role === TASK_LEDGER_ROLE.SENDER) return this.#accept(input.taskId, event, { actor: "receiver", address: ledger.header.participants.receiver }, projection);
    const priorIntent = ledger.records.find((record) => record.kind === "outbox.intent" && record.event.type === event.type
      && record.event.completion?.summary === input.result.summary
      && isDeepStrictEqual(record.event.completion?.result, input.result.result)
      && isDeepStrictEqual(record.event.completion?.error, input.result.error)
      && isDeepStrictEqual(record.event.completion?.artifacts, input.result.artifacts));
    const recovered = priorIntent?.kind === "outbox.intent"
      ? ledger.state.events.find((candidate) => candidate.id === priorIntent.event.id)
      : undefined;
    if (recovered) return { ok: true, taskId: input.taskId, eventId: recovered.id, sequence: recovered.sequence };
    return this.#forwardReceiverEvent(ledger, event, projection);
  }

  async cancel(callerSession: string, taskId: string): Promise<GatewayResult<{ readonly taskId: string; readonly eventId: string; readonly sequence: string }>> {
    await this.#sweep();
    const caller = await this.#resolve(callerSession, "caller");
    if (!caller.ok) return caller;
    const ledger = await this.#localLedger(taskId);
    if (!ledger) return failure(TASK_API_ERROR.TASK_NOT_FOUND, "task not found");
    if (ledger.key.role !== TASK_LEDGER_ROLE.SENDER || ledger.header.participants.parent.sessionId !== caller.value.sessionId) return failure(TASK_API_ERROR.CALLER_MISMATCH, "only the parent may cancel a task");
    const accepted = await this.#accept(taskId, this.#event(taskId, TASK_EVENT_TYPE.CANCEL_REQUESTED, "parent"), { actor: "parent", address: ledger.header.participants.parent });
    if (!accepted.ok) return accepted;
    const delivered = await this.#forwardSenderEvent(taskId, accepted.eventId);
    return delivered.ok ? accepted : delivered;
  }

  async delivered(callerSession: string, taskId: string, eventId: string): Promise<GatewayResult<{ readonly taskId: string; readonly eventId: string; readonly sequence: string }>> {
    await this.#sweep();
    const caller = await this.#resolve(callerSession, "caller");
    if (!caller.ok) return caller;
    const ledger = await this.#localLedger(taskId);
    if (!ledger) return failure(TASK_API_ERROR.TASK_NOT_FOUND, "task not found");
    if (ledger.header.participants.receiver.sessionId !== caller.value.sessionId) return failure(TASK_API_ERROR.CALLER_MISMATCH, "only the receiver may acknowledge delivery");
    const injected = ledger.state.events.find((event) => event.id === eventId && event.destination.sessionId === caller.value.sessionId);
    if (!injected) return failure(TASK_API_ERROR.INVALID_TRANSITION, "delivery acknowledgement must reference an injected event");
    const receiver = await this.#receiverLedger(taskId);
    const existingIntent = receiver.records.find((record) => record.kind === "outbox.intent"
      && record.event.payload.kind === "delivery" && record.event.payload.injectedEventId === eventId);
    const deliveryInput = existingIntent?.kind === "outbox.intent" ? existingIntent.event : {
      id: generateUuidV7(this.#now().getTime()), taskId,
      type: injected.type === TASK_EVENT_TYPE.CREATED ? TASK_EVENT_TYPE.DELIVERED : TASK_EVENT_TYPE.MESSAGE_DELIVERED,
      actor: "receiver", occurredAt: this.#now().toISOString(), message: undefined, replyToMessageId: undefined,
      payload: { kind: "delivery", injectedEventId: eventId }, completion: undefined,
    } as TaskEventInput;
    if (!existingIntent) await this.#store.appendOutboundIntent(receiver, deliveryInput);
    const accepted = ledger.key.role === TASK_LEDGER_ROLE.SENDER
      ? await this.#accept(taskId, deliveryInput, { actor: "receiver", address: ledger.header.participants.receiver })
      : await this.#forwardReceiverEvent(ledger, deliveryInput);
    if (!accepted.ok) return accepted;
    const deliveryRecordId = `delivery:${eventId}`;
    await this.#store.appendAcknowledgment(await this.#receiverLedger(taskId), { id: deliveryRecordId, eventId, occurredAt: this.#now().toISOString() });
    return accepted;
  }

  async acknowledge(callerSession: string, taskId: string): Promise<GatewayResult<{ readonly taskId: string; readonly eventId: string; readonly sequence: string }>> {
    await this.#sweep();
    const caller = await this.#resolve(callerSession, "caller");
    if (!caller.ok) return caller;
    const ledger = await this.#localLedger(taskId);
    if (!ledger) return failure(TASK_API_ERROR.TASK_NOT_FOUND, "task not found");
    if (ledger.key.role !== TASK_LEDGER_ROLE.SENDER || ledger.header.participants.parent.sessionId !== caller.value.sessionId) return failure(TASK_API_ERROR.CALLER_MISMATCH, "only the parent may acknowledge a task");
    const terminalStatuses: readonly string[] = [TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.TIMED_OUT];
    if (!terminalStatuses.includes(ledger.state.status)) return failure(TASK_API_ERROR.INVALID_TRANSITION, "only terminal tasks may be acknowledged");
    let pendingId = ledger.state.pendingParentAckEventId;
    if (!pendingId) {
      const pending = await this.#accept(taskId, this.#event(taskId, TASK_EVENT_TYPE.PARENT_ACK_PENDING, "sender"), { actor: "sender", address: ledger.header.participants.sender });
      if (!pending.ok) return pending;
      pendingId = pending.eventId;
    }
    const current = await this.#senderLedger(taskId);
    if (current.state.parentAcknowledgedEventId !== undefined) {
      const event = current.state.events.find((candidate) => candidate.id === current.state.parentAcknowledgedEventId);
      if (event) {
        if (current.header.assignment.target.machine !== this.#machineId) {
          const delivered = await this.#forwardSenderEvent(taskId, event.id);
          if (!delivered.ok) return delivered;
        }
        return { ok: true, taskId, eventId: event.id, sequence: event.sequence };
      }
    }
    if (ledger.header.assignment.target.machine !== this.#machineId) {
      const delivered = await this.#forwardSenderEvent(taskId, pendingId);
      if (!delivered.ok) return delivered;
    } else {
      const receiver = await this.#receiverLedger(taskId);
      const receiverAckId = `receiver-ack:${pendingId}`;
      await this.#store.appendAcknowledgment(receiver, { id: receiverAckId, eventId: pendingId, occurredAt: this.#now().toISOString() });
    }
    const acknowledged = await this.#accept(taskId, {
      id: generateUuidV7(this.#now().getTime()), taskId, type: TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED, actor: "sender", occurredAt: this.#now().toISOString(),
      message: undefined, replyToMessageId: pendingId, payload: { kind: "parent_ack", pendingAckEventId: pendingId }, completion: undefined,
    } as TaskEventInput, { actor: "sender", address: ledger.header.participants.sender });
    if (!acknowledged.ok) return acknowledged;
    if (ledger.header.assignment.target.machine === this.#machineId) {
      const receiver = await this.#receiverLedger(taskId);
      const event = (await this.#senderLedger(taskId)).state.events.find((candidate) => candidate.id === acknowledged.eventId);
      if (!event) return failure(TASK_API_ERROR.STORE_UNAVAILABLE, "canonical acknowledgment disappeared", true);
      await this.#store.markCleanupEligible(receiver, {
        id: `cleanup:${pendingId}`,
        acknowledgedEventId: `receiver-ack:${pendingId}`,
        occurredAt: event.occurredAt,
      });
    }
    const delivered = await this.#forwardSenderEvent(taskId, acknowledged.eventId);
    return delivered.ok ? acknowledged : delivered;
  }

  async receivePeer(input: unknown): Promise<GatewayResult<{ readonly receiptId: string }>> {
    if (process.env.WOLFPACK_JWT_SECRET?.trim()) {
      return failure(TASK_API_ERROR.PEER_AUTH_UNSUPPORTED, "peer federation requires WOLFPACK_JWT_SECRET to be unset", false);
    }
    if (!isRecord(input) || !isRecord(input.source) || !isRecord(input.assignment)
      || typeof input.createdEventId !== "string" || !/^[0-9a-f-]{36}$/.test(input.createdEventId)
      || typeof input.assignmentHash !== "string" || !/^[a-f0-9]{64}$/.test(input.assignmentHash)) {
      return failure(TASK_API_ERROR.INVALID_REQUEST, "invalid peer assignment envelope");
    }
    const source = input.source as unknown as TaskAddress;
    const assignment = input.assignment as unknown as ImmutableTaskAssignment;
    if (!this.#validAddress(source) || !this.#validAssignment(assignment) || !sameAddress(source, assignment.source)
      || !this.#isPeerOrigin(source.machine) || !this.#isPeerOrigin(assignment.target.machine)
      || assignment.target.machine !== this.#localPeerOrigin()) {
      return failure(TASK_API_ERROR.INVALID_REQUEST, "peer assignment must target this configured tailnet origin");
    }
    if (assignment.context?.refs?.some((ref) => isAbsolute(ref.path))) {
      return failure(TASK_API_ERROR.INVALID_REQUEST, "remote assignments cannot include absolute context refs");
    }
    if (await hashImmutableAssignment(assignment) !== input.assignmentHash) {
      return failure(TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT, "peer assignment hash does not match immutable content");
    }
    const target = await this.#resolve(assignment.target.sessionId, "target");
    if (!target.ok) return target;
    if (target.value.harness !== AGENT_KIND.PI) return failure(TASK_API_ERROR.TARGET_NOT_PI, "target session is not a Pi harness");
    if (assignment.preflight?.requiredProject !== undefined && assignment.preflight.requiredProject !== basename(target.value.projectPath)) {
      return failure(TASK_API_ERROR.PROJECT_MISMATCH, "target project does not match preflight");
    }
    const participants: TaskParticipants = {
      parent: assignment.source,
      receiver: assignment.target,
      sender: { machine: assignment.source.machine, sessionId: "gateway" },
    };
    const opened = await this.#store.createLedger({ role: TASK_LEDGER_ROLE.RECEIVER, assignment, participants });
    if (opened.kind === "conflict") return failure(TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT, "task id conflicts with immutable assignment");
    if (opened.kind === "tombstoned") return failure(TASK_API_ERROR.TASK_NOT_FOUND, "task payload was retained only as a tombstone");
    const ledger = opened.ledger;
    for (const warning of this.#contextWarnings(assignment.context?.refs, target.value.projectPath, target.value.projectPath)) {
      await this.#store.appendDiagnostic(ledger, {
        id: `warning:receiver:${warning.code}:${warning.message}`,
        code: warning.code,
        message: warning.message,
        occurredAt: assignment.createdAt,
      });
    }
    const existing = ledger.records.find((record) => record.kind === "peer.receipt");
    if (existing?.kind === "peer.receipt") {
      if (existing.assignmentHash !== input.assignmentHash || existing.createdEventId !== input.createdEventId || !sameAddress(existing.source, source)) {
        return failure(TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT, "peer receipt conflicts with immutable assignment");
      }
      return { ok: true, receiptId: existing.receiptId };
    }
    const receiptId = generateUuidV7(this.#now().getTime());
    await this.#store.appendPeerReceipt(ledger, {
      id: `peer.receipt:${receiptId}`,
      source,
      taskId: assignment.taskId,
      assignmentHash: input.assignmentHash,
      createdEventId: input.createdEventId,
      receiptId,
    });
    return { ok: true, receiptId };
  }

  async acceptPeerEvent(input: unknown): Promise<GatewayResult<{ readonly taskId: string; readonly eventId: string; readonly sequence: string; readonly event: CanonicalTaskEvent }>> {
    if (process.env.WOLFPACK_JWT_SECRET?.trim()) {
      return failure(TASK_API_ERROR.PEER_AUTH_UNSUPPORTED, "peer federation requires WOLFPACK_JWT_SECRET to be unset", false);
    }
    if (!isRecord(input) || !isRecord(input.source) || !isRecord(input.destination) || !isRecord(input.event)) {
      return failure(TASK_API_ERROR.INVALID_REQUEST, "invalid peer event envelope");
    }
    const source = input.source as unknown as TaskAddress;
    const destination = input.destination as unknown as TaskAddress;
    const event = input.event as unknown as TaskEventInput;
    if (!this.#validAddress(source) || !this.#validAddress(destination) || !this.#validPeerEvent(event)) {
      return failure(TASK_API_ERROR.INVALID_REQUEST, "invalid peer event envelope");
    }
    const ledger = await this.#localLedger(event.taskId);
    if (!ledger) return failure(TASK_API_ERROR.TASK_NOT_FOUND, "task not found");
    if (ledger.key.role === TASK_LEDGER_ROLE.SENDER) {
      if (!sameAddress(destination, { machine: ledger.header.assignment.source.machine, sessionId: "gateway" }) || event.actor !== "receiver" || !sameAddress(source, ledger.header.participants.receiver)) {
        return failure(TASK_API_ERROR.CALLER_MISMATCH, "peer event source, destination, or actor does not match sender authority");
      }
      const accepted = await this.#accept(event.taskId, event, { actor: event.actor, address: source }, input.projection as TaskCompletionProjection | undefined);
      if (!accepted.ok) return accepted;
      const canonical = (await this.#senderLedger(event.taskId)).state.events.find((candidate) => candidate.id === accepted.eventId);
      if (!canonical) return failure(TASK_API_ERROR.STORE_UNAVAILABLE, "canonical peer event disappeared", true);
      return { ...accepted, event: canonical };
    }
    const canonical = event as unknown as CanonicalTaskEvent;
    if (!sameAddress(source, ledger.header.participants.sender) || !sameAddress(destination, ledger.header.participants.receiver)
      || !isRecord(canonical) || !this.#validAddress(canonical.source) || !this.#validAddress(canonical.destination)
      || !isNonEmptyString(canonical.sequence)) {
      return failure(TASK_API_ERROR.CALLER_MISMATCH, "peer event source, destination, or sequence does not match receiver authority");
    }
    if (canonical.type === TASK_EVENT_TYPE.RECEIPT_CONFIRMED) {
      if (canonical.actor !== "sender" || !sameAddress(canonical.source, ledger.header.participants.sender)
        || !sameAddress(canonical.destination, ledger.header.participants.receiver) || canonical.sequence !== "3") {
        return failure(TASK_API_ERROR.CALLER_MISMATCH, "peer receipt confirmation has invalid canonical provenance");
      }
      const receipt = ledger.records.find((record) => record.kind === "peer.receipt");
      if (receipt?.kind !== "peer.receipt" || canonical.payload.kind !== "receipt_confirmation"
        || canonical.payload.receiptId !== receipt.receiptId || canonical.payload.assignmentHash !== receipt.assignmentHash
        || canonical.payload.createdEventId !== receipt.createdEventId) {
        return failure(TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT, "peer receipt confirmation does not match provisional assignment");
      }
      if (ledger.state.events.length === 0) await this.#seedConfirmedReceiverLedger(ledger, canonical, source);
    }
    const current = await this.#receiverLedger(canonical.taskId);
    const appended = await this.#store.appendEvent(current, canonical);
    if (appended.kind === "conflict") return failure(TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT, "peer event conflicts with replica history");
    const updated = await this.#receiverLedger(canonical.taskId);
    if (canonical.type === TASK_EVENT_TYPE.RECEIPT_CONFIRMED) {
      const created = updated.state.events.find((candidate) => candidate.type === TASK_EVENT_TYPE.CREATED);
      if (created) await this.#appendReceiverInboxIfVisible(updated, created);
    }
    await this.#appendReceiverInboxIfVisible(updated, canonical);
    if (canonical.type === TASK_EVENT_TYPE.PARENT_ACK_PENDING) {
      await this.#store.appendAcknowledgment(updated, { id: `receiver-ack:${canonical.id}`, eventId: canonical.id, occurredAt: canonical.occurredAt });
    }
    if (canonical.type === TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED && canonical.payload.kind === "parent_ack") {
      const receiverAckId = `receiver-ack:${canonical.payload.pendingAckEventId}`;
      await this.#store.markCleanupEligible(updated, { id: `cleanup:${canonical.payload.pendingAckEventId}`, acknowledgedEventId: receiverAckId, occurredAt: canonical.occurredAt });
    }
    return { ok: true, taskId: canonical.taskId, eventId: canonical.id, sequence: canonical.sequence, event: canonical };
  }

  async #sweep(): Promise<void> {
    await this.initialize();
    await this.#reconcileCanonicalEvents();
    for (const event of await this.#lifecycle.sweep()) {
      await this.#appendBoth(event.taskId, event);
      await this.#forwardSenderEvent(event.taskId, event.id);
    }
  }

  async #resolve(selector: string, role: "caller" | "target"): Promise<{ readonly ok: true; readonly value: Inspection } | TaskFailure> {
    if (!isNonEmptyString(selector)) return failure(role === "caller" ? TASK_API_ERROR.CALLER_NOT_FOUND : TASK_API_ERROR.TARGET_NOT_FOUND, `${role} session not found`);
    const inspect = getBackend().inspectSession;
    if (!inspect) return failure(TASK_API_ERROR.STORE_UNAVAILABLE, "authoritative session inspection is unavailable", true);
    let session: SessionInspectionResult;
    try { session = await inspect.call(getBackend(), selector); } catch { return failure(TASK_API_ERROR.STORE_UNAVAILABLE, "session backend is unavailable", true); }
    if (!session.ok) return failure(role === "caller" ? TASK_API_ERROR.CALLER_NOT_FOUND : TASK_API_ERROR.TARGET_NOT_FOUND, `${role} session not found`);
    if (!session.alive) return failure(TASK_API_ERROR.TARGET_DEAD, `${role} terminal is not live`);
    return { ok: true, value: session };
  }

  async #localLedger(taskId: string): Promise<TaskLedger | undefined> {
    const ledgers = await this.#store.ledgers();
    return ledgers.find((ledger) => ledger.key.taskId === taskId && ledger.key.role === TASK_LEDGER_ROLE.SENDER)
      ?? ledgers.find((ledger) => ledger.key.taskId === taskId && ledger.key.role === TASK_LEDGER_ROLE.RECEIVER);
  }

  async #senderLedger(taskId: string): Promise<TaskLedger> {
    const ledger = (await this.#store.ledgers()).find((candidate) => candidate.key.role === TASK_LEDGER_ROLE.SENDER && candidate.key.taskId === taskId);
    if (!ledger) throw new Error("sender ledger disappeared");
    return ledger;
  }

  async #receiverLedger(taskId: string): Promise<TaskLedger> {
    const ledger = (await this.#store.ledgers()).find((candidate) => candidate.key.role === TASK_LEDGER_ROLE.RECEIVER && candidate.key.taskId === taskId);
    if (!ledger) throw new Error("receiver ledger disappeared");
    return ledger;
  }

  async #appendBoth(taskId: string, event: CanonicalTaskEvent): Promise<void> {
    const sender = await this.#senderLedger(taskId);
    await this.#store.appendEvent(sender, event);
    const receiver = sender.header.assignment.target.machine === this.#machineId
      ? (await this.#store.ledgers()).find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && ledger.key.taskId === taskId)
      : undefined;
    if (receiver) await this.#store.appendEvent(receiver, event);
    await this.#appendInboxIfVisible(sender, event);
  }

  /** Rebuilds non-authoritative replica/inbox propagation solely from the fsynced sender ledger. */
  async #reconcileCanonicalEvents(): Promise<void> {
    for (const sender of await this.#store.ledgers()) {
      if (sender.key.role !== TASK_LEDGER_ROLE.SENDER || sender.header.assignment.target.machine !== this.#machineId) continue;
      const receiver = await this.#store.createLedger({
        role: TASK_LEDGER_ROLE.RECEIVER,
        assignment: sender.header.assignment,
        participants: sender.header.participants,
      });
      if (receiver.kind === "conflict" || receiver.kind === "tombstoned") throw new Error("receiver replica conflicts with canonical sender ledger");
      if (receiver.kind !== "created" && receiver.kind !== "reused") throw new Error("receiver replica is unavailable");

      let canonical = await this.#senderLedger(sender.key.taskId);
      const received = canonical.state.events.find((event) => event.type === TASK_EVENT_TYPE.RECEIVED);
      const confirmed = canonical.state.events.some((event) => event.type === TASK_EVENT_TYPE.RECEIPT_CONFIRMED);
      if (received && !confirmed && canonical.state.status === TASK_STATUS.RECEIVED) {
        const acceptance = await this.#store.acceptCanonicalEvent(canonical.key, {
          id: generateUuidV7(this.#now().getTime()), taskId: canonical.key.taskId, type: TASK_EVENT_TYPE.RECEIPT_CONFIRMED,
          actor: "sender", occurredAt: this.#now().toISOString(), message: undefined, replyToMessageId: undefined,
          payload: { kind: "receipt_confirmation", receiptId: generateUuidV7(this.#now().getTime()), assignmentHash: canonical.header.assignmentHash, createdEventId: canonical.state.events.find((event) => event.type === TASK_EVENT_TYPE.CREATED)?.id ?? generateUuidV7(this.#now().getTime()), receivedEventId: received.id, receivedEventSequence: received.sequence, receivedEventOccurredAt: received.occurredAt }, completion: undefined,
        }, { actor: "sender", address: canonical.header.participants.sender });
        if (acceptance.kind === "rejected") throw new Error("canonical receipt confirmation recovery was rejected");
        canonical = await this.#senderLedger(sender.key.taskId);
      }

      const replica = await this.#receiverLedger(sender.key.taskId);
      for (const event of canonical.state.events) await this.#store.appendEvent(replica, event);
      for (const event of canonical.state.events) await this.#appendInboxIfVisible(canonical, event);
    }
    for (const sender of await this.#store.ledgers()) {
      if (sender.key.role !== TASK_LEDGER_ROLE.SENDER || sender.header.assignment.target.machine === this.#machineId) continue;
      for (const record of sender.records) {
        if (record.kind !== "outbox.intent" || this.#isOutboxDeliveryResolved(sender, record.event.id) || this.#isOutboxDeliveryExhausted(sender, record.event.id)) continue;
        await this.#deliverPeerEvent(sender, record.event, undefined);
      }
    }
    for (const receiver of await this.#store.ledgers()) {
      if (receiver.key.role !== TASK_LEDGER_ROLE.RECEIVER || receiver.header.assignment.target.machine === this.#machineId) continue;
      for (const record of receiver.records) {
        if (record.kind !== "outbox.intent" || receiver.state.events.some((event) => event.id === record.event.id)
          || receiver.records.some((candidate) => candidate.kind === "diagnostic" && candidate.id === `peer.delivery:${record.event.id}`)) continue;
        await this.#forwardReceiverEvent(receiver, record.event);
      }
    }
  }

  async #forwardSenderEvent(taskId: string, eventId: string): Promise<GatewayResult<{ readonly taskId: string; readonly eventId: string; readonly sequence: string }>> {
    const sender = await this.#senderLedger(taskId);
    const target = sender.state.events.find((candidate) => candidate.id === eventId);
    if (!target) return failure(TASK_API_ERROR.STORE_UNAVAILABLE, "canonical event disappeared before peer delivery", true);
    if (sender.header.assignment.target.machine === this.#machineId) return { ok: true, taskId, eventId, sequence: target.sequence };
    const events = target.type === TASK_EVENT_TYPE.RECEIPT_CONFIRMED
      ? [target]
      : sender.state.events.filter((event) => BigInt(event.sequence) >= 3n && BigInt(event.sequence) <= BigInt(target.sequence));
    for (const event of events) {
      await this.#store.appendOutboundIntent(sender, event as TaskEventInput);
      const current = await this.#senderLedger(taskId);
      if (this.#isOutboxDeliveryResolved(current, event.id)) continue;
      if (this.#isOutboxDeliveryExhausted(current, event.id)) {
        if (event.id === eventId) return failure(TASK_API_ERROR.PEER_UNREACHABLE, "peer delivery attempts are exhausted", true);
        continue;
      }
      const delivered = await this.#deliverPeerEvent(current, event, undefined);
      if (!delivered.ok) return delivered;
    }
    return { ok: true, taskId, eventId, sequence: target.sequence };
  }

  async #forwardReceiverEvent(
    receiver: TaskLedger,
    event: TaskEventInput,
    projection: TaskCompletionProjection | undefined = undefined,
  ): Promise<GatewayResult<{ readonly taskId: string; readonly eventId: string; readonly sequence: string }>> {
    if (receiver.key.role !== TASK_LEDGER_ROLE.RECEIVER) return failure(TASK_API_ERROR.TASK_NOT_FOUND, "receiver replica is unavailable");
    await this.#store.appendOutboundIntent(receiver, event);
    const delivered = await this.#deliverPeerEvent(receiver, event, projection);
    if (!delivered.ok) return delivered;
    if (!delivered.event) return failure(TASK_API_ERROR.MALFORMED_UPSTREAM_RESPONSE, "sender acknowledgment omitted canonical event", true);
    await this.#store.appendEvent(receiver, delivered.event);
    await this.#appendReceiverInboxIfVisible(await this.#receiverLedger(event.taskId), delivered.event);
    return { ok: true, taskId: event.taskId, eventId: delivered.event.id, sequence: delivered.event.sequence };
  }

  async #deliverPeerEvent(
    ledger: TaskLedger,
    event: TaskEventInput | CanonicalTaskEvent,
    projection: TaskCompletionProjection | undefined,
  ): Promise<({ readonly ok: true; readonly event: CanonicalTaskEvent | undefined } | TaskFailure)> {
    const key = `${ledger.key.role}\u0000${ledger.key.sourceMachine}\u0000${ledger.key.taskId}\u0000${event.id}`;
    return serialize(this.#peerDeliveryLocks, key, async () => {
      const current = await this.#store.getLedger(ledger.key);
      if (!current) return failure(TASK_API_ERROR.STORE_UNAVAILABLE, "outbound task ledger disappeared", true);
      if (current.key.role === TASK_LEDGER_ROLE.SENDER && this.#isOutboxDeliveryResolved(current, event.id)) {
        return { ok: true, event: current.state.events.find((candidate) => candidate.id === event.id) };
      }
      if (this.#isOutboxDeliveryExhausted(current, event.id)) return failure(TASK_API_ERROR.PEER_UNREACHABLE, "peer delivery attempts are exhausted", true);
      return this.#deliverPeerEventLocked(current, event, projection);
    });
  }

  async #deliverPeerEventLocked(
    ledger: TaskLedger,
    event: TaskEventInput | CanonicalTaskEvent,
    projection: TaskCompletionProjection | undefined,
  ): Promise<({ readonly ok: true; readonly event: CanonicalTaskEvent | undefined } | TaskFailure)> {
    const receiverReplica = ledger.key.role === TASK_LEDGER_ROLE.RECEIVER;
    const source = receiverReplica ? ledger.header.participants.receiver : ledger.header.participants.sender;
    const destination = receiverReplica
      ? { machine: ledger.header.assignment.source.machine, sessionId: "gateway" }
      : ledger.header.participants.receiver;
    let lastFailure: TaskFailure | undefined;
    const attemptsBefore = ledger.records.filter((record) => record.kind === "outbox.attempt" && record.eventId === event.id).length;
    const remainingAttempts = Math.max(0, 4 - attemptsBefore);
    for (let attempt = 1; attempt <= remainingAttempts; attempt += 1) {
      const ordinal = attemptsBefore + attempt;
      await this.#store.appendOutboxAttempt(ledger, { id: `outbox.attempt:${event.id}:${ordinal}`, eventId: event.id, attempt: ordinal, occurredAt: this.#now().toISOString() });
      const delivered = await this.#postPeerEvent(destination.machine, { source, destination, event, projection });
      if (delivered.ok) {
        await this.#store.appendOutboxDelivered(ledger, { id: `outbox.delivered:${event.id}`, eventId: event.id, occurredAt: this.#now().toISOString() });
        return { ok: true, event: delivered.event };
      }
      lastFailure = delivered;
      if (attempt < remainingAttempts) await this.#sleep(this.#retryDelay(attempt));
    }
    const message = lastFailure?.error.message ?? "peer event delivery failed";
    if (ledger.key.role === TASK_LEDGER_ROLE.SENDER) await this.#recordDeliveryFailure(ledger.key.taskId, ledger.header.participants.sender, event.id, message);
    else if (!ledger.records.some((record) => record.kind === "diagnostic" && record.id === `peer.delivery:${event.id}`)) {
      await this.#store.appendDiagnostic(ledger, { id: `peer.delivery:${event.id}`, code: TASK_API_ERROR.PEER_UNREACHABLE, message, occurredAt: this.#now().toISOString() });
    }
    return lastFailure ?? failure(TASK_API_ERROR.PEER_UNREACHABLE, message, true);
  }

  #isOutboxDeliveryResolved(ledger: TaskLedger, eventId: string): boolean {
    return ledger.records.some((record) => record.kind === "outbox.delivered" && record.eventId === eventId);
  }

  #isOutboxDeliveryExhausted(ledger: TaskLedger, eventId: string): boolean {
    return ledger.records.some((record) => record.kind === "diagnostic" && record.id === `peer.delivery:${eventId}`);
  }

  #retryDelay(attempt: number): number {
    const base = [1_000, 2_000, 4_000][attempt - 1];
    if (base === undefined) throw new RangeError("peer retry attempts are bounded to three delays");
    return Math.round(base * (0.9 + this.#random() * 0.2));
  }

  async #postPeerReceive(origin: string, body: unknown): Promise<{ readonly ok: true; readonly receiptId: string } | TaskFailure> {
    return this.#postPeer(origin, "/api/tasks/v1/peer/receive", body, (value): value is { readonly ok: true; readonly receiptId: string } => isRecord(value) && value.ok === true && isNonEmptyString(value.receiptId));
  }

  async #postPeerEvent(origin: string, body: unknown): Promise<{ readonly ok: true; readonly taskId: string; readonly eventId: string; readonly sequence: string; readonly event: CanonicalTaskEvent | undefined } | TaskFailure> {
    return this.#postPeer(origin, "/api/tasks/v1/peer/event", body, (value): value is { readonly ok: true; readonly taskId: string; readonly eventId: string; readonly sequence: string; readonly event: CanonicalTaskEvent | undefined } => isRecord(value) && value.ok === true && isNonEmptyString(value.taskId) && isNonEmptyString(value.eventId) && isNonEmptyString(value.sequence)
      && (value.event === undefined || (isRecord(value.event) && isNonEmptyString(value.event.id) && isNonEmptyString(value.event.taskId) && isNonEmptyString(value.event.sequence))));
  }

  async #postPeer<T>(origin: string, path: string, body: unknown, valid: (value: unknown) => value is T): Promise<T | TaskFailure> {
    if (!this.#isPeerOrigin(origin)) return failure(TASK_API_ERROR.INVALID_REQUEST, "peer origin is not a canonical tailnet HTTPS origin");
    let response: Response;
    try {
      response = await this.#peerFetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return failure(TASK_API_ERROR.PEER_UNREACHABLE, "peer gateway is unreachable", true);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return failure(TASK_API_ERROR.MALFORMED_UPSTREAM_RESPONSE, "peer gateway returned invalid JSON", true);
    }
    if (valid(payload)) return payload;
    if (isRecord(payload) && payload.ok === false && isRecord(payload.error) && typeof payload.error.code === "string" && typeof payload.error.message === "string") {
      return failure(payload.error.code as TaskApiErrorCode, payload.error.message, payload.error.retryable === true);
    }
    return failure(TASK_API_ERROR.MALFORMED_UPSTREAM_RESPONSE, "peer gateway returned an invalid response", true);
  }

  async #recordInitialPeerFailure(taskId: string, sender: TaskAddress, message: string): Promise<void> {
    const input = {
      id: generateUuidV7(this.#now().getTime()), taskId, type: TASK_EVENT_TYPE.FAILED, actor: "sender", occurredAt: this.#now().toISOString(),
      message: undefined, replyToMessageId: undefined, payload: { kind: "none" },
      completion: { summary: "initial peer assignment delivery failed", result: undefined, error: { code: TASK_API_ERROR.PEER_UNREACHABLE, message, retryable: true }, artifacts: undefined },
    } as TaskEventInput;
    await this.#accept(taskId, input, { actor: "sender", address: sender }, { artifacts: undefined, warnings: [] });
  }

  async #recordDeliveryFailure(taskId: string, sender: TaskAddress, eventId: string, message: string): Promise<void> {
    const ledger = await this.#senderLedger(taskId);
    if (ledger.records.some((record) => record.kind === "diagnostic" && record.id === `peer.delivery:${eventId}`)) return;
    const input = {
      id: generateUuidV7(this.#now().getTime()), taskId, type: TASK_EVENT_TYPE.DELIVERY_FAILED, actor: "sender", occurredAt: this.#now().toISOString(),
      message: undefined, replyToMessageId: undefined, payload: { kind: "delivery_failure", code: TASK_API_ERROR.PEER_UNREACHABLE, message }, completion: undefined,
    } as TaskEventInput;
    const accepted = await this.#store.acceptCanonicalEvent(ledger.key, input, { actor: "sender", address: sender });
    if (accepted.kind === "accepted") await this.#store.appendDiagnostic(await this.#senderLedger(taskId), { id: `peer.delivery:${eventId}`, code: TASK_API_ERROR.PEER_UNREACHABLE, message, occurredAt: this.#now().toISOString() });
  }

  async #seedConfirmedReceiverLedger(ledger: TaskLedger, confirmation: TaskEventInput, source: TaskAddress): Promise<void> {
    if (confirmation.payload.kind !== "receipt_confirmation") throw new Error("receipt confirmation payload is required");
    const assignment = ledger.header.assignment;
    const created: CanonicalTaskEvent = {
      id: confirmation.payload.createdEventId, taskId: assignment.taskId, type: TASK_EVENT_TYPE.CREATED, actor: "parent",
      source: assignment.source, destination: assignment.target, sequence: "1", occurredAt: assignment.createdAt,
      message: undefined, replyToMessageId: undefined, payload: { kind: "none" }, completion: undefined,
    } as CanonicalTaskEvent;
    const received: CanonicalTaskEvent = {
      id: confirmation.payload.receivedEventId, taskId: assignment.taskId, type: TASK_EVENT_TYPE.RECEIVED, actor: "receiver",
      source: assignment.target, destination: assignment.source, sequence: confirmation.payload.receivedEventSequence, occurredAt: confirmation.payload.receivedEventOccurredAt,
      message: undefined, replyToMessageId: undefined, payload: { kind: "none" }, completion: undefined,
    } as CanonicalTaskEvent;
    if (received.sequence !== "2" || !sameAddress(source, ledger.header.participants.sender)) throw new Error("receipt confirmation has invalid canonical provenance");
    await this.#store.appendEvent(ledger, created);
    await this.#store.appendEvent(ledger, received);
  }

  async #appendReceiverInboxIfVisible(receiver: TaskLedger, event: CanonicalTaskEvent): Promise<void> {
    if (!this.#visibleToSession(receiver, event, receiver.header.participants.receiver.sessionId)
      || (INTERNAL_EVENT_TYPES.has(event.type) && event.type !== TASK_EVENT_TYPE.CREATED)) return;
    await this.#store.appendInboxRecord(receiver, { id: `inbox:${event.id}`, eventId: event.id, occurredAt: event.occurredAt });
  }

  #visibleToSession(ledger: TaskLedger, event: CanonicalTaskEvent, sessionId: string): boolean {
    return event.destination.sessionId === sessionId
      || (ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && sessionId === ledger.header.participants.receiver.sessionId
        && event.type === TASK_EVENT_TYPE.TIMED_OUT && event.actor === "sender");
  }

  async #appendInboxIfVisible(sender: TaskLedger, event: CanonicalTaskEvent): Promise<void> {
    const confirmed = sender.state.events.some((candidate) => candidate.type === TASK_EVENT_TYPE.RECEIPT_CONFIRMED);
    if (event.type === TASK_EVENT_TYPE.CREATED) {
      if (!confirmed) return;
    } else if (INTERNAL_EVENT_TYPES.has(event.type)) {
      return;
    }
    const recipient = event.destination.sessionId === sender.header.participants.parent.sessionId
      ? await this.#senderLedger(event.taskId)
      : (await this.#store.ledgers()).find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && ledger.key.taskId === event.taskId);
    if (!recipient) return;
    const inboxId = `inbox:${event.id}`;
    const existing = recipient.records.find((record) => record.id === inboxId);
    if (existing?.kind === "inbox" && existing.eventId === event.id) return;
    await this.#store.appendInboxRecord(recipient, { id: inboxId, eventId: event.id, occurredAt: event.occurredAt });
  }

  async #accept(taskId: string, input: TaskEventInput, principal: { readonly actor: "parent" | "receiver" | "sender"; readonly address: TaskAddress }, projection?: TaskCompletionProjection): Promise<GatewayResult<{ readonly taskId: string; readonly eventId: string; readonly sequence: string }>> {
    const ledger = await this.#senderLedger(taskId);
    const accepted = await this.#store.acceptCanonicalEvent(ledger.key, input, principal, projection);
    if (accepted.kind === "rejected") return failure(accepted.code, "task event transition was rejected");
    if (accepted.kind === "duplicate") return { ok: true, taskId, eventId: accepted.acknowledgedEventId, sequence: ledger.state.events.find((event) => event.id === accepted.acknowledgedEventId)?.sequence ?? "0" };
    await this.#appendBoth(taskId, accepted.event);
    return { ok: true, taskId, eventId: accepted.event.id, sequence: accepted.event.sequence };
  }

  #event(taskId: string, type: TaskEventInput["type"], actor: TaskEventInput["actor"]): TaskEventInput {
    return { id: generateUuidV7(this.#now().getTime()), taskId, type, actor, occurredAt: this.#now().toISOString(), message: undefined, replyToMessageId: undefined, payload: { kind: "none" }, completion: undefined } as TaskEventInput;
  }

  #validAddress(address: TaskAddress): boolean {
    return isRecord(address) && isNonEmptyString(address.machine) && isNonEmptyString(address.sessionId);
  }

  #localPeerOrigin(): string | undefined {
    try {
      const configured = this.#peerOrigin ?? (() => {
        const hostname = JSON.parse(readFileSync(join(homedir(), ".wolfpack", "config.json"), "utf-8")).tailscaleHostname;
        return typeof hostname === "string" ? `https://${hostname}` : "";
      })();
      return this.#isPeerOrigin(configured) ? configured : undefined;
    } catch {
      return undefined;
    }
  }

  #isPeerOrigin(value: string): boolean {
    try {
      const url = new URL(value);
      const localOrigin = this.#peerOrigin ?? (() => {
        const hostname = JSON.parse(readFileSync(join(homedir(), ".wolfpack", "config.json"), "utf-8")).tailscaleHostname;
        return typeof hostname === "string" ? `https://${hostname}` : "";
      })();
      const configuredSuffix = process.env.WOLFPACK_TAILNET_SUFFIX?.trim();
      const suffix = configuredSuffix || new URL(localOrigin).hostname.split(".").slice(1).join(".");
      return value === url.origin && url.protocol === "https:" && url.username === "" && url.password === "" && url.port === ""
        && url.pathname === "/" && url.search === "" && url.hash === "" && suffix.length > 0
        && url.hostname.endsWith(`.${suffix}`);
    } catch {
      return false;
    }
  }

  #validAssignment(value: ImmutableTaskAssignment): boolean {
    return isRecord(value) && isNonEmptyString(value.taskId) && this.#validAddress(value.source) && this.#validAddress(value.target)
      && isNonEmptyString(value.task) && isNonEmptyString(value.createdAt) && isNonEmptyString(value.expiresAt)
      && (value.preflight === undefined || (isRecord(value.preflight) && (value.preflight.requiredProject === undefined || isNonEmptyString(value.preflight.requiredProject))));
  }

  #validPeerEvent(value: TaskEventInput): boolean {
    return isRecord(value) && isNonEmptyString(value.id) && isNonEmptyString(value.taskId)
      && typeof value.type === "string" && typeof value.actor === "string" && isNonEmptyString(value.occurredAt)
      && isRecord(value.payload);
  }

  #validOptionalFields(input: SendInput): boolean {
    return (input.role === undefined || isNonEmptyString(input.role)) && (input.onCompletePrompt === undefined || isNonEmptyString(input.onCompletePrompt))
      && (input.idempotencyKey === undefined || isNonEmptyString(input.idempotencyKey))
      && (input.context === undefined || isRecord(input.context)) && (input.metadata === undefined || isRecord(input.metadata));
  }

  #isParticipant(ledger: TaskLedger, sessionId: string): boolean {
    return ledger.header.participants.parent.sessionId === sessionId || ledger.header.participants.receiver.sessionId === sessionId;
  }

  #warningsFor(ledger: TaskLedger): readonly TaskWarning[] {
    return [...ledger.state.warnings, ...ledger.records.flatMap((record) => record.kind === "diagnostic"
      ? [{ code: record.code, message: record.message }]
      : [])];
  }

  async #findIdempotency(address: TaskAddress, key: string): Promise<{ readonly taskId: string; readonly assignmentHash: string } | undefined> {
    for (const ledger of await this.#store.ledgers()) {
      const record = ledger.records.find((candidate) => candidate.kind === "idempotency" && candidate.scope.machine === address.machine && candidate.scope.sessionId === address.sessionId && candidate.scope.key === key);
      if (record?.kind === "idempotency") return record;
    }
    return undefined;
  }

  #contextWarnings(refs: readonly ContextRef[] | undefined, parentRoot: string, receiverRoot: string): readonly TaskWarning[] {
    return refs?.flatMap((ref) => this.#containedReference(ref.path, parentRoot, receiverRoot)) ?? [];
  }

  #containedReference(path: string, parentRoot: string, receiverRoot: string): readonly TaskWarning[] {
    if (!isNonEmptyString(path)) return [{ code: "INVALID_REF", message: "context ref path is invalid" }];
    const allowedRoots = isAbsolute(path) ? [parentRoot, receiverRoot] : [receiverRoot];
    const candidate = isAbsolute(path) ? path : resolve(receiverRoot, path);
    try {
      const actual = realpathSync(candidate);
      if (!allowedRoots.some((root) => this.#inside(actual, realpathSync(root)))) return [{ code: "INVALID_REF", message: `context ref escapes its project root: ${path}` }];
      return [];
    } catch { return [{ code: "MISSING_REF", message: `context ref is unavailable: ${path}` }]; }
  }

  #artifactProjection(artifacts: readonly ArtifactInput[] | undefined, projectRoot: string): TaskCompletionProjection {
    const warnings: TaskWarning[] = [];
    const projected: TaskArtifactProjection[] = [];
    const declaredPaths = new Set<string>();
    if ((artifacts?.length ?? 0) > TASK_LIMITS.ARTIFACTS) return { artifacts: undefined, warnings: [{ code: "INVALID_ARTIFACT", message: "too many artifacts" }] };
    for (const artifact of artifacts ?? []) {
      if (!isNonEmptyString(artifact.path) || isAbsolute(artifact.path)) { warnings.push({ code: "INVALID_ARTIFACT", message: "artifact paths must be project-relative" }); continue; }
      if (declaredPaths.has(artifact.path)) { warnings.push({ code: "INVALID_ARTIFACT", message: "duplicate artifact declaration" }); continue; }
      declaredPaths.add(artifact.path);
      const candidate = resolve(projectRoot, artifact.path);
      try {
        const root = realpathSync(projectRoot);
        const actual = realpathSync(candidate);
        if (!this.#inside(actual, root) || lstatSync(candidate).isSymbolicLink() || !statSync(actual).isFile()) throw new Error("invalid artifact");
        projected.push({ sourcePath: artifact.path, machine: this.#machineId, project: basename(root), normalizedPath: relative(root, actual), sizeBytes: statSync(actual).size, modifiedAt: statSync(actual).mtime.toISOString() });
      } catch { warnings.push({ code: "INVALID_ARTIFACT", message: `artifact is unavailable or outside project: ${artifact.path}` }); }
    }
    return { artifacts: projected.length === 0 ? undefined : projected, warnings };
  }

  #inside(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
  }
}

let singleton: TaskGateway | undefined;

export function getTaskGateway(): TaskGateway {
  singleton ??= new TaskGateway({ root: process.env.WOLFPACK_TASK_ROOT });
  return singleton;
}

export function __resetTaskGatewayForTests(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("task gateway reset is test-only");
  singleton = undefined;
}
