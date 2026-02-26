// Session timeline — in-memory event tracking per session (UX-13)

export type TimelineEventType =
  | "opened"
  | "prompt"
  | "error"
  | "command"
  | "idle"
  | "running";

export interface TimelineEvent {
  ts: number; // Date.now()
  type: TimelineEventType;
  text?: string; // optional context (e.g. command text, error snippet)
}

const MAX_EVENTS_PER_SESSION = 100;
const timelines = new Map<string, TimelineEvent[]>();

/** Record a timeline event for a session. Deduplicates consecutive same-type events within 2s. */
export function recordEvent(session: string, type: TimelineEventType, text?: string): void {
  let events = timelines.get(session);
  if (!events) {
    events = [];
    timelines.set(session, events);
  }
  const now = Date.now();
  // Deduplicate: skip if last event is same type within 2s
  const last = events[events.length - 1];
  if (last && last.type === type && now - last.ts < 2000) return;

  events.push({ ts: now, type, text });
  // Evict oldest when over limit
  if (events.length > MAX_EVENTS_PER_SESSION) {
    events.splice(0, events.length - MAX_EVENTS_PER_SESSION);
  }
}

/** Get timeline events for a session, optionally limited to last N. */
export function getTimeline(session: string, limit?: number): TimelineEvent[] {
  const events = timelines.get(session);
  if (!events) return [];
  if (limit && limit < events.length) return events.slice(-limit);
  return [...events];
}

/** Get recent events for all sessions (for /api/sessions enrichment). Returns last N per session. */
export function getRecentEvents(limit: number = 5): Map<string, TimelineEvent[]> {
  const result = new Map<string, TimelineEvent[]>();
  for (const [session, events] of timelines) {
    result.set(session, events.slice(-limit));
  }
  return result;
}

/** Clear timeline for a session (e.g. when killed). */
export function clearTimeline(session: string): void {
  timelines.delete(session);
}

/** Track previous triage state per session for transition detection. */
const prevTriage = new Map<string, string>();

/** Detect triage state transitions and record appropriate events. */
export function detectTriageTransition(session: string, triage: string): void {
  const prev = prevTriage.get(session);
  prevTriage.set(session, triage);
  if (prev === triage) return; // no change
  if (triage === "needs-input") recordEvent(session, "prompt");
  if (triage === "error") recordEvent(session, "error");
  if (triage === "idle" && prev) recordEvent(session, "idle");
  if (triage === "running" && prev === "idle") recordEvent(session, "running");
}

/** Prune timelines for sessions that no longer exist. */
export function pruneTimelines(activeSessions: Set<string>): void {
  for (const session of timelines.keys()) {
    if (!activeSessions.has(session)) {
      timelines.delete(session);
      prevTriage.delete(session);
    }
  }
}
