/**
 * Child events: the server tells a parent session what its children did,
 * without any child action. Events are derived from the existing session
 * observation (runtime state) and lineage (`identity.parentSession`), from
 * session exits, and from `notify-parent` messages. Same machine only.
 *
 * Each event is appended to the parent inbox (structured `childEvent`) and
 * published as a `child_event` SSE kind. Listeners (delivery) see every event.
 *
 * Coalescing is state based: a child produces at most one event per entry into
 * an event state. Repeated reports in the same state (another blocked request,
 * a broker blip that re-reports `done`) do not produce another event. A child
 * created by this process starts from `unknown`, so its first event state is
 * reported. A child first seen through restart recovery uses its first sight
 * as a baseline, never an event, so a server restart does not flood parents.
 */
import {
  AGENT_STATUS_AUTHORITY,
  AGENT_STATUS_STATE,
  type AgentStatusAuthority,
  type AgentStatusState,
} from "../agent-status-contract.ts";
import {
  boundedChildEventText,
  CHILD_EVENT,
  CHILD_EVENT_LIMITS,
  CHILD_EVENT_PAYLOAD_KIND,
  childEventSummary,
  type ChildEventName,
  type ChildEventPayload,
} from "../child-event-contract.ts";
import { WOLFPACK_EVENT_KIND, type SessionExitReason, type WolfpackEventBody } from "../events-contract.ts";
import type { ProgramStatusKind } from "../program-status-contract.ts";
import type { AgentRuntimeState } from "./agent-status.ts";
import { appendParentNotification, PARENT_INBOX_BOOT_ID } from "./parent-inbox.ts";
import type { ParentSessionIdentity } from "./session-identity.ts";

type PublishEvent = (body: WolfpackEventBody) => void;

/** Authorities whose state is the program's own claim, not a screen heuristic. */
const SEMANTIC_AUTHORITIES: ReadonlySet<AgentStatusAuthority> = new Set([
  AGENT_STATUS_AUTHORITY.PROGRAM,
  AGENT_STATUS_AUTHORITY.MANIFEST,
]);

/** States in which a child runs a delivered task. */
const BUSY_STATES: ReadonlySet<AgentStatusState> = new Set([
  AGENT_STATUS_STATE.WORKING,
  AGENT_STATUS_STATE.RUNNING,
  AGENT_STATUS_STATE.OUTPUT,
]);

interface ChildRecord {
  /** Tracking order (`childTrackingMark`): a table read only judges older records. */
  readonly trackedSeq: number;
  name: string;
  parentSessionId: string;
  parentName: string;
  /** Last live, fresh state seen in this process; undefined until the baseline. */
  state?: AgentStatusState;
  authority?: AgentStatusAuthority;
  /** A verified `session send` reached the child; its next busy → idle is `done`. */
  armed: boolean;
  lastLines?: readonly string[];
}

export interface ChildSessionObservation {
  readonly sessionId: string;
  readonly name: string;
  readonly parentSession?: ParentSessionIdentity;
  readonly alive: boolean;
  readonly runtimeState: AgentRuntimeState;
  /** The current rendered screen, when the pass has one. */
  readonly rendered?: string;
}

export interface ChildEventDelivery {
  readonly parentSessionName: string;
  readonly childEvent: ChildEventPayload;
}

type ChildEventListener = (delivery: ChildEventDelivery) => void;

/** How many exited child session IDs are remembered (review A3-1). */
export const CHILD_EXIT_MEMORY = 1024;

const children = new Map<string, ChildRecord>();
/**
 * Child session IDs that exited, oldest first. A session ID names one
 * incarnation and never comes back, so an observation, send or create that
 * started before the exit must not track it again (review A3-1).
 */
const exitedChildren = new Set<string>();
const listeners = new Set<ChildEventListener>();
let trackingSeq = 0;

function rememberExit(sessionId: string): void {
  exitedChildren.add(sessionId);
  if (exitedChildren.size <= CHILD_EXIT_MEMORY) return;
  const oldest = exitedChildren.values().next().value;
  if (oldest !== undefined) exitedChildren.delete(oldest);
}

function track(sessionId: string, record: Omit<ChildRecord, "trackedSeq">): ChildRecord {
  const child = { ...record, trackedSeq: ++trackingSeq };
  children.set(sessionId, child);
  return child;
}

function lastScreenLines(rendered: string): readonly string[] {
  const lines = rendered.split(/\r?\n/)
    .map(line => boundedChildEventText(line, CHILD_EVENT_LIMITS.LAST_LINE_CODE_POINTS))
    .filter(line => line.length > 0);
  return Object.freeze(lines.slice(-CHILD_EVENT_LIMITS.LAST_LINES));
}

interface DerivedEvent {
  readonly event: ChildEventName;
  readonly state: AgentStatusState;
  readonly authority?: AgentStatusAuthority;
  readonly inputKind?: ProgramStatusKind;
  readonly message?: string;
  readonly lastLines?: readonly string[];
  readonly reason?: SessionExitReason;
  readonly exitCode?: number;
  readonly signal?: number;
}

