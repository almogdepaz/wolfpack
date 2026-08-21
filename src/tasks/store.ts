import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  canonicalJson as serializeCanonicalJson,
  compareCanonicalJsonKeysByLocale,
} from "../canonical-json.ts";
import {
  TASK_API_ERROR,
  TASK_EVENT_TYPE,
  TASK_STATUS,
  acceptSenderEvent,
  hashImmutableAssignment,
  rebuildTaskState,
} from "./domain.ts";
import type {
  CanonicalTaskEvent,
  ImmutableTaskAssignment,
  SenderEventAcceptance,
  TaskAddress,
  TaskCompletionProjection,
  TaskEventInput,
  TaskParticipants,
  TaskStateSnapshot,
  VerifiedTaskPrincipal,
} from "./domain.ts";

export const TASK_LEDGER_ROLE = {
  SENDER: "sender",
  RECEIVER: "receiver",
} as const;

export type TaskLedgerRole = (typeof TASK_LEDGER_ROLE)[keyof typeof TASK_LEDGER_ROLE];

export interface TaskLedgerKey {
  readonly role: TaskLedgerRole;
  readonly sourceMachine: string;
  readonly taskId: string;
}

export interface TaskLedgerPaths {
  readonly root: string;
  readonly ledgerPath: string;
  readonly cachePath: string;
  readonly quarantinePath: string;
  readonly tombstonePath: string;
  readonly inboxIndexPath: string;
  readonly deliverySequencePath: string;
}

export interface TaskLedgerHeader {
  readonly kind: "task.header";
  readonly id: "header";
  readonly version: 1;
  readonly key: TaskLedgerKey;
  readonly assignment: ImmutableTaskAssignment;
  readonly assignmentHash: string;
  readonly participants: TaskParticipants;
}

export interface TaskEventLedgerRecord {
  readonly kind: "event";
  readonly id: string;
  readonly event: CanonicalTaskEvent;
}

export interface TaskInboxLedgerRecord {
  readonly kind: "inbox";
  readonly id: string;
  readonly eventId: string;
  readonly deliverySequence: string;
  readonly occurredAt: string;
}

export interface TaskOutboxAttemptRecord {
  readonly kind: "outbox.attempt";
  readonly id: string;
  readonly eventId: string;
  readonly attempt: number;
  readonly occurredAt: string;
}

export interface TaskOutboxDeliveredRecord {
  readonly kind: "outbox.delivered";
  readonly id: string;
  readonly eventId: string;
  readonly occurredAt: string;
}

export interface TaskAcknowledgementRecord {
  readonly kind: "acknowledgment";
  readonly id: string;
  readonly eventId: string;
  readonly occurredAt: string;
}

export interface TaskPeerReceiptRecord {
  readonly kind: "peer.receipt";
  readonly id: string;
  readonly source: TaskAddress;
  readonly taskId: string;
  readonly assignmentHash: string;
  readonly createdEventId: string;
  readonly receiptId: string;
}

export interface TaskDiagnosticRecord {
  readonly kind: "diagnostic";
  readonly id: string;
  readonly code: string;
  readonly message: string;
  readonly occurredAt: string;
}

export interface TaskScopedIdempotencyRecord {
  readonly kind: "idempotency";
  readonly id: string;
  readonly scope: { readonly machine: string; readonly sessionId: string; readonly key: string };
  readonly assignmentHash: string;
  readonly taskId: string;
}

export interface TaskOutboundIntentRecord {
  readonly kind: "outbox.intent";
  readonly id: string;
  readonly event: TaskEventInput;
  readonly deliveryState: "pending";
}

export interface TaskCleanupEligibilityRecord {
  readonly kind: "cleanup.eligible";
  readonly id: string;
  readonly acknowledgedEventId: string;
  readonly occurredAt: string;
}

export type TaskLedgerRecord =
  | TaskEventLedgerRecord
  | TaskInboxLedgerRecord
  | TaskOutboxAttemptRecord
  | TaskOutboxDeliveredRecord
  | TaskAcknowledgementRecord
  | TaskPeerReceiptRecord
  | TaskDiagnosticRecord
  | TaskScopedIdempotencyRecord
  | TaskOutboundIntentRecord
  | TaskCleanupEligibilityRecord;

export interface TaskTombstone {
  readonly version: 1;
  readonly key: TaskLedgerKey;
  readonly assignmentHash: string;
  readonly writtenAt: string;
}

export interface TaskLedger {
  readonly key: TaskLedgerKey;
  readonly paths: TaskLedgerPaths;
  readonly header: TaskLedgerHeader;
  readonly records: readonly TaskLedgerRecord[];
  readonly state: TaskStateSnapshot;
  readonly truncatedTailBytes: number;
}

export type CreateLedgerResult =
  | { readonly kind: "created"; readonly ledger: TaskLedger }
  | { readonly kind: "reused"; readonly ledger: TaskLedger }
  | { readonly kind: "tombstoned"; readonly tombstone: TaskTombstone }
  | { readonly kind: "conflict"; readonly code: typeof TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT };

export type AppendRecordResult =
  | { readonly kind: "appended"; readonly record: TaskLedgerRecord }
  | { readonly kind: "reused"; readonly record: TaskLedgerRecord }
  | { readonly kind: "conflict"; readonly code: typeof TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT };

export interface TaskInboxEntry {
  readonly key: TaskLedgerKey;
  readonly eventId: string;
  readonly deliverySequence: string;
}

