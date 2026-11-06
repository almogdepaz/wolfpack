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
const oldest = (a: FocusSession, b: FocusSession) => (Date.parse(a.changedAt ?? "") || 0) - (Date.parse(b.changedAt ?? "") || 0) || a.id.localeCompare(b.id) || (a.machine ?? "").localeCompare(b.machine ?? "");
/** Intention order is authoritative. Working/idle sessions remain chips, never next actions. */
export function rankFocus(doc: FocusDocument, sessions: readonly FocusSession[], cap = 5): FocusAction[] {
  const linked = new Set<FocusSession>();
  const attention: FocusAction[] = [];
  const starts: FocusAction[] = [];
  for (const intention of doc.intentions) {
    const live = linkedFocusSessions(intention, sessions);
    live.forEach(s => linked.add(s));
    if (intention.done) continue;
    for (const session of live.filter(needsYou).sort(oldest)) {
      if (!attention.some(row => row.session === session)) attention.push({ kind: "open", intention, session, reason: "Needs you for this intention; intention order, then oldest first." });
    }
    if (live.length === 0) starts.push({ kind: "start", intention, reason: "An unfinished intention with no live session, in your order." });
  }
  const unlinked = sessions.filter(s => !linked.has(s) && needsYou(s)).sort(oldest).map(session => ({ kind: "open" as const, session, reason: "Unlinked session needs you; oldest first." }));
  return [...attention, ...starts, ...unlinked].slice(0, Math.max(0, cap));
}
