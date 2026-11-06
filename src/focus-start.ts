import type { FocusDocument, FocusOp } from "./focus-contract.js";

export interface FocusSessionStart { intentionId: string; home: string }
export interface StartedFocusSession { sessionId?: string; projectDir?: string; machine: string }

/** Recompute against the latest CAS document so concurrent links are never overwritten. */
export function linkStartedFocusSession(doc: FocusDocument, intentionId: string, session: StartedFocusSession): FocusOp {
  const intention = doc.intentions.find(i => i.id === intentionId);
  if (!intention) throw new Error("the originating intention no longer exists");
  if (!session.sessionId || !session.projectDir) throw new Error("server returned no exact session identity or canonical project directory");
  return { type: "edit", id: intentionId, patch: {
    sessions: [...new Set([...(intention.sessions ?? []), session.sessionId])],
    project: session.projectDir,
    machine: session.machine,
  } };
}