export interface TaskStoreTestHooks {
  readonly beforeFsync: ((step: "ledger-file" | "ledger-parent-directory" | "ledger-directory" | "delivery-sequence-file" | "quarantine-source-directory" | "quarantine-destination-directory" | "cleanup-ledger-directory" | "cleanup-tombstone-directory", path: string) => void) | undefined;
  readonly afterFsync: ((step: "ledger-file" | "ledger-parent-directory" | "ledger-directory" | "delivery-sequence-file" | "quarantine-source-directory" | "quarantine-destination-directory" | "cleanup-ledger-directory" | "cleanup-tombstone-directory", path: string) => void) | undefined;
}

export interface TaskStoreOptions {
  /** Test-only root injection; production defaults to the machine-global Wolfpack store. */
  readonly root: string | undefined;
  /** Narrow fault-injection seam; production uses real filesystem operations. */
  readonly testHooks?: TaskStoreTestHooks;
}

export class TaskStoreError extends Error {
  readonly code = TASK_API_ERROR.STORE_UNAVAILABLE;

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "TaskStoreError";
  }
}

// A Wolfpack server owns one TaskStore; its mutable indexes and locks are intentionally instance-local.

function canonicalJson(value: unknown): string {
  return serializeCanonicalJson(value, compareCanonicalJsonKeysByLocale);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safePathSegment(value: string): string {
  return digest(value).slice(0, 32);
}

function keyString(key: TaskLedgerKey): string {
  return `${key.role}\u0000${key.sourceMachine}\u0000${key.taskId}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRole(value: unknown): value is TaskLedgerRole {
  return value === TASK_LEDGER_ROLE.SENDER || value === TASK_LEDGER_ROLE.RECEIVER;
}

function isKey(value: unknown): value is TaskLedgerKey {
  return isObject(value) && isRole(value.role) && typeof value.sourceMachine === "string" && value.sourceMachine.length > 0
    && typeof value.taskId === "string" && value.taskId.length > 0;
}

function isHeader(value: unknown): value is TaskLedgerHeader {
  if (!isObject(value) || value.kind !== "task.header" || value.id !== "header" || value.version !== 1
    || !isKey(value.key) || !isObject(value.assignment) || !/^[a-f0-9]{64}$/.test(String(value.assignmentHash)) || !isObject(value.participants)) return false;
  const assignment = value.assignment;
  const participants = value.participants;
  const source = assignment.source;
  const target = assignment.target;
  const parent = participants.parent;
  const receiver = participants.receiver;
  return typeof assignment.taskId === "string" && assignment.taskId === value.key.taskId && isAddress(source)
    && source.machine === value.key.sourceMachine && isAddress(target) && typeof assignment.task === "string"
    && typeof assignment.createdAt === "string" && typeof assignment.expiresAt === "string"
    && isAddress(parent) && isAddress(receiver) && isAddress(participants.sender)
    && parent.machine === source.machine && parent.sessionId === source.sessionId
    && receiver.machine === target.machine && receiver.sessionId === target.sessionId;
}

function isAddress(value: unknown): value is TaskAddress {
  return isObject(value) && typeof value.machine === "string" && value.machine.length > 0
    && typeof value.sessionId === "string" && value.sessionId.length > 0;
}

function isStoredCompletion(value: unknown): boolean {
  if (!isObject(value) || typeof value.summary !== "string" || value.summary.length === 0) return false;
  if (value.result !== undefined && !isObject(value.result)) return false;
  if (value.error !== undefined && (!isObject(value.error) || typeof value.error.code !== "string" || value.error.code.length === 0
    || typeof value.error.message !== "string" || value.error.message.length === 0 || typeof value.error.retryable !== "boolean")) return false;
  if (value.artifacts !== undefined && (!Array.isArray(value.artifacts) || value.artifacts.length > 20 || !value.artifacts.every((artifact) => isObject(artifact)
    && typeof artifact.machine === "string" && artifact.machine.length > 0 && typeof artifact.project === "string" && artifact.project.length > 0
    && typeof artifact.path === "string" && artifact.path.length > 0 && (artifact.mimeType === undefined || typeof artifact.mimeType === "string")
    && (artifact.description === undefined || typeof artifact.description === "string") && (artifact.modifiedAt === undefined || typeof artifact.modifiedAt === "string")
    && (artifact.sizeBytes === undefined || (Number.isInteger(artifact.sizeBytes) && (artifact.sizeBytes as number) >= 0))))) return false;
  return value.warnings === undefined || (Array.isArray(value.warnings) && value.warnings.every((warning) => isObject(warning)
    && typeof warning.code === "string" && warning.code.length > 0 && typeof warning.message === "string" && warning.message.length > 0));
}

function isCanonicalEvent(value: unknown): value is CanonicalTaskEvent {
  if (!isObject(value) || typeof value.id !== "string" || value.id.length === 0 || typeof value.taskId !== "string" || value.taskId.length === 0
    || !Object.values(TASK_EVENT_TYPE).includes(value.type as never) || (value.actor !== "parent" && value.actor !== "receiver" && value.actor !== "sender")
    || !isAddress(value.source) || !isAddress(value.destination) || !/^(0|[1-9][0-9]*)$/.test(String(value.sequence)) || typeof value.occurredAt !== "string"
    || (value.message !== undefined && typeof value.message !== "string") || (value.replyToMessageId !== undefined && typeof value.replyToMessageId !== "string")
    || !isObject(value.payload) || typeof value.payload.kind !== "string") return false;
  if (value.completion !== undefined && !isStoredCompletion(value.completion)) return false;

  switch (value.payload.kind) {
    case "none":
      return true;
    case "receipt_confirmation":
      return typeof value.payload.receiptId === "string" && typeof value.payload.assignmentHash === "string"
        && typeof value.payload.createdEventId === "string" && typeof value.payload.receivedEventId === "string"
        && /^(0|[1-9][0-9]*)$/.test(String(value.payload.receivedEventSequence)) && typeof value.payload.receivedEventOccurredAt === "string";
    case "parent_ack":
      return typeof value.payload.pendingAckEventId === "string";
    case "delivery":
      return typeof value.payload.injectedEventId === "string" && value.payload.injectedEventId.length > 0;
    case "delivery_failure":
      return typeof value.payload.code === "string" && typeof value.payload.message === "string";
    case "late_terminal":
      return (value.payload.originalType === TASK_EVENT_TYPE.COMPLETED || value.payload.originalType === TASK_EVENT_TYPE.FAILED
        || value.payload.originalType === TASK_EVENT_TYPE.CANCELLED || value.payload.originalType === TASK_EVENT_TYPE.TIMED_OUT)
        && typeof value.payload.originalEventId === "string";
    default:
      return false;
  }
}

function isLedgerRecord(value: unknown): value is TaskLedgerRecord {
  if (!isObject(value) || typeof value.id !== "string" || value.id.length === 0) return false;
  switch (value.kind) {
    case "event":
      return isCanonicalEvent(value.event) && value.id === value.event.id;
    case "inbox":
      return typeof value.eventId === "string" && value.eventId.length > 0 && /^(0|[1-9][0-9]*)$/.test(String(value.deliverySequence)) && typeof value.occurredAt === "string";
    case "outbox.attempt":
      return typeof value.eventId === "string" && value.eventId.length > 0 && Number.isInteger(value.attempt) && (value.attempt as number) > 0 && typeof value.occurredAt === "string";
    case "outbox.delivered":
    case "acknowledgment":
      return typeof value.eventId === "string" && value.eventId.length > 0 && typeof value.occurredAt === "string";
    case "peer.receipt":
      return isAddress(value.source) && typeof value.taskId === "string" && value.taskId.length > 0
        && /^[a-f0-9]{64}$/.test(String(value.assignmentHash)) && typeof value.createdEventId === "string" && value.createdEventId.length > 0
        && typeof value.receiptId === "string" && value.receiptId.length > 0;
    case "diagnostic":
      return typeof value.code === "string" && typeof value.message === "string" && typeof value.occurredAt === "string";
    case "idempotency":
      return isObject(value.scope) && typeof value.scope.machine === "string" && value.scope.machine.length > 0
        && typeof value.scope.sessionId === "string" && value.scope.sessionId.length > 0 && typeof value.scope.key === "string" && value.scope.key.length > 0
        && /^[a-f0-9]{64}$/.test(String(value.assignmentHash)) && typeof value.taskId === "string" && value.taskId.length > 0;
    case "outbox.intent":
      return isObject(value.event) && typeof value.event.id === "string" && value.event.id.length > 0
        && typeof value.event.taskId === "string" && value.event.taskId.length > 0
        && (value.event.actor === "parent" || value.event.actor === "receiver" || value.event.actor === "sender") && value.deliveryState === "pending";
    case "cleanup.eligible":
      return typeof value.acknowledgedEventId === "string" && value.acknowledgedEventId.length > 0 && typeof value.occurredAt === "string";
    default:
      return false;
  }
}

function sameKey(left: TaskLedgerKey, right: TaskLedgerKey): boolean {
  return left.role === right.role && left.sourceMachine === right.sourceMachine && left.taskId === right.taskId;
}

function lock<T>(locks: Map<string, Promise<void>>, name: string, operation: () => Promise<T>): Promise<T> {
  const previous = (locks.get(name) ?? Promise.resolve()).catch(() => undefined);
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  const queued = previous.then(() => current);
  locks.set(name, queued);

  return previous.then(operation).finally(() => {
    release?.();
    if (locks.get(name) === queued) locks.delete(name);
  });
}

function fsyncFile(path: string, data: string, append: boolean): void {
  const descriptor = openSync(path, append ? "a" : "w", 0o600);
  try {
    if (append) appendFileSync(descriptor, data, "utf-8");
    else writeFileSync(descriptor, data, "utf-8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  fsyncFile(temporaryPath, data, false);
  renameSync(temporaryPath, path);
  fsyncDirectory(dirname(path));
}

function containedPath(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, ...segments);
  if (path !== resolvedRoot && !path.startsWith(`${resolvedRoot}/`)) {
    throw new TypeError("generated task store path escapes its configured root");
  }
  return path;
}

export function taskStorePaths(root: string = join(homedir(), ".wolfpack", "tasks"), key: TaskLedgerKey | undefined = undefined): TaskLedgerPaths {
  const resolvedRoot = resolve(root);
  const ledgerSegment = key === undefined
    ? "placeholder"
    : `${key.role}-${safePathSegment(key.sourceMachine)}-${safePathSegment(key.taskId)}`;
  const ledgerPath = containedPath(resolvedRoot, "ledgers", key?.role ?? "sender", `${ledgerSegment}.jsonl`);
  return {
    root: resolvedRoot,
    ledgerPath,
    cachePath: containedPath(resolvedRoot, "cache", `${ledgerSegment}.json`),
    quarantinePath: containedPath(resolvedRoot, "quarantine", `${ledgerSegment}.jsonl`),
    tombstonePath: containedPath(resolvedRoot, "tombstones", `${ledgerSegment}.json`),
    inboxIndexPath: containedPath(resolvedRoot, "cache", "inbox-index.json"),
    deliverySequencePath: containedPath(resolvedRoot, "delivery-sequence.json"),
  };
}

function readDeliverySequence(path: string): bigint | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!isObject(parsed) || parsed.version !== 1 || typeof parsed.nextDeliverySequence !== "string"
    || !/^[1-9][0-9]*$/.test(parsed.nextDeliverySequence)) {
    throw new TypeError("delivery sequence metadata is malformed");
  }
  return BigInt(parsed.nextDeliverySequence);
}

function readTombstoneAt(path: string, expectedKey: TaskLedgerKey | undefined = undefined): TaskTombstone | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!isObject(parsed) || parsed.version !== 1 || !isKey(parsed.key) || typeof parsed.assignmentHash !== "string" || typeof parsed.writtenAt !== "string") {
    throw new TypeError("task tombstone is malformed");
  }
  if (expectedKey !== undefined && !sameKey(parsed.key, expectedKey)) throw new TypeError("task tombstone key does not match its path");
  return { version: 1, key: parsed.key, assignmentHash: parsed.assignmentHash, writtenAt: parsed.writtenAt };
}

async function parseLedger(path: string): Promise<TaskLedger> {
  const text = readFileSync(path, "utf-8");
  const endsWithNewline = text.endsWith("\n");
  const completeText = endsWithNewline ? text.slice(0, -1) : text.slice(0, Math.max(0, text.lastIndexOf("\n")));
  const truncatedTail = endsWithNewline ? "" : text.slice(completeText.length);
  const lines = completeText.length === 0 ? [] : completeText.split("\n");
  const parsed = lines.map((line) => JSON.parse(line) as unknown);
  const header = parsed.shift();
  if (!isHeader(header)) throw new TypeError("task ledger is missing a valid header");
  const records = parsed.map((record) => {
    if (!isLedgerRecord(record)) throw new TypeError("task ledger contains a malformed record");
    return record;
  });
  if (await hashImmutableAssignment(header.assignment) !== header.assignmentHash) {
    throw new TypeError("task ledger header has an invalid immutable assignment hash");
  }
  const paths = taskStorePaths(dirname(dirname(dirname(path))), header.key);
  if (paths.ledgerPath !== path) throw new TypeError("task ledger is stored at an unexpected path");
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new TypeError("task ledger repeats a record identity");
    ids.add(record.id);
  }
  const events = records.filter((record): record is TaskEventLedgerRecord => record.kind === "event").map((record) => record.event);
  return {
    key: header.key,
    paths,
    header,
    records,
    state: rebuildTaskState(header.key.taskId, header.participants, events),
    truncatedTailBytes: new TextEncoder().encode(truncatedTail).byteLength,
  };
}

function ledgerCache(ledger: TaskLedger): string {
  return canonicalJson({ version: 1, key: ledger.key, assignmentHash: ledger.header.assignmentHash, state: ledger.state, records: ledger.records });
}

export class TaskStore {
  readonly root: string;
  readonly #ledgers = new Map<string, TaskLedger>();
  readonly #inbox = new Map<string, TaskInboxEntry>();
  readonly #idempotency = new Map<string, TaskScopedIdempotencyRecord>();
  readonly #taskLocks = new Map<string, Promise<void>>();
  readonly #deliverySequenceLocks = new Map<string, Promise<void>>();
  readonly #idempotencyLocks = new Map<string, Promise<void>>();
  readonly #rebuiltLedgerKeys = new Set<string>();
  readonly #testHooks: TaskStoreTestHooks | undefined;
  #nextDeliverySequence = 1n;
  #initialized: Promise<void> | undefined;

  constructor(options: TaskStoreOptions = { root: undefined, testHooks: undefined }) {
    this.root = taskStorePaths(options.root).root;
    this.#testHooks = options.testHooks;
  }

  async initialize(): Promise<void> {
    this.#initialized ??= this.#rebuild();
    return this.#initialized;
  }

  #createDurableDirectory(path: string): void {
    const chain: string[] = [];
    for (let directory = path; directory !== dirname(this.root); directory = dirname(directory)) chain.push(directory);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    for (const directory of chain.reverse()) {
      const parent = dirname(directory);
      this.#testHooks?.beforeFsync?.("ledger-parent-directory", parent);
      fsyncDirectory(parent);
      this.#testHooks?.afterFsync?.("ledger-parent-directory", parent);
    }
  }

  async createLedger(input: {
    readonly role: TaskLedgerRole;
    readonly assignment: ImmutableTaskAssignment;
    readonly participants: TaskParticipants;
  }): Promise<CreateLedgerResult> {
    await this.initialize();
    const assignmentHash = await hashImmutableAssignment(input.assignment);
    const key: TaskLedgerKey = { role: input.role, sourceMachine: input.assignment.source.machine, taskId: input.assignment.taskId };
    return lock(this.#taskLocks, keyString(key), async () => {
      try {
        const paths = taskStorePaths(this.root, key);
        const tombstone = readTombstoneAt(paths.tombstonePath, key);
        if (tombstone) {
          return tombstone.assignmentHash === assignmentHash
            ? { kind: "tombstoned", tombstone }
            : { kind: "conflict", code: TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT };
        }
        if (existsSync(paths.quarantinePath)) throw new TypeError("task ledger is quarantined");
        let existing = this.#ledgers.get(keyString(key));
        if (!existing && existsSync(paths.ledgerPath)) {
          existing = await parseLedger(paths.ledgerPath);
          this.#setLedger(existing);
        }
        if (existing) {
          return existing.header.assignmentHash === assignmentHash
            ? { kind: "reused", ledger: existing }
            : { kind: "conflict", code: TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT };
        }

        this.#createDurableDirectory(dirname(paths.ledgerPath));
        const header: TaskLedgerHeader = { kind: "task.header", id: "header", version: 1, key, assignment: input.assignment, assignmentHash, participants: input.participants };
        this.#testHooks?.beforeFsync?.("ledger-file", paths.ledgerPath);
        fsyncFile(paths.ledgerPath, `${canonicalJson(header)}\n`, true);
        this.#testHooks?.afterFsync?.("ledger-file", paths.ledgerPath);
        this.#testHooks?.beforeFsync?.("ledger-directory", dirname(paths.ledgerPath));
        fsyncDirectory(dirname(paths.ledgerPath));
        this.#testHooks?.afterFsync?.("ledger-directory", dirname(paths.ledgerPath));
        const ledger = await parseLedger(paths.ledgerPath);
        this.#setLedger(ledger);
        return { kind: "created", ledger };
      } catch (error: unknown) {
        throw this.#storeError("could not create task ledger", error);
      }
    });
  }

  async appendEvent(ledger: TaskLedger, event: CanonicalTaskEvent): Promise<AppendRecordResult> {
    return this.#appendRecord(ledger.key, { kind: "event", id: event.id, event });
  }

  /** The sender store owns validation, sequence allocation, and its authoritative append as one task lock. */
  async acceptCanonicalEvent(
    key: TaskLedgerKey,
    input: TaskEventInput,
    principal: VerifiedTaskPrincipal,
    projection: TaskCompletionProjection | undefined = undefined,
  ): Promise<SenderEventAcceptance> {
    await this.initialize();
    return lock(this.#taskLocks, keyString(key), async () => {
      const ledger = this.#ledgers.get(keyString(key));
      if (!ledger) throw new TaskStoreError("sender task ledger does not exist", undefined);
      const accepted = acceptSenderEvent(ledger.state, input, principal, projection);
      if (accepted.kind === "accepted" || accepted.kind === "late-terminal") {
        const appended = this.#appendRecordLocked(ledger, { kind: "event", id: accepted.event.id, event: accepted.event });
        if (appended.kind === "conflict") throw new TaskStoreError("canonical event conflicts with existing record", appended);
      }
      return accepted;
    });
  }

  async appendInboxRecord(
    ledger: TaskLedger,
    input: { readonly id: string; readonly eventId: string; readonly occurredAt: string },
  ): Promise<TaskInboxLedgerRecord> {
    await this.initialize();
    return lock(this.#deliverySequenceLocks, "delivery-sequence", async () => {
      const current = this.#ledgers.get(keyString(ledger.key));
      const existing = current?.records.find((record) => record.id === input.id);
      if (existing) {
        if (existing.kind === "inbox" && existing.eventId === input.eventId && existing.occurredAt === input.occurredAt) return existing;
        throw new TaskStoreError("inbox record identity conflicts with prior content", existing);
      }
      let deliverySequence: string;
      try {
        deliverySequence = this.#reserveDeliverySequence();
      } catch (error: unknown) {
        throw this.#storeError("could not reserve inbox delivery sequence", error);
      }
      const result = await this.#appendRecord(ledger.key, { kind: "inbox", ...input, deliverySequence });
      if (result.kind === "conflict") throw new TaskStoreError("could not append inbox record", result);
      if (result.record.kind !== "inbox") throw new TaskStoreError("task ledger reused a non-inbox record", result.record);
      return result.record;
    });
  }

  async appendOutboxAttempt(ledger: TaskLedger, record: Omit<TaskOutboxAttemptRecord, "kind">): Promise<AppendRecordResult> {
    const current = this.#ledgers.get(keyString(ledger.key));
    if (!current?.records.some((candidate) => candidate.kind === "outbox.intent" && candidate.event.id === record.eventId)) {
      throw new TaskStoreError("outbox attempt must reference a durable receiver outbound intent", undefined);
    }
    return this.#appendRecord(ledger.key, { kind: "outbox.attempt", ...record });
  }

  async appendOutboxDelivered(ledger: TaskLedger, record: Omit<TaskOutboxDeliveredRecord, "kind">): Promise<AppendRecordResult> {
    const current = this.#ledgers.get(keyString(ledger.key));
    if (!current?.records.some((candidate) => candidate.kind === "outbox.intent" && candidate.event.id === record.eventId)) {
      throw new TaskStoreError("outbox delivery must reference a durable outbound intent", undefined);
    }
    return this.#appendRecord(ledger.key, { kind: "outbox.delivered", ...record });
  }

  async appendAcknowledgment(ledger: TaskLedger, record: Omit<TaskAcknowledgementRecord, "kind">): Promise<AppendRecordResult> {
    return this.#appendRecord(ledger.key, { kind: "acknowledgment", ...record });
  }

  async appendScopedIdempotency(
    ledger: TaskLedger,
    record: Omit<TaskScopedIdempotencyRecord, "kind">,
  ): Promise<AppendRecordResult> {
    if (ledger.key.role !== TASK_LEDGER_ROLE.SENDER || record.taskId !== ledger.key.taskId
      || record.assignmentHash !== ledger.header.assignmentHash || record.scope.machine !== ledger.header.participants.parent.machine
      || record.scope.sessionId !== ledger.header.participants.parent.sessionId) {
      throw new TaskStoreError("scoped idempotency record has invalid sender identity", undefined);
    }
    const scopeKey = `${record.scope.machine}\u0000${record.scope.sessionId}\u0000${record.scope.key}`;
    return lock(this.#idempotencyLocks, scopeKey, async () => {
      const existing = this.#idempotency.get(scopeKey);
      if (existing) {
        return existing.assignmentHash === record.assignmentHash && existing.taskId === record.taskId
          ? { kind: "reused", record: existing }
          : { kind: "conflict", code: TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT };
      }
      return this.#appendRecord(ledger.key, { kind: "idempotency", ...record });
    });
  }

  async appendOutboundIntent(ledger: TaskLedger, event: TaskEventInput): Promise<AppendRecordResult> {
    if (event.taskId !== ledger.key.taskId) {
      throw new TaskStoreError("outbound intent must belong to its task ledger", undefined);
    }
    return this.#appendRecord(ledger.key, {
      kind: "outbox.intent",
      id: `outbox.intent:${event.id}`,
      event,
      deliveryState: "pending",
    });
  }

  async appendPeerReceipt(ledger: TaskLedger, record: Omit<TaskPeerReceiptRecord, "kind">): Promise<AppendRecordResult> {
    if (ledger.key.role !== TASK_LEDGER_ROLE.RECEIVER || record.taskId !== ledger.key.taskId
      || record.source.machine !== ledger.key.sourceMachine || record.assignmentHash !== ledger.header.assignmentHash
      || record.createdEventId.length === 0) {
      throw new TaskStoreError("peer receipt does not match its provisional receiver ledger", undefined);
    }
    return this.#appendRecord(ledger.key, { kind: "peer.receipt", ...record });
  }

  async appendDiagnostic(ledger: TaskLedger, record: Omit<TaskDiagnosticRecord, "kind">): Promise<AppendRecordResult> {
    return this.#appendRecord(ledger.key, { kind: "diagnostic", ...record });
  }

  async markCleanupEligible(ledger: TaskLedger, record: Omit<TaskCleanupEligibilityRecord, "kind">): Promise<AppendRecordResult> {
    await this.initialize();
    const current = this.#ledgers.get(keyString(ledger.key));
    if (ledger.key.role !== TASK_LEDGER_ROLE.RECEIVER
      || !current?.records.some((candidate) => candidate.kind === "acknowledgment" && candidate.id === record.acknowledgedEventId)) {
      throw new TaskStoreError("receiver cleanup eligibility requires its durable acknowledgment record", undefined);
    }
    return this.#appendRecord(ledger.key, { kind: "cleanup.eligible", ...record });
  }

  async getLedger(key: TaskLedgerKey): Promise<TaskLedger | undefined> {
    await this.initialize();
    return this.#ledgers.get(keyString(key));
  }

  async ledgers(): Promise<readonly TaskLedger[]> {
    await this.initialize();
    return [...this.#ledgers.values()];
  }

  /** Startup recovery is intentionally limited to ledgers rebuilt during this process's initialization. */
  async wasRebuiltOnStartup(ledger: TaskLedger): Promise<boolean> {
    await this.initialize();
    return this.#rebuiltLedgerKeys.has(keyString(ledger.key));
  }

  async tombstones(): Promise<readonly TaskTombstone[]> {
    await this.initialize();
    try {
      const directory = containedPath(this.root, "tombstones");
      if (!existsSync(directory)) return [];
      const tombstones: TaskTombstone[] = [];
      for (const name of readdirSync(directory)) {
        if (!name.endsWith(".json")) continue;
        const tombstone = readTombstoneAt(containedPath(directory, name));
        if (tombstone) tombstones.push(tombstone);
      }
      return tombstones;
    } catch (error: unknown) {
      throw this.#storeError("could not read task tombstones", error);
    }
  }

  /** Deletes only generated payload files after their durable tombstone exists. */
  async removeLedgerPayload(ledger: TaskLedger): Promise<boolean> {
    await this.initialize();
    return lock(this.#taskLocks, keyString(ledger.key), async () => {
      try {
        const current = this.#ledgers.get(keyString(ledger.key));
        if (!current) return false;
        const tombstone = readTombstoneAt(current.paths.tombstonePath, current.key);
        if (!tombstone || tombstone.assignmentHash !== current.header.assignmentHash) {
          throw new TypeError("task payload deletion requires its matching tombstone");
        }
        const removed = this.#unlinkGeneratedFile(current.paths.ledgerPath);
        if (removed) {
          this.#testHooks?.beforeFsync?.("cleanup-ledger-directory", dirname(current.paths.ledgerPath));
          fsyncDirectory(dirname(current.paths.ledgerPath));
          this.#testHooks?.afterFsync?.("cleanup-ledger-directory", dirname(current.paths.ledgerPath));
        }
        // Caches are derived: failure to remove one cannot undo the durable tombstone or payload deletion.
        try {
          this.#unlinkGeneratedFile(current.paths.cachePath);
        } catch {
          // Retried startup/access sweeps may remove a stale cache later.
        }
        this.#ledgers.delete(keyString(current.key));
        this.#rebuiltLedgerKeys.delete(keyString(current.key));
        for (const [inboxKey, entry] of this.#inbox) {
          if (sameKey(entry.key, current.key)) this.#inbox.delete(inboxKey);
        }
        for (const [scopeKey, record] of this.#idempotency) {
          if (record.taskId === current.key.taskId && record.assignmentHash === current.header.assignmentHash) this.#idempotency.delete(scopeKey);
        }
        try {
          this.#writeInboxIndex();
        } catch {
          // The index is derived and will be rebuilt from surviving ledgers.
        }
        return removed;
      } catch (error: unknown) {
        throw this.#storeError("could not remove task ledger payload", error);
      }
    });
  }

  /** Deletes only the exact generated tombstone after its retention period. */
  async removeTombstone(tombstone: TaskTombstone): Promise<boolean> {
    await this.initialize();
    return lock(this.#taskLocks, keyString(tombstone.key), async () => {
      try {
        const path = taskStorePaths(this.root, tombstone.key).tombstonePath;
        const current = readTombstoneAt(path, tombstone.key);
        if (!current) return false;
        if (current.assignmentHash !== tombstone.assignmentHash || current.writtenAt !== tombstone.writtenAt) {
          throw new TypeError("task tombstone changed before retention cleanup");
        }
        const removed = this.#unlinkGeneratedFile(path);
        if (removed) {
          this.#testHooks?.beforeFsync?.("cleanup-tombstone-directory", dirname(path));
          fsyncDirectory(dirname(path));
          this.#testHooks?.afterFsync?.("cleanup-tombstone-directory", dirname(path));
        }
        return removed;
      } catch (error: unknown) {
        throw this.#storeError("could not remove task tombstone", error);
      }
    });
  }

  async inboxAfter(cursor: string): Promise<{ readonly events: readonly TaskInboxEntry[]; readonly nextCursor: string }> {
    await this.initialize();
    if (!/^(0|[1-9][0-9]*)$/.test(cursor)) throw new TypeError("inbox cursor must be a decimal integer");
    const after = BigInt(cursor);
    const events = [...this.#inbox.values()]
      .filter((entry) => BigInt(entry.deliverySequence) > after)
      .sort((left, right) => BigInt(left.deliverySequence) < BigInt(right.deliverySequence) ? -1 : 1);
    return { events, nextCursor: events.at(-1)?.deliverySequence ?? cursor };
  }

  async writeTombstone(ledger: TaskLedger, writtenAt: string): Promise<TaskTombstone> {
    await this.initialize();
    return lock(this.#taskLocks, keyString(ledger.key), async () => {
      try {
        const tombstone: TaskTombstone = { version: 1, key: ledger.key, assignmentHash: ledger.header.assignmentHash, writtenAt };
        const existing = readTombstoneAt(ledger.paths.tombstonePath, ledger.key);
        if (existing) {
          if (!sameKey(existing.key, tombstone.key) || existing.assignmentHash !== tombstone.assignmentHash) {
            throw new TaskStoreError("task tombstone conflicts with prior immutable content", existing);
          }
          return existing;
        }
        this.#createDurableDirectory(dirname(ledger.paths.tombstonePath));
        atomicWrite(ledger.paths.tombstonePath, canonicalJson(tombstone));
        return tombstone;
      } catch (error: unknown) {
        throw this.#storeError("could not write task tombstone", error);
      }
    });
  }

  async readTombstone(key: TaskLedgerKey): Promise<TaskTombstone | undefined> {
    await this.initialize();
    try {
      return readTombstoneAt(taskStorePaths(this.root, key).tombstonePath, key);
    } catch (error: unknown) {
      throw this.#storeError("could not read task tombstone", error);
    }
  }

  async observability(): Promise<{ readonly retainedLedgerCount: number; readonly retainedLedgerBytes: number }> {
    await this.initialize();
    let retainedLedgerCount = 0;
    let retainedLedgerBytes = 0;
    for (const ledger of this.#ledgers.values()) {
      const terminal = ledger.state.status === TASK_STATUS.COMPLETED || ledger.state.status === TASK_STATUS.FAILED
        || ledger.state.status === TASK_STATUS.CANCELLED || ledger.state.status === TASK_STATUS.TIMED_OUT;
      if (!terminal || ledger.state.parentAcknowledgedEventId === undefined) {
        retainedLedgerCount += 1;
        retainedLedgerBytes += statSync(ledger.paths.ledgerPath).size;
      }
    }
    // Unresolved/unacknowledged ledgers deliberately never evict here; operators must monitor this disk-growth risk.
    return { retainedLedgerCount, retainedLedgerBytes };
  }

  async #appendRecord(key: TaskLedgerKey, record: TaskLedgerRecord): Promise<AppendRecordResult> {
    await this.initialize();
    return lock(this.#taskLocks, keyString(key), async () => {
      const ledger = this.#ledgers.get(keyString(key));
      if (!ledger) throw this.#storeError("could not append task ledger record", new TypeError("task ledger does not exist"));
      return this.#appendRecordLocked(ledger, record);
    });
  }

  #appendRecordLocked(ledger: TaskLedger, record: TaskLedgerRecord): AppendRecordResult {
    try {
      if (ledger.truncatedTailBytes > 0) throw new TypeError("task ledger has an uncommitted truncated tail");
      const existing = ledger.records.find((candidate) => candidate.id === record.id);
      if (existing) {
        return canonicalJson(existing) === canonicalJson(record)
          ? { kind: "reused", record: existing }
          : { kind: "conflict", code: TASK_API_ERROR.IMMUTABLE_CONTENT_CONFLICT };
      }
      const next = this.#deriveLedger(ledger.header, [...ledger.records, record], 0);
      this.#testHooks?.beforeFsync?.("ledger-file", ledger.paths.ledgerPath);
      fsyncFile(ledger.paths.ledgerPath, `${canonicalJson(record)}\n`, true);
      this.#testHooks?.afterFsync?.("ledger-file", ledger.paths.ledgerPath);
      this.#setLedger(next);
      return { kind: "appended", record };
    } catch (error: unknown) {
      throw this.#storeError("could not append task ledger record", error);
    }
  }

  #reserveDeliverySequence(): string {
    const deliverySequence = this.#nextDeliverySequence;
    const nextDeliverySequence = deliverySequence + 1n;
    const path = taskStorePaths(this.root).deliverySequencePath;
    this.#testHooks?.beforeFsync?.("delivery-sequence-file", path);
    atomicWrite(path, canonicalJson({ version: 1, nextDeliverySequence: nextDeliverySequence.toString() }));
    this.#testHooks?.afterFsync?.("delivery-sequence-file", path);
    this.#nextDeliverySequence = nextDeliverySequence;
    return deliverySequence.toString();
  }

  async #rebuild(): Promise<void> {
    try {
      const durableNextDeliverySequence = readDeliverySequence(taskStorePaths(this.root).deliverySequencePath);
      if (durableNextDeliverySequence !== undefined) this.#nextDeliverySequence = durableNextDeliverySequence;
      for (const role of Object.values(TASK_LEDGER_ROLE)) {
        const roleDirectory = containedPath(this.root, "ledgers", role);
        if (!existsSync(roleDirectory)) continue;
        for (const name of readdirSync(roleDirectory)) {
          if (name.endsWith(".jsonl")) await this.#loadPath(join(roleDirectory, name));
        }
      }
      try {
        this.#writeInboxIndex();
      } catch {
        // The index is derived and may be rebuilt after a transient cache failure.
      }
    } catch (error: unknown) {
      throw this.#storeError("could not rebuild task store", error);
    }
  }

  async #loadPath(path: string): Promise<void> {
    try {
      const ledger = await parseLedger(path);
      this.#setLedger(ledger);
      this.#rebuiltLedgerKeys.add(keyString(ledger.key));
    } catch (error: unknown) {
      for (const [key, ledger] of this.#ledgers) {
        if (ledger.paths.ledgerPath === path) {
          this.#ledgers.delete(key);
          for (const [inboxKey, entry] of this.#inbox) {
            if (sameKey(entry.key, ledger.key)) this.#inbox.delete(inboxKey);
          }
        }
      }
      const inferred = this.#pathToQuarantine(path);
      if (!inferred) throw error;
      mkdirSync(dirname(inferred), { recursive: true, mode: 0o700 });
      renameSync(path, inferred);
      this.#testHooks?.beforeFsync?.("quarantine-source-directory", dirname(path));
      fsyncDirectory(dirname(path));
      this.#testHooks?.afterFsync?.("quarantine-source-directory", dirname(path));
      if (dirname(inferred) !== dirname(path)) {
        this.#testHooks?.beforeFsync?.("quarantine-destination-directory", dirname(inferred));
        fsyncDirectory(dirname(inferred));
        this.#testHooks?.afterFsync?.("quarantine-destination-directory", dirname(inferred));
      }
    }
  }

  #pathToQuarantine(path: string): string | undefined {
    const name = path.split("/").at(-1);
    const role = path.split("/").at(-2);
    if (!name || !isRole(role) || !name.endsWith(".jsonl")) return undefined;
    return containedPath(this.root, "quarantine", name);
  }

  #deriveLedger(header: TaskLedgerHeader, records: readonly TaskLedgerRecord[], truncatedTailBytes: number): TaskLedger {
    const events = records.filter((record): record is TaskEventLedgerRecord => record.kind === "event").map((record) => record.event);
    const paths = taskStorePaths(this.root, header.key);
    return {
      key: header.key,
      paths,
      header,
      records,
      state: rebuildTaskState(header.key.taskId, header.participants, events),
      truncatedTailBytes,
    };
  }

  #setLedger(ledger: TaskLedger): void {
    this.#ledgers.set(keyString(ledger.key), ledger);
    for (const record of ledger.records) {
      if (record.kind === "inbox") {
        this.#inbox.set(`${keyString(ledger.key)}\u0000${record.id}`, {
          key: ledger.key,
          eventId: record.eventId,
          deliverySequence: record.deliverySequence,
        });
        const next = BigInt(record.deliverySequence) + 1n;
        if (next > this.#nextDeliverySequence) this.#nextDeliverySequence = next;
      }
      if (record.kind === "idempotency") {
        this.#idempotency.set(`${record.scope.machine}\u0000${record.scope.sessionId}\u0000${record.scope.key}`, record);
      }
    }
    // Caches are never authoritative: a cache failure cannot negate an fsynced ledger record.
    try {
      atomicWrite(ledger.paths.cachePath, ledgerCache(ledger));
      this.#writeInboxIndex();
    } catch {
      // The next startup rebuilds these derived artifacts from the JSONL ledgers.
    }
  }

  #writeInboxIndex(): void {
    atomicWrite(taskStorePaths(this.root).inboxIndexPath, canonicalJson({ version: 1, events: [...this.#inbox.values()] }));
  }

  #unlinkGeneratedFile(path: string): boolean {
    const resolvedRoot = resolve(this.root);
    const resolvedPath = resolve(path);
    if (resolvedPath === resolvedRoot || !resolvedPath.startsWith(`${resolvedRoot}/`)) {
      throw new TypeError("generated task store deletion escapes its configured root");
    }
    try {
      unlinkSync(path);
      return true;
    } catch (error: unknown) {
      if (isObject(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  #storeError(message: string, cause: unknown): TaskStoreError {
    return cause instanceof TaskStoreError ? cause : new TaskStoreError(message, cause);
  }
}
