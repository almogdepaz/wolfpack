import { AGENT_STATUS_STATE } from "./agent-status-contract.js";
import type { FocusDocument, FocusIntention } from "./focus-contract.js";
import type { ProgramStatusKind } from "./program-status-contract.js";
export interface FocusSession {
  id: string;
  name: string;
  state: string;
  inputKind?: ProgramStatusKind;
  changedAt?: string;
  unseen?: boolean;
  stoppedSequence?: number;
  acknowledgedSequence?: number;
  cwd?: string;
  machine?: string;
  machineUrl?: string;
  /** Shown in the card body only; ranking ignores it. */
  lastLine?: string;
}
/** An unreviewed work episode, not merely an unseen metadata transition. */
export function stoppedUnseen(session: { state: string; unseen?: boolean; stoppedSequence?: number; acknowledgedSequence?: number }): boolean {
  return session.unseen === true && (session.state === AGENT_STATUS_STATE.DONE || session.state === AGENT_STATUS_STATE.IDLE)
    && (session.stoppedSequence ?? 0) > (session.acknowledgedSequence ?? 0);
}
export interface FocusAction {
  kind: "open" | "start";
  intention?: FocusIntention;
  session?: FocusSession;
  reason: string;
}
/** Shared row vocabulary for the dashboard, assistant page, card and sidebar preview. */
export function focusSessionLabel(session: FocusSession): string {
  if (session.state === AGENT_STATUS_STATE.NEEDS_INPUT) return session.inputKind ?? "needs you";
  if (stoppedUnseen(session)) return "stopped";
  return session.state === AGENT_STATUS_STATE.DONE ? "finished" : session.state;
}
export function focusActionVerb(row: FocusAction): string {
  if (!row.session) return "start";
  switch (focusSessionLabel(row.session)) {
    case "permission": return "approve";
    case "question": return "answer";
    case "auth": return "log in";
    case "failed": return "retry";
    case "stopped": return "review";
    default: return "open";
  }
}
export function linkedFocusSessions(intention: FocusIntention, sessions: readonly FocusSession[]): FocusSession[] {
  return sessions.filter(s => intention.sessions !== undefined
    ? intention.sessions.includes(s.id)
    : !!intention.project && s.cwd === intention.project && (!intention.machine || s.machine === intention.machine));
}
const needsYou = (s: FocusSession) => s.state === AGENT_STATUS_STATE.NEEDS_INPUT || s.state === AGENT_STATUS_STATE.FAILED;
const at = (s: FocusSession) => Date.parse(s.changedAt ?? "") || 0;
const oldest = (a: FocusSession, b: FocusSession) => at(a) - at(b) || a.id.localeCompare(b.id) || (a.machine ?? "").localeCompare(b.machine ?? "");
/** A finished agent is worth a look for this long; after that it is a chip again. */
export const FINISHED_WINDOW_MS = 24 * 60 * 60_000;
/** Linked needs-you → linked stopped-unseen → starts → recent seen linked finishes → unlinked needs-you → unlinked stopped-unseen.
 * Intention order, then oldest stop first; unseen stops never expire. Working and fresh idle remain chips.
 */
export function rankFocus(doc: FocusDocument, sessions: readonly FocusSession[], cap = 5, now = Date.now()): FocusAction[] {
  const linked = new Set<FocusSession>();
  const attention: FocusAction[] = [];
  const stopped: FocusAction[] = [];
  const starts: FocusAction[] = [];
  const finished: FocusAction[] = [];
  for (const intention of doc.intentions) {
    const live = linkedFocusSessions(intention, sessions);
    live.forEach(s => linked.add(s));
    if (intention.done) continue;
    for (const session of live.filter(needsYou).sort(oldest)) {
      if (!attention.some(row => row.session === session)) attention.push({ kind: "open", intention, session, reason: "Needs you for this intention; intention order, then oldest first." });
    }
    for (const session of live.filter(stoppedUnseen).sort(oldest)) {
      if (!stopped.some(row => row.session === session)) stopped.push({ kind: "open", intention, session, reason: "Stopped work on this intention you have not seen; intention order, then oldest first." });
    }
    if (live.length === 0) starts.push({ kind: "start", intention, reason: "An unfinished intention with no live session, in your order." });
    for (const session of live.filter(s => s.state === AGENT_STATUS_STATE.DONE && !stoppedUnseen(s) && now - at(s) <= FINISHED_WINDOW_MS).sort(oldest).reverse()) {
      if (!finished.some(row => row.session === session)) finished.push({ kind: "open", intention, session, reason: "Finished work on this intention; look before it goes stale." });
    }
  }
  const unlinked = sessions.filter(s => !linked.has(s) && needsYou(s)).sort(oldest).map(session => ({ kind: "open" as const, session, reason: "Unlinked session needs you; oldest first." }));
  const unlinkedStopped = sessions.filter(s => !linked.has(s) && stoppedUnseen(s)).sort(oldest).map(session => ({ kind: "open" as const, session, reason: "Stopped unlinked work you have not seen; oldest first." }));
  return [...attention, ...stopped, ...starts, ...finished, ...unlinked, ...unlinkedStopped].slice(0, Math.max(0, cap));
}
export type FocusDoneItem = { at: string; kind: "intention"; intention: FocusIntention } | { at: string; kind: "session"; intention: FocusIntention; session: FocusSession };
/** Today's timeline, newest first: intentions ticked today and linked sessions that finished today. `day` maps a timestamp to its day label. */
export function doneToday(doc: FocusDocument, sessions: readonly FocusSession[], now: number, day: (at: string) => string): FocusDoneItem[] {
  const today = day(new Date(now).toISOString());
  const items: FocusDoneItem[] = [];
  for (const intention of doc.intentions) {
    if (intention.done && intention.doneAt && day(intention.doneAt) === today) items.push({ at: intention.doneAt, kind: "intention", intention });
    for (const session of linkedFocusSessions(intention, sessions)) {
      if (session.state === AGENT_STATUS_STATE.DONE && session.changedAt && day(session.changedAt) === today && !items.some(i => i.kind === "session" && i.session === session)) items.push({ at: session.changedAt, kind: "session", intention, session });
    }
  }
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
