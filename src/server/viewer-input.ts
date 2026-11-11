/**
 * When a viewer last typed into each session (milliseconds since epoch, by
 * wolfpack session id). Only interactive terminal input records here; agent
 * sends and server-typed notes do not. Memory-only: a restart forgets it.
 */
const lastInput = new Map<string, number>();

export function noteViewerInput(sessionId: string, at = Date.now()): void {
  lastInput.set(sessionId, at);
}

export function lastViewerInputAt(sessionId: string): number | undefined {
  return lastInput.get(sessionId);
}

export function __resetViewerInputForTests(): void {
  lastInput.clear();
}
