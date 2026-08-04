import {
  TASK_EVENT_TYPE,
  TASK_STATUS,
  generateUuidV7,
} from "./domain.ts";
import type {
  CanonicalTaskEvent,
  TaskCompletionProjection,
  TaskEventInput,
  TaskStateSnapshot,
} from "./domain.ts";
import { TASK_LEDGER_ROLE, TaskStore } from "./store.ts";
import type { TaskLedger } from "./store.ts";

export const TASK_PAYLOAD_RETENTION_MS = 10 * 24 * 60 * 60 * 1000;
export const TASK_TOMBSTONE_RETENTION_MS = 10 * 24 * 60 * 60 * 1000;

const INTERRUPTED_INITIAL_DISPATCH = {
  SUMMARY: "initial task dispatch was interrupted before receiver receipt",
  ERROR_CODE: "INITIAL_DISPATCH_INTERRUPTED",
  ERROR_MESSAGE: "sender restarted before initial dispatch completed",
} as const;

export interface TaskLifecycleOptions {
  readonly now?: () => Date;
  readonly generateId?: () => string;
}

export interface TaskLifecycleStartupResult {
  readonly timedOutEvents: readonly CanonicalTaskEvent[];
  readonly interruptedDispatchEvents: readonly CanonicalTaskEvent[];
}

function isTerminal(state: TaskStateSnapshot): boolean {
  return state.status === TASK_STATUS.COMPLETED
    || state.status === TASK_STATUS.FAILED
    || state.status === TASK_STATUS.CANCELLED
    || state.status === TASK_STATUS.TIMED_OUT;
}

function timestampMs(timestamp: string): number {
  const milliseconds = Date.parse(timestamp);
  if (Number.isNaN(milliseconds)) throw new TypeError("task lifecycle requires ISO-8601 timestamps");
  return milliseconds;
}

/** Policy-only lifecycle coordinator; TaskStore retains authoritative filesystem ownership. */
export class TaskLifecycle {
  readonly #store: TaskStore;
  readonly #now: () => Date;
  readonly #generateId: () => string;
  #startupReconciled = false;

  constructor(store: TaskStore, options: TaskLifecycleOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#generateId = options.generateId ?? (() => generateUuidV7(this.#now().getTime()));
  }

  async initialize(): Promise<TaskLifecycleStartupResult> {
    await this.#store.initialize();
    const timedOutEvents = await this.#expireOverdue();
    const interruptedDispatchEvents = this.#startupReconciled ? [] : await this.#recoverInterruptedInitialDispatches();
    this.#startupReconciled = true;
    await this.#cleanRetainedPayloads();
    return { timedOutEvents, interruptedDispatchEvents };
  }

  /** Explicit access sweep for future request paths; no scheduler is installed here. */
  async sweep(): Promise<readonly CanonicalTaskEvent[]> {
    await this.#store.initialize();
    const timedOutEvents = await this.#expireOverdue();
    await this.#cleanRetainedPayloads();
    return timedOutEvents;
  }

