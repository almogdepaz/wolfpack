/**
 * `wolfpack agent wait --children any|all`: wait for the current session's
 * children through the parent inbox and the child-event hook. Memory-only like
 * the inbox: a cursor is scoped to `PARENT_INBOX_BOOT_ID`.
 */
import {
  CHILD_WAIT_LIMITS,
  CHILD_WAIT_MODE,
  CHILD_WAIT_OUTCOME,
  type ChildEventPayload,
  type ChildWaitMode,
  type ChildWaitOutcome,
} from "../child-event-contract.ts";
import { onChildEvent } from "./child-events.ts";
import { listParentNotifications, PARENT_INBOX_BOOT_ID } from "./parent-inbox.ts";

/** One live child of the waiting parent, as the caller observes it now. */
export interface ChildWaitChild {
  readonly session: string;
  readonly sessionId: string;
  readonly settled: boolean;
}

export interface ChildEventsSince {
  readonly bootId: string;
  /** The cursor this read used: the request `since` for the current boot, otherwise 0. */
  readonly since: number;
  /** Pass this as the next `since` together with `bootId`. */
  readonly cursor: number;
  readonly events: readonly ChildEventPayload[];
  /** The inbox bound dropped entries after `since`; `events` misses some. */
  readonly truncated?: true;
}

export interface ChildWaitResult extends ChildEventsSince {
  readonly outcome: ChildWaitOutcome;
  /** `all` only: live children that are not settled yet. */
  readonly pending?: readonly { readonly session: string; readonly sessionId: string }[];
}

export interface ChildWaitRequest {
  readonly parentSessionId: string;
  readonly mode: ChildWaitMode;
  readonly since?: number;
  readonly bootId?: string;
  readonly timeoutMs: number;
  /** The parent's current live children; called again on each check. */
  readonly listChildren: () => Promise<readonly ChildWaitChild[]>;
  /** Abort when the client went away: the wait then resolves to undefined. */
  readonly signal?: AbortSignal;
  /** `all` re-check interval; tests shorten it. */
  readonly recheckMs?: number;
}

/** The server already holds the maximum number of concurrent child waits. */
export class ChildWaitBusyError extends Error {
  constructor() {
    super("too many concurrent child waits");
  }
}

let activeWaits = 0;

/**
 * Child events after `since`. A cursor from another boot, or no boot ID,
 * reads every event of the current boot, never an empty stale result.
 */
export function childEventsSince(parentSessionId: string, since?: number, bootId?: string): ChildEventsSince {
  const effective = bootId === PARENT_INBOX_BOOT_ID && since !== undefined ? since : 0;
  const entries = listParentNotifications(parentSessionId, effective);
  const events = entries.flatMap(entry => entry.childEvent ? [entry.childEvent] : []);
  const last = entries.at(-1);
  const truncated = entries.length > 0 && entries[0]!.seq > effective + 1;
  return {
    bootId: PARENT_INBOX_BOOT_ID,
    since: effective,
    cursor: last ? Math.max(effective, last.seq) : effective,
    events,
    ...(truncated && { truncated: true as const }),
  };
}

function decide(mode: ChildWaitMode, children: readonly ChildWaitChild[], hasEvents: boolean): ChildWaitOutcome | undefined {
  if (mode === CHILD_WAIT_MODE.ANY) {
    if (hasEvents) return CHILD_WAIT_OUTCOME.EVENTS;
    return children.length === 0 ? CHILD_WAIT_OUTCOME.NO_CHILDREN : undefined;
  }
  if (children.length === 0) return hasEvents ? CHILD_WAIT_OUTCOME.SETTLED : CHILD_WAIT_OUTCOME.NO_CHILDREN;
  return children.every(child => child.settled) ? CHILD_WAIT_OUTCOME.SETTLED : undefined;
}

function pendingChildren(children: readonly ChildWaitChild[]) {
  return children.filter(child => !child.settled).map(({ session, sessionId }) => ({ session, sessionId }));
}

