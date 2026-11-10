/**
 * Delivers child events to the parent agent (plan phase 2). The first
 * available path wins:
 * 1. a relay envelope from the server source to a parent endpoint that
 *    advertises `CHILD_EVENT_RELAY_PROTOCOL`;
 * 2. a typed note: one short tagged line typed into the parent terminal, only
 *    while the parent's program status is `idle` or `done`, no viewer typed in
 *    the last 60 s, and the setting allows it;
 * 3. otherwise the parent inbox only (phase 1 already appended the event).
 *
 * The typed note carries only enumerated fields and sanitized names. It never
 * types child-controlled text (`message`, `lastLines`), because a child must
 * not write instructions into its parent's prompt.
 */
import { AGENT_STATUS_AUTHORITY, AGENT_STATUS_FRESHNESS, AGENT_STATUS_STATE } from "../agent-status-contract.js";
import type { AgentStatusAuthority, AgentStatusFreshness, AgentStatusState } from "../agent-status-contract.js";
import { CHILD_EVENT, CHILD_EVENT_RELAY_PROTOCOL, type ChildEventPayload } from "../child-event-contract.js";
import { PROGRAM_STATUS_KINDS, PROGRAM_STATUS_STATE, type ProgramStatusState } from "../program-status-contract.js";
import {
  SESSION_SEND_DELIVERY,
  SESSION_SEND_OUTCOME,
  type SessionSendObservationResult,
  type SessionSendWriteGuard,
} from "../session-send-contract.js";
import { createLogger, errMsg } from "../log.js";
import { HOST_ENVELOPE_ACCEPTANCE, type VolatileHostEnvelopeRequest, type VolatileHostEnvelopeResult } from "../task-relay/volatile-protocol.js";
import { onChildEvent, type ChildEventDelivery } from "./child-events.js";

const log = createLogger("session-observation");

export const CHILD_EVENT_NOTE_LIMITS = {
  /** No note while a viewer typed into the parent this recently. */
  VIEWER_QUIET_MS: 60_000,
  /** At most one note per parent in this interval; later events coalesce. */
  MIN_INTERVAL_MS: 15_000,
  /** Events listed in one note; the rest are counted as "+k more". */
  ITEMS: 8,
  /** Events held per parent; the oldest are dropped (and counted) beyond this. */
  PENDING: 50,
  /** Queued events older than this are dropped: the parent never became idle. */
  PENDING_TTL_MS: 30 * 60_000,
  /** Sends that wrote nothing before the queued events are dropped. */
  ATTEMPTS: 3,
  /** With ITEMS this bounds a note to ~600 characters. */
  NAME_CHARS: 40,
} as const;

/** The relay envelope id is derived from the stable event id, so a resend deduplicates. */
const ENVELOPE_ID_PREFIX = "wolfpack.child_event:";
const NOTE_PREFIX = "[wolfpack] child events:";
const NOTE_SUFFIX = "(details: wolfpack agent inbox --json)";
const NOTE_STATES: ReadonlySet<AgentStatusState> = new Set([AGENT_STATUS_STATE.IDLE, AGENT_STATUS_STATE.DONE]);
/** The same states, judged at each write from the root program status (never `blocked`). */
const NOTE_PROGRAM_STATES: ReadonlySet<ProgramStatusState> = new Set([PROGRAM_STATUS_STATE.IDLE, PROGRAM_STATUS_STATE.DONE]);

export interface ParentObservation {
  readonly sessionId: string;
  readonly name: string;
  readonly alive: boolean;
  readonly runtimeState: {
    readonly state: AgentStatusState;
    readonly authority: AgentStatusAuthority;
    readonly freshness: AgentStatusFreshness;
    readonly stale: boolean;
  };
}

export interface ChildEventDeliveryDeps {
  hostEnvelope(input: VolatileHostEnvelopeRequest): Promise<VolatileHostEnvelopeResult>;
  /**
   * Types `text` and Enter into the session through the observed, serialized
   * send path, checking `writeGuard` right before each write.
   */
  send(sessionId: string, sessionName: string, text: string, writeGuard: SessionSendWriteGuard): Promise<SessionSendObservationResult>;
  typedNotesEnabled(): boolean;
  lastViewerInputAt(sessionId: string): number | undefined;
  now(): number;
}

interface QueuedEvent {
  readonly payload: ChildEventPayload;
  readonly queuedAt: number;
}

interface PendingNotes {
  /** Events waiting for the next note; at most `PENDING`. */
  items: QueuedEvent[];
  /** Waiting events dropped by the `PENDING` bound, counted in the next note. */
  dropped: number;
  attempts: number;
  /** The note being sent. Its events are not in `items`, so new arrivals never displace them. */
  inFlight: boolean;
}

