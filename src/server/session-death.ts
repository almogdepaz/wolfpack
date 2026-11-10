/**
 * Session death evidence for the child cleanup cascade. Death follows the
 * rules of the `exited` child event: a lifecycle exit, or a dead or gone entry
 * in a session table that was read successfully. An unavailable read is no
 * evidence. Only a session this process saw alive can die here, so the first
 * table after a server restart reports no deaths (no startup cascade).
 */

type SessionDeathListener = (sessionId: string) => void;

/** Session ID → the mark at which this process first saw it alive. */
const seenAlive = new Map<string, number>();
const listeners = new Set<SessionDeathListener>();
let seq = 0;

/** Take before a session table read; pass to `noteSessionTable`. */
export function sessionTableMark(): number {
  return seq;
}

/** A session this process created or listed alive. */
export function noteSessionAlive(sessionId: string): void {
  if (!seenAlive.has(sessionId)) seenAlive.set(sessionId, ++seq);
}

function died(sessionId: string): void {
  if (!seenAlive.delete(sessionId)) return;
  for (const listener of Array.from(listeners)) listener(sessionId);
}

/** A lifecycle exit frame. */
export function noteSessionExit(sessionId: string): void {
  died(sessionId);
}

/**
 * A successful table read that started at `readStartedAt`. A session first
 * seen alive after the read started can be missing from it without dying.
 */
export function noteSessionTable(liveSessionIds: ReadonlySet<string>, readStartedAt: number): void {
  for (const [id, firstSeen] of Array.from(seenAlive)) {
    if (!liveSessionIds.has(id) && firstSeen <= readStartedAt) died(id);
  }
  for (const id of liveSessionIds) noteSessionAlive(id);
}

export function onSessionDeath(listener: SessionDeathListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function __resetSessionDeathForTests(): void {
  seenAlive.clear();
  listeners.clear();
  seq = 0;
}
