/**
 * When a viewer last typed into each session (milliseconds since epoch, by
 * wolfpack session id). Only interactive terminal input records here; agent
 * sends and server-typed notes do not. Memory-only: a restart forgets it.
 */
export function createViewerInput() {
  const lastInput = new Map<string, number>();

  function noteViewerInput(sessionId: string, at = Date.now()): void {
    lastInput.set(sessionId, at);
  }

  function lastViewerInputAt(sessionId: string): number | undefined {
    return lastInput.get(sessionId);
  }

  return { noteViewerInput, lastViewerInputAt };
}
