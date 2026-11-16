import { ACTIVITY_KIND as K, INPUT_SOURCE, type ActivityRow } from "./activity-journal.js";
import { AGENT_STATUS_STATE as STATE } from "./agent-status-contract.js";
import { FOCUS_UI_ACTION as A, FOCUS_UI_CARD as C, type FocusUiCard, type FocusUiRow } from "./focus-ui-log.js";
export interface FocusRetro {
  date: string;
  visits: { visit: string; openedAt: string; leftAt: string | null; visibleMs: number | null }[];
  cards: (FocusUiCard & { visit: string; shownSeq: number; shownAt: string; firstAction: { control: string; at: string; latencyMs: number } | null })[];
  needsInput: { session: string; sessionId?: string; startedAt: string; resolvedAt: string | null; resolutionMs: number | null; via: "focus" | "elsewhere" | "unknown"; focusAction: string | null }[];
}
export function isRetroDate(date: string): boolean {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return /^\d{4}-\d\d-\d\d$/.test(date) && Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}
const timeOrder = (a: { at: string; seq: number }, b: { at: string; seq: number }) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq;
const identity = (card: { machine: string; sessionId: string }) => JSON.stringify([card.machine, card.sessionId]);
/** Day-bounded, observational attribution, not proof that a click caused a state transition.
 * A continuous impression survives unrelated set changes; rank/kind/reason changes start a new one.
 */
export function buildFocusRetro(date: string, ui: readonly FocusUiRow[], activity: readonly ActivityRow[], localMachine?: string): FocusRetro {
  if (!isRetroDate(date)) throw new Error("date must be YYYY-MM-DD (UTC)");
  const result: FocusRetro = { date, visits: [], cards: [], needsInput: [] };
  const uiRows = ui.filter(row => row.at.slice(0, 10) === date).sort(timeOrder);
  const visits = new Map<string, FocusRetro["visits"][number]>();
  const impressions = new Map<string, Map<string, FocusRetro["cards"][number]>>();
  for (const row of uiRows) {
    if (row.action === A.OPEN) {
      const visit = { visit: row.visit, openedAt: row.at, leftAt: null, visibleMs: null };
      visits.set(row.visit, visit); result.visits.push(visit);
      impressions.set(row.visit, new Map());
    } else if (row.action === A.LEFT) {
      const visit = visits.get(row.visit);
      if (visit) { visit.leftAt = row.at; visit.visibleMs = row.visibleMs; }
      impressions.delete(row.visit);
    } else if (row.action === A.SHOWN) {
      const prior = impressions.get(row.visit) ?? new Map<string, FocusRetro["cards"][number]>();
      const current = new Map<string, FocusRetro["cards"][number]>();
      for (const card of row.cards) {
        const key = identity(card), previous = prior.get(key);
        const same = previous && previous.rank === card.rank && previous.kind === card.kind && previous.reason === card.reason;
        const impression = same ? previous : { ...card, visit: row.visit, shownSeq: row.seq, shownAt: row.at, firstAction: null };
        if (!same) result.cards.push(impression);
        current.set(key, impression);
      }
      impressions.set(row.visit, current);
    } else if (row.action === A.CARD) {
      const impression = impressions.get(row.visit)?.get(identity(row));
      if (impression && !impression.firstAction) impression.firstAction = { control: row.control, at: row.at, latencyMs: Date.parse(row.at) - Date.parse(impression.shownAt) };
    }
  }
  const pending = new Map<string, FocusRetro["needsInput"][number]>();
  const aliases = new Map<string, string>();
  const inputs: { key: string; at: string; source: string }[] = [];
  const resolvedStates: readonly string[] = [STATE.WORKING, STATE.RUNNING, STATE.AUDIT, STATE.CLEANUP, STATE.DONE, STATE.IDLE, STATE.FAILED, STATE.STOPPED, STATE.OFF];
  for (const row of activity.filter(row => row.at.slice(0, 10) === date).sort(timeOrder)) {
    if (row.kind === K.TASK_UPDATED) continue;
    const session = "session" in row ? row.session : undefined;
    const sessionId = "sessionId" in row ? row.sessionId : undefined;
    if (session && sessionId) aliases.set(session, sessionId);
    const knownId = sessionId ?? (session && aliases.get(session));
    const key = knownId ?? `name:${session}`;
    if (row.kind === K.INPUT) { inputs.push({ key, at: row.at, source: row.source }); continue; }
    const state = "state" in row ? row.state : undefined;
    if (state === STATE.NEEDS_INPUT && session) {
      if (!pending.has(key)) {
        const episode: FocusRetro["needsInput"][number] = { session, ...(knownId && { sessionId: knownId }), startedAt: row.at, resolvedAt: null, resolutionMs: null, via: "unknown", focusAction: null };
        pending.set(key, episode); result.needsInput.push(episode);
      }
    } else if (row.kind === K.SESSION_EXITED || state && resolvedStates.includes(state)) {
      const episode = pending.get(key);
      if (episode) { episode.resolvedAt = row.at; episode.resolutionMs = Date.parse(row.at) - Date.parse(episode.startedAt); pending.delete(key); }
    }
  }
  for (const episode of result.needsInput) {
    if (!episode.resolvedAt) continue;
    const start = Date.parse(episode.startedAt), end = Date.parse(episode.resolvedAt);
    const within = (at: string) => Date.parse(at) >= start && Date.parse(at) <= end;
    // No reusable-name join. Remote UI cards never borrow this machine's activity.
    const actions = episode.sessionId ? uiRows.filter((row): row is Extract<FocusUiRow, { action: typeof A.CARD }> => row.action === A.CARD && row.sessionId === episode.sessionId && row.machine === localMachine && within(row.at) && [C.REPLY, C.OPEN, C.TAKE].includes(row.control as typeof C.REPLY | typeof C.OPEN | typeof C.TAKE)) : [];
    const presence = inputs.filter(row => row.key === episode.sessionId && within(row.at));
    const direct = actions.find(row => row.control === C.REPLY);
    const opened = actions.find(row => row.control !== C.REPLY && presence.some(input => input.source === INPUT_SOURCE.BROWSER && Date.parse(input.at) >= Date.parse(row.at)));
    const via = direct ?? opened;
    if (via) { episode.via = "focus"; episode.focusAction = via.control; }
    else if (presence.length) episode.via = "elsewhere";
  }
  return result;
}