  async #expireOverdue(): Promise<readonly CanonicalTaskEvent[]> {
    const now = this.#now();
    const nowMs = now.getTime();
    const committed: CanonicalTaskEvent[] = [];
    for (const ledger of await this.#store.ledgers()) {
      if (ledger.key.role !== TASK_LEDGER_ROLE.SENDER || isTerminal(ledger.state)
        || nowMs < timestampMs(ledger.header.assignment.expiresAt)) continue;
      const input = {
        id: this.#generateId(),
        taskId: ledger.key.taskId,
        type: TASK_EVENT_TYPE.TIMED_OUT,
        actor: "sender",
        occurredAt: now.toISOString(),
        message: undefined,
        replyToMessageId: undefined,
        payload: { kind: "none" },
        completion: undefined,
      } as const satisfies TaskEventInput;
      const accepted = await this.#store.acceptCanonicalEvent(ledger.key, input, {
        actor: "sender",
        address: ledger.header.participants.sender,
      });
      if (accepted.kind === "accepted") committed.push(accepted.event);
    }
    return committed;
  }

  async #recoverInterruptedInitialDispatches(): Promise<readonly CanonicalTaskEvent[]> {
    const committed: CanonicalTaskEvent[] = [];
    for (const ledger of await this.#store.ledgers()) {
      if (ledger.key.role !== TASK_LEDGER_ROLE.SENDER || ledger.state.status !== TASK_STATUS.PENDING_DELIVERY
        || !ledger.state.events.some((event) => event.type === TASK_EVENT_TYPE.CREATED)
        || !await this.#store.wasRebuiltOnStartup(ledger)) continue;
      const input = {
        id: this.#generateId(),
        taskId: ledger.key.taskId,
        type: TASK_EVENT_TYPE.FAILED,
        actor: "sender",
        occurredAt: this.#now().toISOString(),
        message: undefined,
        replyToMessageId: undefined,
        payload: { kind: "none" },
        completion: {
          summary: INTERRUPTED_INITIAL_DISPATCH.SUMMARY,
          result: undefined,
          error: {
            code: INTERRUPTED_INITIAL_DISPATCH.ERROR_CODE,
            message: INTERRUPTED_INITIAL_DISPATCH.ERROR_MESSAGE,
            retryable: false,
          },
          artifacts: undefined,
        },
      } as const satisfies TaskEventInput;
      const projection: TaskCompletionProjection = {
        artifacts: undefined,
        warnings: [{ code: INTERRUPTED_INITIAL_DISPATCH.ERROR_CODE, message: INTERRUPTED_INITIAL_DISPATCH.ERROR_MESSAGE }],
      };
      const accepted = await this.#store.acceptCanonicalEvent(ledger.key, input, {
        actor: "sender",
        address: ledger.header.participants.sender,
      }, projection);
      if (accepted.kind === "accepted") committed.push(accepted.event);
    }
    return committed;
  }

  async #cleanRetainedPayloads(): Promise<void> {
    const nowMs = this.#now().getTime();
    for (const ledger of await this.#store.ledgers()) {
      const provisionalReceipt = ledger.key.role === TASK_LEDGER_ROLE.RECEIVER
        && ledger.state.events.length === 0
        && ledger.records.some((record) => record.kind === "peer.receipt");
      const provisionalExpiresAt = Math.min(
        timestampMs(ledger.header.assignment.expiresAt),
        timestampMs(ledger.header.assignment.createdAt) + 10 * 60 * 1000,
      );
      const eligibleAt = provisionalReceipt ? provisionalExpiresAt : this.#payloadEligibleAt(ledger);
      if (eligibleAt === undefined || nowMs < (provisionalReceipt ? eligibleAt : eligibleAt + TASK_PAYLOAD_RETENTION_MS)) continue;
      await this.#store.writeTombstone(ledger, new Date(nowMs).toISOString());
      await this.#store.removeLedgerPayload(ledger);
    }
    for (const tombstone of await this.#store.tombstones()) {
      if (nowMs < timestampMs(tombstone.writtenAt) + TASK_TOMBSTONE_RETENTION_MS) continue;
      const ledger = await this.#store.getLedger(tombstone.key);
      if (ledger) await this.#store.removeLedgerPayload(ledger);
      if (!await this.#store.getLedger(tombstone.key)) await this.#store.removeTombstone(tombstone);
    }
  }

  #payloadEligibleAt(ledger: TaskLedger): number | undefined {
    if (!isTerminal(ledger.state)) return undefined;
    if (ledger.key.role === TASK_LEDGER_ROLE.SENDER) {
      const acknowledgement = ledger.state.parentAcknowledgedEventId === undefined
        ? undefined
        : ledger.state.events.find((event) => event.id === ledger.state.parentAcknowledgedEventId
          && event.type === TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED);
      return acknowledgement === undefined ? undefined : timestampMs(acknowledgement.occurredAt);
    }
    const cleanup = ledger.records.find((record) => record.kind === "cleanup.eligible");
    return cleanup === undefined ? undefined : timestampMs(cleanup.occurredAt);
  }
}