function emit(childSessionId: string, child: ChildRecord, derived: DerivedEvent, publish: PublishEvent): ChildEventPayload {
  const message = derived.message === undefined
    ? undefined
    : boundedChildEventText(derived.message, CHILD_EVENT_LIMITS.MESSAGE_CODE_POINTS);
  const fields = { ...derived, ...(message ? { message } : { message: undefined }) };
  const { childEvent } = appendParentNotification(
    child.parentSessionId,
    { message: childEventSummary(fields), from: boundedChildEventText(child.name, 100) },
    (seq, at) => Object.freeze({
      kind: CHILD_EVENT_PAYLOAD_KIND,
      eventId: `${childSessionId}:${PARENT_INBOX_BOOT_ID}:${seq}`,
      bootId: PARENT_INBOX_BOOT_ID,
      seq,
      childSessionId,
      childName: child.name,
      parentSessionId: child.parentSessionId,
      event: derived.event,
      state: derived.state,
      ...(derived.inputKind && { inputKind: derived.inputKind }),
      ...(message && { message }),
      ...(derived.lastLines && derived.lastLines.length > 0 && { lastLines: derived.lastLines }),
      observedAt: at,
      ...(derived.authority && { authority: derived.authority }),
      ...(derived.reason && { reason: derived.reason }),
      ...(derived.exitCode !== undefined && { exitCode: derived.exitCode }),
      ...(derived.signal !== undefined && { signal: derived.signal }),
    }),
  );
  // The describe callback always runs, so the entry carries the event.
  const payload = childEvent!;
  publish({
    kind: WOLFPACK_EVENT_KIND.CHILD_EVENT,
    session: child.parentName,
    sessionId: child.parentSessionId,
    childEvent: payload,
  });
  for (const listener of Array.from(listeners)) listener({ parentSessionName: child.parentName, childEvent: payload });
  return payload;
}

function deriveStateEvent(previous: AgentStatusState, child: ChildRecord, runtimeState: AgentRuntimeState): DerivedEvent | undefined {
  const { state, authority } = runtimeState;
  if (state === previous) return undefined;
  const semantic = SEMANTIC_AUTHORITIES.has(authority);
  // Only a program's own report carries text meant for the reader.
  const programText = authority === AGENT_STATUS_AUTHORITY.PROGRAM && runtimeState.message
    ? { message: runtimeState.message }
    : {};
  if (state === AGENT_STATUS_STATE.NEEDS_INPUT && semantic) {
    return { event: CHILD_EVENT.BLOCKED, state, authority, ...(runtimeState.inputKind && { inputKind: runtimeState.inputKind }), ...programText };
  }
  if (state === AGENT_STATUS_STATE.FAILED && semantic) return { event: CHILD_EVENT.ERROR, state, authority, ...programText };
  if (state === AGENT_STATUS_STATE.DONE && authority === AGENT_STATUS_AUTHORITY.PROGRAM) {
    return { event: CHILD_EVENT.DONE, state, authority, ...programText };
  }
  if (state === AGENT_STATUS_STATE.IDLE && child.armed && BUSY_STATES.has(previous)) {
    return { event: CHILD_EVENT.DONE, state, authority };
  }
  return undefined;
}

/**
 * Feed one observed session. Sessions without a parent are ignored. Returns
 * the event this observation produced, if any.
 */
export function observeChildSession(observation: ChildSessionObservation, publish: PublishEvent): ChildEventPayload | undefined {
  const parent = observation.parentSession;
  if (!parent || exitedChildren.has(observation.sessionId)) return undefined;
  let child = children.get(observation.sessionId);
  // A dead first sight is not tracked: there is no live child to report on,
  // and a record would make a later table read report a stale exit.
  if (!child && !observation.alive) return undefined;
  child ??= track(observation.sessionId, {
    name: observation.name, parentSessionId: parent.wolfpackSessionId, parentName: parent.wolfpackSessionName, armed: false,
  });
  child.name = observation.name;
  child.parentSessionId = parent.wolfpackSessionId;
  child.parentName = parent.wolfpackSessionName;
  if (observation.rendered !== undefined) child.lastLines = lastScreenLines(observation.rendered);
  // Exits come from the session lifecycle and the session table
  // (`reconcileChildEvents`). A dead or stale observation is not a fresh
  // claim about the child's state, and leaves the baseline unchanged.
  const { runtimeState } = observation;
  if (!observation.alive || runtimeState.stale) return undefined;
  const previous = child.state;
  child.state = runtimeState.state;
  child.authority = runtimeState.authority;
  if (previous === undefined) return undefined;
  const derived = deriveStateEvent(previous, child, runtimeState);
  if (!derived) return undefined;
  if (derived.event === CHILD_EVENT.DONE || derived.event === CHILD_EVENT.ERROR) child.armed = false;
  return emit(observation.sessionId, child, derived, publish);
}

/**
 * The backend created this child in this process. Call it before the session
 * can be observed: the first observed event state (blocked, error, done) is
 * then compared with `unknown` and reported, not taken as a baseline.
 */
