/**
 * Server-internal signal: the broker reported that a session's OSC 7501
 * program status records changed. The broker backend raises it; the session
 * observer listens and refreshes runtime state early instead of waiting for
 * its poll. A separate module keeps the backend from importing the observer
 * (which already imports the backend).
 */
type ProgramStatusChangedListener = (brokerSessionId: string) => void;

const listeners = new Set<ProgramStatusChangedListener>();

export function notifyProgramStatusChanged(brokerSessionId: string): void {
  for (const listener of listeners) listener(brokerSessionId);
}

/** Returns an unsubscribe function. */
export function onProgramStatusChanged(listener: ProgramStatusChangedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
