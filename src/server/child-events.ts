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
 * a broker blip that re-reports `done`) do not produce another event. The
 * first sight of a child in this process is a baseline, never an event, so a
 * server restart does not flood parents.
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

const children = new Map<string, ChildRecord>();
const listeners = new Set<ChildEventListener>();

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

/** Feed one observed session. Sessions without a parent are ignored. */
export function observeChildSession(observation: ChildSessionObservation, publish: PublishEvent): void {
  const parent = observation.parentSession;
  if (!parent) return;
  let child = children.get(observation.sessionId);
  if (!child) {
    child = { name: observation.name, parentSessionId: parent.wolfpackSessionId, parentName: parent.wolfpackSessionName, armed: false };
    children.set(observation.sessionId, child);
  }
  child.name = observation.name;
  child.parentSessionId = parent.wolfpackSessionId;
  child.parentName = parent.wolfpackSessionName;
  if (observation.rendered !== undefined) child.lastLines = lastScreenLines(observation.rendered);
  // Exits come from the session lifecycle. A dead or stale observation is not
  // a fresh claim about the child, and leaves the baseline unchanged.
  const { runtimeState } = observation;
  if (!observation.alive || runtimeState.stale) return;
  const previous = child.state;
  child.state = runtimeState.state;
  child.authority = runtimeState.authority;
  if (previous === undefined) return;
  const derived = deriveStateEvent(previous, child, runtimeState);
  if (!derived) return;
  if (derived.event === CHILD_EVENT.DONE || derived.event === CHILD_EVENT.ERROR) child.armed = false;
  emit(observation.sessionId, child, derived, publish);
}

/** A verified `session send` reached this session; arm its `busy → idle` done event. */
export function noteChildInputDelivered(sessionId: string): void {
  const child = children.get(sessionId);
  if (child) child.armed = true;
}

/** The session lifecycle reported an exit. Emits once, then forgets the child. */
export function childSessionExited(
  sessionId: string,
  exit: { readonly reason: SessionExitReason; readonly exitCode?: number; readonly signal?: number },
  publish: PublishEvent,
): ChildEventPayload | undefined {
  const child = children.get(sessionId);
  if (!child) return undefined;
  children.delete(sessionId);
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

/** Only a successful authoritative table can establish absent sessions. */
export function reconcileChildEvents(liveSessionIds: ReadonlySet<string>): void {
  for (const id of children.keys()) {
    if (!liveSessionIds.has(id)) children.delete(id);
  }
}

/** Delivery hook: called synchronously for every event after the inbox append. */
export function onChildEvent(listener: ChildEventListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function __resetChildEventsForTests(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetChildEventsForTests is test-only");
  children.clear();
  listeners.clear();
}
