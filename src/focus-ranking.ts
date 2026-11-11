import { AGENT_STATUS_STATE } from "./agent-status-contract.js";
import { focusNextRefKey, type FocusDocument, type FocusIntention, type FocusTriage } from "./focus-contract.js";
import { ASSISTANT_TIMING_DEFAULTS } from "./focus-scheduler.js";
import type { ProgramStatusKind } from "./program-status-contract.js";
export interface FocusSession {
  id: string;
  name: string;
  state: string;
  inputKind?: ProgramStatusKind;
  changedAt?: string;
  stoppedAt?: string;
  unseen?: boolean;
  stoppedSequence?: number;
  acknowledgedSequence?: number;
  cwd?: string;
  machine?: string;
  machineUrl?: string;
  machineInstallationId?: string;
  parentId?: string;
  children?: { total: number; working: number; status: string };
  /** Shown in the card body only; ranking ignores it. */
  lastLine?: string;
}
/** An unreviewed work episode, not merely an unseen metadata transition. */
export function stoppedUnseen(session: { state: string; unseen?: boolean; stoppedSequence?: number; acknowledgedSequence?: number }): boolean {
  return session.unseen === true && (session.state === AGENT_STATUS_STATE.DONE || session.state === AGENT_STATUS_STATE.IDLE)
    && (session.stoppedSequence ?? 0) > (session.acknowledgedSequence ?? 0);
}
export interface FocusAction {
  kind: "open" | "start" | "intention";
  intention?: FocusIntention;
  session?: FocusSession;
  reason: string;
  source?: "assistant" | "new-rules" | "rules";
  triage?: FocusTriage;
  unavailable?: boolean;
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
const byIdentity = (a: FocusSession, b: FocusSession) => a.id.localeCompare(b.id) || (a.machine ?? "").localeCompare(b.machine ?? "");
const oldest = (a: FocusSession, b: FocusSession) => at(a) - at(b) || byIdentity(a, b);
const stoppedAt = (s: FocusSession) => Date.parse(s.stoppedAt ?? s.changedAt ?? "") || 0;
const newestStop = (a: FocusSession, b: FocusSession) => stoppedAt(b) - stoppedAt(a) || byIdentity(a, b);
/** Rules fallback: linked needs-you → linked stopped-unseen → starts → unlinked needs-you → unlinked stopped-unseen.
 * Intention order, then oldest attention / newest stop first; unseen stops never expire. Reviewed finishes remain chips/done today.
 */
export function rankFocus(doc: FocusDocument, sessions: readonly FocusSession[], cap = 5, now = Date.now()): FocusAction[] {
  const linked = new Set<FocusSession>();
  const attention: FocusAction[] = [];
  const stopped: FocusAction[] = [];
  const starts: FocusAction[] = [];
  for (const intention of doc.intentions) {
    // Completed intentions cannot hide later attention or unseen stops from the unlinked groups.
    if (intention.done) continue;
    const live = linkedFocusSessions(intention, sessions);
    live.forEach(s => linked.add(s));
    for (const session of live.filter(needsYou).sort(oldest)) {
      if (!attention.some(row => row.session === session)) attention.push({ kind: "open", intention, session, reason: "Needs you for this intention; intention order, then oldest first." });
    }
    for (const session of live.filter(stoppedUnseen).sort(newestStop)) {
      if (!stopped.some(row => row.session === session)) stopped.push({ kind: "open", intention, session, reason: "Stopped work on this intention you have not seen; intention order, then newest first." });
    }
    if (live.length === 0) starts.push({ kind: "start", intention, reason: "An unfinished intention with no live session, in your order." });
  }
  const unlinked = sessions.filter(s => !linked.has(s) && needsYou(s)).sort(oldest).map(session => ({ kind: "open" as const, session, reason: "Unlinked session needs you; oldest first." }));
  const unlinkedStopped = sessions.filter(s => !linked.has(s) && stoppedUnseen(s)).sort(newestStop).map(session => ({ kind: "open" as const, session, reason: "Stopped unlinked work you have not seen; newest first." }));
  return [...attention, ...stopped, ...starts, ...unlinked, ...unlinkedStopped].slice(0, Math.max(0, cap));
}
export interface FocusMergeOptions {
  enabled: boolean;
  stale?: boolean;
  ttlHours?: number;
  now?: number;
  cap?: number;
  /** A verified installation, not an arbitrary assistant-authored id. */
  machineKnown: (installationId: string) => boolean;
  /** True only for a current successful session listing, not merely a ready handshake. */
  machineReachable: (installationId: string) => boolean;
}
export interface FocusMerge { rows: FocusAction[]; order: "assistant" | "rules" | "expired"; updatedAt?: string }
export function mergeFocus(doc: FocusDocument, sessions: readonly FocusSession[], options: FocusMergeOptions): FocusMerge {
  const now = options.now ?? Date.now();
  const cap = Math.max(0, options.cap ?? 5);
  const rules = rankFocus(doc, sessions, Infinity, now).map(row => ({ ...row,
    ...(row.session?.machineInstallationId && !options.machineReachable(row.session.machineInstallationId) && { unavailable: true }),
  }));
  const next = doc.next;
  const expired = !!next && now - Date.parse(next.updatedAt) >= (options.ttlHours ?? ASSISTANT_TIMING_DEFAULTS.nextOrderTtlHours) * 3600_000;
  if (!next || !options.enabled || options.stale || expired) return {
    rows: rules.slice(0, cap).map(row => ({ ...row, source: "rules" })),
    order: options.enabled && !options.stale && expired ? "expired" : "rules",
  };
  const judged = new Set<string>();
  const assistant: FocusAction[] = [];
  const rowKey = (row: FocusAction) => row.session
    ? focusNextRefKey({ machine: row.session.machineInstallationId ?? "", sessionId: row.session.id })
    : focusNextRefKey({ intentionId: row.intention!.id });
  for (const triage of next.rows) {
    // A user tick/drop invalidates a done-only proposal, not the unseen session episode.
    if (triage.doneIntention && !triage.suggestion && !doc.intentions.some(i => i.id === triage.doneIntention && !i.done)) continue;
    const ref = triage.ref;
    let row: FocusAction | undefined;
    if ("sessionId" in ref) {
      if (!options.machineKnown(ref.machine)) continue;
      const session = sessions.find(s => s.id === ref.sessionId && s.machineInstallationId === ref.machine);
      // Availability must not revive a verdict for a different cached episode.
      if (session && Date.parse(session.stoppedAt ?? session.changedAt ?? "") !== Date.parse(triage.stoppedAt ?? "")) continue;
      // Quiet is never authority to hide attention, even when the assistant judged this exact episode.
      if (triage.verdict === "quiet" && (!session || needsYou(session))) continue;
      if (!options.machineReachable(ref.machine)) {
        // Keep the assistant's place and reason; no session action can use this placeholder.
        row = { kind: "open", reason: triage.reason, unavailable: true };
      } else if (session) {
        const rule = rules.find(r => r.session === session);
        const done = triage.doneIntention && doc.intentions.find(i => i.id === triage.doneIntention && !i.done);
        if (rule) row = rule;
        // A reviewed finish may continue as a mark-done proposal, never a second generic finished row.
        else if (done && session.state === AGENT_STATUS_STATE.DONE) row = { kind: "open", session, intention: done, reason: triage.reason };
      }
    } else {
      const intention = doc.intentions.find(i => i.id === ref.intentionId && !i.done);
      if (intention) row = rules.find(r => !r.session && r.intention === intention)
        ?? { kind: "intention", intention, reason: triage.reason };
    }
    if (!row) continue;
    judged.add(focusNextRefKey(ref));
    if (triage.verdict !== "quiet" || row.session?.state === AGENT_STATUS_STATE.DONE && stoppedUnseen(row.session)) assistant.push({ ...row, source: "assistant", triage, reason: triage.reason });
  }
  const unjudged = rules.filter(row => !judged.has(rowKey(row))).map(row => ({ ...row, source: "new-rules" as const }));
  return {
    rows: [...unjudged.filter(row => row.session && needsYou(row.session)), ...assistant,
      ...unjudged.filter(row => !row.session || !needsYou(row.session))].slice(0, cap),
    order: "assistant", updatedAt: next.updatedAt,
  };
}
export interface FocusCard { row: FocusAction; kind: "action" | "suggest" | "done" }
/** Classify the full merge before presentation caps. Attention always beats delegation suppression. */
export function focusCards(rows: readonly FocusAction[], sessions: readonly FocusSession[]): {
  cards: FocusCard[]; waiting: FocusSession[]; working: number; notReached: FocusAction[];
} {
  const cards: FocusCard[] = [];
  const waiting = sessions.filter(s => stoppedUnseen(s) && (s.children?.working ?? 0) > 0 && !needsYou(s));
  const notReached: FocusAction[] = [];
  for (const row of rows) {
    const s = row.session;
    if (s && needsYou(s) || row.triage?.verdict === "needs-you") cards.push({ row, kind: "action" });
    else if (row.triage?.verdict === "suggest" && (row.triage.suggestion || row.triage.doneIntention)) cards.push({ row, kind: "suggest" });
    else if (row.unavailable && !s) notReached.push(row);
    else if (s && stoppedUnseen(s)) {
      if ((s.children?.working ?? 0) > 0) continue;
      if (s.parentId && sessions.some(parent => parent.id === s.parentId && parent.machineInstallationId === s.machineInstallationId && parent.machineUrl === s.machineUrl)) continue;
      if (s.state === AGENT_STATUS_STATE.DONE || !row.triage) cards.push({ row, kind: "done" });
    }
  }
  return { cards, waiting, working: sessions.filter(s => s.state === AGENT_STATUS_STATE.WORKING).length, notReached };
}
export type FocusDoneItem = { at: string; kind: "intention"; intention: FocusIntention } | { at: string; kind: "session"; intention: FocusIntention; session: FocusSession };
/** Today's timeline: ticked intentions and linked finishes, excluding stopped-unseen work until reviewed. `day` maps a timestamp to its day label. */
export function doneToday(doc: FocusDocument, sessions: readonly FocusSession[], now: number, day: (at: string) => string): FocusDoneItem[] {
  const today = day(new Date(now).toISOString());
  const items: FocusDoneItem[] = [];
  for (const intention of doc.intentions) {
    if (intention.done && intention.doneAt && day(intention.doneAt) === today) items.push({ at: intention.doneAt, kind: "intention", intention });
    for (const session of linkedFocusSessions(intention, sessions)) {
      if (session.state === AGENT_STATUS_STATE.DONE && !stoppedUnseen(session) && session.changedAt && day(session.changedAt) === today && !items.some(i => i.kind === "session" && i.session === session)) items.push({ at: session.changedAt, kind: "session", intention, session });
    }
  }
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
