import { AGENT_STATUS_STATE } from "./agent-status-contract.js";
import type { FocusDocument, FocusIntention } from "./focus-contract.js";
export interface FocusSession {
  id: string;
  name: string;
  state: string;
  changedAt?: string;
  cwd?: string;
  machine?: string;
  machineUrl?: string;
}
export interface FocusAction {
  kind: "open" | "start";
  intention?: FocusIntention;
  session?: FocusSession;
  reason: string;
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
/** Intention order is authoritative. Working/idle sessions remain chips, never next actions; a recent finish is a next action. */
export function rankFocus(doc: FocusDocument, sessions: readonly FocusSession[], cap = 5, now = Date.now()): FocusAction[] {
  const linked = new Set<FocusSession>();
  const attention: FocusAction[] = [];
  const starts: FocusAction[] = [];
  const finished: FocusAction[] = [];
  for (const intention of doc.intentions) {
    const live = linkedFocusSessions(intention, sessions);
    live.forEach(s => linked.add(s));
    if (intention.done) continue;
    for (const session of live.filter(needsYou).sort(oldest)) {
      if (!attention.some(row => row.session === session)) attention.push({ kind: "open", intention, session, reason: "Needs you for this intention; intention order, then oldest first." });
    }
    if (live.length === 0) starts.push({ kind: "start", intention, reason: "An unfinished intention with no live session, in your order." });
    for (const session of live.filter(s => s.state === AGENT_STATUS_STATE.DONE && now - at(s) <= FINISHED_WINDOW_MS).sort(oldest).reverse()) {
      if (!finished.some(row => row.session === session)) finished.push({ kind: "open", intention, session, reason: "Finished work on this intention; look before it goes stale." });
    }
  }
  const unlinked = sessions.filter(s => !linked.has(s) && needsYou(s)).sort(oldest).map(session => ({ kind: "open" as const, session, reason: "Unlinked session needs you; oldest first." }));
  return [...attention, ...starts, ...finished, ...unlinked].slice(0, Math.max(0, cap));
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