export interface ChildEventDeliveryService {
  /** Relay first; otherwise queue a typed note (when the setting allows it). */
  deliver(delivery: ChildEventDelivery): Promise<void>;
  /** Called for each observed session; flushes queued notes when every guard passes. */
  observeParent(parent: ParentObservation): void;
  /** True while some parent has queued notes; keeps the observer running. */
  hasPending(): boolean;
}

function sanitizedName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, CHILD_EVENT_NOTE_LIMITS.NAME_CHARS);
  return cleaned || "child";
}

/** Enumerated fields only: the event, the input kind and exit details. */
function noteItem(payload: ChildEventPayload): string {
  const name = sanitizedName(payload.childName);
  switch (payload.event) {
    case CHILD_EVENT.BLOCKED: {
      const kind = payload.inputKind && PROGRAM_STATUS_KINDS.includes(payload.inputKind) ? ` (${payload.inputKind})` : "";
      return `${name} blocked${kind}`;
    }
    case CHILD_EVENT.EXITED: {
      const verb = payload.reason === "killed" ? "killed" : "exited";
      const detail = Number.isInteger(payload.exitCode) ? ` (exit code ${payload.exitCode})`
        : Number.isInteger(payload.signal) ? ` (signal ${payload.signal})` : "";
      return `${name} ${verb}${detail}`;
    }
    case CHILD_EVENT.ERROR:
      return `${name} error`;
    case CHILD_EVENT.DONE:
      return `${name} done`;
    case CHILD_EVENT.MESSAGE:
      return `${name} message`;
  }
}

export function childEventNoteText(payloads: readonly ChildEventPayload[], dropped = 0): string {
  const listed = payloads.slice(0, CHILD_EVENT_NOTE_LIMITS.ITEMS).map(noteItem);
  const more = payloads.length - listed.length + dropped;
  return `${NOTE_PREFIX} ${listed.join("; ")}${more > 0 ? `; +${more} more` : ""} ${NOTE_SUFFIX}`;
}