/**
 * Resolve when the mode is satisfied or at the timeout (outcome `timeout`).
 * Resolves to undefined when the signal aborts. Throws `ChildWaitBusyError`
 * above `CHILD_WAIT_LIMITS.WAITERS`, and the `listChildren` error if it fails.
 */
export async function waitForChildren(request: ChildWaitRequest): Promise<ChildWaitResult | undefined> {
  if (activeWaits >= CHILD_WAIT_LIMITS.WAITERS) throw new ChildWaitBusyError();
  activeWaits += 1;
  try {
    return await new Promise<ChildWaitResult | undefined>((resolve, reject) => {
      let done = false;
      let checking = false;
      let again = false;
      // A child event arrived during the current children read.
      let invalidated = false;
      let lastChildren: readonly ChildWaitChild[] = [];
      const result = (outcome: ChildWaitOutcome): ChildWaitResult => {
        const pending = request.mode === CHILD_WAIT_MODE.ALL ? pendingChildren(lastChildren) : [];
        return {
          outcome,
          ...childEventsSince(request.parentSessionId, request.since, request.bootId),
          ...(pending.length > 0 && { pending }),
        };
      };
      const stop = () => {
        done = true;
        clearTimeout(timer);
        clearInterval(recheck);
        unsubscribe();
        request.signal?.removeEventListener("abort", onAbort);
      };
      const finish = (value: ChildWaitResult | undefined) => {
        if (done) return;
        stop();
        resolve(value);
      };
      const fail = (error: unknown) => {
        if (done) return;
        stop();
        reject(error);
      };
      const hasEvents = () => childEventsSince(request.parentSessionId, request.since, request.bootId).events.length > 0;
      // Checks run one at a time; a trigger during a check runs one more.
      const check = async (): Promise<void> => {
        if (done) return;
        // `any` completes from events alone; the children read only decides
        // `no_children`, so it never holds back a retained or new event.
        if (request.mode === CHILD_WAIT_MODE.ANY && hasEvents()) { finish(result(CHILD_WAIT_OUTCOME.EVENTS)); return; }
        if (checking) { again = true; return; }
        checking = true;
        try {
          do {
            again = false;
            invalidated = false;
            const children = await request.listChildren();
            if (done) return;
            lastChildren = children;
            // An event during the read can name a child the read missed: the
            // read is stale for every outcome, so read again before deciding.
            // A re-check tick is no such evidence and keeps the read.
            if (invalidated) { again = true; continue; }
            // Read the inbox after the await: an event during it is not lost.
            const read = childEventsSince(request.parentSessionId, request.since, request.bootId);
            const outcome = decide(request.mode, children, read.events.length > 0);
            if (outcome !== undefined) { finish(result(outcome)); return; }
          } while (again && !done);
        } catch (error) {
          fail(error);
        } finally {
          checking = false;
        }
      };
      const onAbort = () => finish(undefined);
      // Subscribe before the first check, so an event during it triggers another.
      const unsubscribe = onChildEvent(({ childEvent }) => {
        if (childEvent.parentSessionId !== request.parentSessionId) return;
        invalidated = true;
        void check();
      });
      const timer = setTimeout(() => finish(result(
        request.mode === CHILD_WAIT_MODE.ANY && hasEvents() ? CHILD_WAIT_OUTCOME.EVENTS : CHILD_WAIT_OUTCOME.TIMEOUT,
      )), request.timeoutMs);
      // A child can settle without an event (for example working → idle without a task).
      const recheck = request.mode === CHILD_WAIT_MODE.ALL
        ? setInterval(() => void check(), request.recheckMs ?? CHILD_WAIT_LIMITS.RECHECK_MS)
        : undefined;
      if (request.signal?.aborted) { finish(undefined); return; }
      request.signal?.addEventListener("abort", onAbort);
      void check();
    });
  } finally {
    activeWaits -= 1;
  }
}