export function noteChildCreated(sessionId: string, name: string, parent: ParentSessionIdentity): void {
  if (children.has(sessionId) || exitedChildren.has(sessionId)) return;
  track(sessionId, {
    name,
    parentSessionId: parent.wolfpackSessionId,
    parentName: parent.wolfpackSessionName,
    state: AGENT_STATUS_STATE.UNKNOWN,
    armed: false,
  });
}

/**
 * A `session send` wrote a task with Enter to this session: arm its
 * `busy → idle` done event. Called at the write, so a child that finishes
 * while the send is still observed is not missed. A child not yet observed is
 * tracked from here; its first observation is still a baseline.
 */
export function noteChildInputDelivered(sessionId: string, name: string, parent: ParentSessionIdentity | undefined): void {
  if (!parent || exitedChildren.has(sessionId)) return;
  const child = children.get(sessionId);
  if (child) {
    child.armed = true;
    return;
  }
  track(sessionId, {
    name,
    parentSessionId: parent.wolfpackSessionId,
    parentName: parent.wolfpackSessionName,
    armed: true,
  });
}

/** The session lifecycle reported an exit. Emits once, then forgets the child and remembers its exit. */
export function childSessionExited(
  sessionId: string,
  exit: { readonly reason: SessionExitReason; readonly exitCode?: number; readonly signal?: number },
  publish: PublishEvent,
): ChildEventPayload | undefined {
  const child = children.get(sessionId);
  if (!child) return undefined;
  children.delete(sessionId);
  rememberExit(sessionId);
  return emit(sessionId, child, {
    event: CHILD_EVENT.EXITED,
    state: child.state ?? AGENT_STATUS_STATE.UNKNOWN,
    ...(child.authority && { authority: child.authority }),
    ...(child.lastLines && { lastLines: child.lastLines }),
    reason: exit.reason,
    ...(exit.exitCode !== undefined && { exitCode: exit.exitCode }),
    ...(exit.signal !== undefined && { signal: exit.signal }),
  }, publish);
}

/**
 * Record a `notify-parent` message as a `message` event when the unverified
 * sender name matches a known child of this parent. Returns undefined when it
 * does not; the caller keeps the plain notification.
 */
export function childMessageEvent(
  parentSessionId: string,
  from: string | undefined,
  message: string,
  publish: PublishEvent,
): ChildEventPayload | undefined {
  if (from === undefined || boundedChildEventText(message, CHILD_EVENT_LIMITS.MESSAGE_CODE_POINTS) === "") return undefined;
  for (const [childSessionId, child] of children) {
    if (child.parentSessionId !== parentSessionId || child.name !== from) continue;
    return emit(childSessionId, child, {
      event: CHILD_EVENT.MESSAGE,
      state: child.state ?? AGENT_STATUS_STATE.UNKNOWN,
      ...(child.authority && { authority: child.authority }),
      message,
    }, publish);
  }
  return undefined;
}

/** Take this before a session table read starts; pass it as `trackedBefore`. */
export function childTrackingMark(): number {
  return trackingSeq;
}

export interface ChildTableReconcile {
  /** `childTrackingMark()` from before the read: newer records may be missing from it. */
  readonly trackedBefore: number;
  /** The exit reason, or undefined to wait (a kill reply is still outstanding). */
  readonly exitReason: (sessionId: string) => SessionExitReason | undefined;
  readonly publish: PublishEvent;
}

/**
 * A successful, authoritative session table: a known child that is listed dead
 * or no longer listed has exited, also when its exit frame was lost (for
 * example during a broker disconnect). Emits `exited` once, shared with
 * `childSessionExited`, so either arrival order reports one exit. An exit
 * found here carries no exit code. Unavailable facts must not reach here.
 */
export function reconcileChildEvents(liveSessionIds: ReadonlySet<string>, reconcile: ChildTableReconcile): void {
  for (const [id, child] of Array.from(children)) {
    if (liveSessionIds.has(id) || child.trackedSeq > reconcile.trackedBefore) continue;
    const reason = reconcile.exitReason(id);
    if (reason !== undefined) childSessionExited(id, { reason }, reconcile.publish);
  }
}

/** States in which a tracked child waits for its parent or has stopped (`agent wait --children all`). */
const SETTLED_STATES: ReadonlySet<AgentStatusState> = new Set([
  AGENT_STATUS_STATE.IDLE,
  AGENT_STATUS_STATE.NEEDS_INPUT,
  AGENT_STATUS_STATE.DONE,
  AGENT_STATUS_STATE.FAILED,
  AGENT_STATUS_STATE.STOPPED,
  AGENT_STATUS_STATE.OFF,
]);

/**
 * A live child is settled when its last fresh state is a settled state and no
 * delivered task is still pending (`armed`). An untracked child or one whose
 * state is not known yet is not settled.
 */
export function isChildSettled(sessionId: string): boolean {
  const child = children.get(sessionId);
  return child?.state !== undefined && SETTLED_STATES.has(child.state) && !child.armed;
}

/** Delivery hook: called synchronously for every event after the inbox append. */
export function onChildEvent(listener: ChildEventListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function __resetChildEventsForTests(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetChildEventsForTests is test-only");
  children.clear();
  exitedChildren.clear();
  listeners.clear();
  trackingSeq = 0;
}