export function createChildEventDelivery(deps: ChildEventDeliveryDeps): ChildEventDeliveryService {
  const pending = new Map<string, PendingNotes>();
  /** Kept apart from the queue: an emptied queue must not reset the rate limit. */
  const lastNoteAt = new Map<string, number>();

  const prune = (now: number) => {
    for (const [sessionId, at] of lastNoteAt) {
      if (now - at >= CHILD_EVENT_NOTE_LIMITS.MIN_INTERVAL_MS) lastNoteAt.delete(sessionId);
    }
    for (const [sessionId, entry] of pending) {
      if (entry.inFlight) continue;
      entry.items = entry.items.filter(item => now - item.queuedAt <= CHILD_EVENT_NOTE_LIMITS.PENDING_TTL_MS);
      if (entry.items.length === 0) pending.delete(sessionId);
    }
  };

  /** Drops the oldest waiting events beyond the bound and counts them. */
  const bound = (entry: PendingNotes) => {
    const excess = entry.items.length - CHILD_EVENT_NOTE_LIMITS.PENDING;
    if (excess <= 0) return;
    entry.items.splice(0, excess);
    entry.dropped += excess;
  };

  const enqueue = (payload: ChildEventPayload) => {
    const sessionId = payload.parentSessionId;
    const entry = pending.get(sessionId) ?? { items: [], dropped: 0, attempts: 0, inFlight: false };
    entry.items.push({ payload, queuedAt: deps.now() });
    bound(entry);
    pending.set(sessionId, entry);
  };

  const viewerQuiet = (sessionId: string, now: number): boolean => {
    const viewerInputAt = deps.lastViewerInputAt(sessionId);
    return viewerInputAt === undefined || now - viewerInputAt >= CHILD_EVENT_NOTE_LIMITS.VIEWER_QUIET_MS;
  };

  /**
   * The observation guards, checked again at each write (review A2-1): the
   * parent can start working, block or get viewer input after it was observed.
   * The backend refuses a dead parent itself.
   */
  const writeGuard = (sessionId: string): SessionSendWriteGuard => rootStatus =>
    rootStatus !== undefined && NOTE_PROGRAM_STATES.has(rootStatus.state)
    && deps.typedNotesEnabled() && viewerQuiet(sessionId, deps.now());

  const flush = async (parent: ParentObservation, entry: PendingNotes) => {
    // Take the batch out of the queue: events that arrive during the send wait
    // for the next note, and the bound applies only to them.
    const batch = entry.items;
    const batchDropped = entry.dropped;
    entry.items = [];
    entry.dropped = 0;
    const keepBatch = () => {
      entry.items = [...batch, ...entry.items];
      entry.dropped += batchDropped;
      bound(entry);
    };
    const text = childEventNoteText(batch.map(item => item.payload), batchDropped);
    entry.inFlight = true;
    lastNoteAt.set(parent.sessionId, deps.now());
    let result: SessionSendObservationResult | undefined;
    try {
      result = await deps.send(parent.sessionId, parent.name, text, writeGuard(parent.sessionId));
    } catch (error) {
      log.warn("typed child-event note failed; not retyped", { parent: parent.name, error: errMsg(error) });
    } finally {
      entry.inFlight = false;
    }
    if (result?.writeRefused && result.delivery === SESSION_SEND_DELIVERY.NOT_DELIVERED) {
      // The parent stopped waiting before anything was written: keep the note
      // for a later observation without using an attempt.
      keepBatch();
      return;
    }
    if (result?.reason !== undefined) {
      // Nothing was written: keep the events for a bounded number of attempts.
      entry.attempts += 1;
      if (entry.attempts < CHILD_EVENT_NOTE_LIMITS.ATTEMPTS) {
        keepBatch();
        return;
      }
      log.warn("typed child-event note dropped after repeated failures", { parent: parent.name, reason: result.reason, events: batch.length });
    } else if (result && result.outcome !== SESSION_SEND_OUTCOME.SUBMITTED) {
      // Something may sit in the parent input: never type the same events again.
      log.warn("typed child-event note not verified as submitted; not retyped", { parent: parent.name, outcome: result.outcome });
    }
    entry.attempts = 0;
    if (entry.items.length === 0 && pending.get(parent.sessionId) === entry) pending.delete(parent.sessionId);
  };

  return {
    async deliver({ childEvent }) {
      const relayed = await deps.hostEnvelope({
        targetSession: childEvent.parentSessionId,
        requiredProtocol: CHILD_EVENT_RELAY_PROTOCOL,
        envelopeId: `${ENVELOPE_ID_PREFIX}${childEvent.eventId}`,
        payload: childEvent,
        // A pure function of the event: a resend of the same event deduplicates
        // instead of conflicting. A late send expires and falls back to a note.
        createdAt: childEvent.observedAt,
      }).catch((error: unknown): VolatileHostEnvelopeResult => {
        // Unknown how far the call got, so the envelope may have been accepted.
        log.warn("child-event relay send failed", { error: errMsg(error) });
        return { kind: "failed", code: "RELAY_UNAVAILABLE", acceptance: HOST_ENVELOPE_ACCEPTANCE.UNCERTAIN };
      });
      if (relayed.kind === "accepted") return;
      if (relayed.kind === "failed") {
        // A typed note is a fallback only for an envelope that is definitely not
        // in the parent inbox; otherwise the parent could get the event twice.
        if (relayed.acceptance === HOST_ENVELOPE_ACCEPTANCE.UNCERTAIN) {
          log.warn("child-event relay acceptance uncertain; no typed note", { code: relayed.code });
          return;
        }
        log.warn("child-event relay send failed; using typed note", { code: relayed.code });
      }
      if (deps.typedNotesEnabled()) enqueue(childEvent);
    },

    observeParent(parent) {
      const entry = pending.get(parent.sessionId);
      if (!entry || entry.inFlight) return;
      const now = deps.now();
      if (!parent.alive || !deps.typedNotesEnabled()) {
        pending.delete(parent.sessionId);
        return;
      }
      prune(now);
      if (!pending.has(parent.sessionId)) return;
      const { runtimeState } = parent;
      if (runtimeState.authority !== AGENT_STATUS_AUTHORITY.PROGRAM || !NOTE_STATES.has(runtimeState.state)
        || runtimeState.stale || runtimeState.freshness !== AGENT_STATUS_FRESHNESS.FRESH) return;
      if (!viewerQuiet(parent.sessionId, now)) return;
      if (lastNoteAt.has(parent.sessionId)) return;
      void flush(parent, entry);
    },

    hasPending() {
      prune(deps.now());
      return pending.size > 0;
    },
  };
}

let installed: ChildEventDeliveryService | undefined;

/** The server starts one service; the observer consults it. Returns the stop function. */
export function startChildEventDelivery(deps: ChildEventDeliveryDeps): () => void {
  const service = createChildEventDelivery(deps);
  installed = service;
  const unsubscribe = onChildEvent(delivery => {
    void service.deliver(delivery).catch((error: unknown) => {
      log.warn("child-event delivery failed", { error: errMsg(error) });
    });
  });
  return () => {
    unsubscribe();
    if (installed === service) installed = undefined;
  };
}

export function observeChildEventParent(parent: ParentObservation): void {
  installed?.observeParent(parent);
}

export function hasPendingChildEventNotes(): boolean {
  return installed?.hasPending() ?? false;
}
