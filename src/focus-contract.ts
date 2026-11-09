/** Durable focus is independent of an agent process. All writes go through this reducer. */
export interface FocusIntention {
  id: string;
  title: string;
  project?: string;
  machine?: string;
  sessions?: readonly string[];
  done?: boolean;
  /** Set by the reducer when the intention is ticked done, cleared on undo: "know when items are done". */
  doneAt?: string;
  createdAt: string;
}
export type FocusNextRef = { machine: string; sessionId: string } | { intentionId: string };
export interface FocusTriage {
  ref: FocusNextRef;
  verdict: "needs-you" | "suggest" | "quiet";
  reason: string;
  /** Required for session refs: the judged stop/input episode, never an acknowledgement. */
  stoppedAt?: string;
  suggestion?: string;
  doneIntention?: string;
}
export interface FocusNext { rows: FocusTriage[]; author: string; updatedAt: string }
export interface FocusDaySummary { date: string; done: number; carried: number; questions: number }
export interface FocusDocument {
  version: 1;
  revision: number;
  updatedAt: string | null;
  intentions: FocusIntention[];
  nudge?: { text: string; updatedAt: string; author: string };
  next?: FocusNext;
  notes?: string;
  daySummary?: FocusDaySummary;
  seenDayNoteAt?: string;
}
export type FocusOp =
  | { type: "add"; intention: Omit<FocusIntention, "createdAt" | "done"> }
  | { type: "edit"; id: string; patch: Partial<Pick<FocusIntention, "title" | "project" | "machine" | "sessions">> }
  | { type: "done" | "undo" | "drop"; id: string }
  | { type: "reorder"; ids: readonly string[] }
  | { type: "nudge"; text: string; author: string }
  | { type: "next"; rows: FocusTriage[]; author: string }
  | { type: "note"; text: string }
  | { type: "day-summary"; summary: FocusDaySummary }
  | { type: "seen-day-note"; at: string };

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, max: number, empty = false): v is string => typeof v === "string" && v.length <= max && (empty || v.trim().length > 0);
const timestamp = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(v);
const strings = (v: unknown, max: number) => Array.isArray(v) && v.length <= max && v.every(s => text(s, 256)) && new Set(v).size === v.length;
function intentionFields(v: Record<string, unknown>): boolean {
  return (v.title === undefined || text(v.title, 500)) && (v.project === undefined || text(v.project, 4096))
    && (v.machine === undefined || text(v.machine, 256)) && (v.sessions === undefined || strings(v.sessions, 100));
}
const oneLine = (v: unknown, max: number): v is string => text(v, max) && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(v);
export function focusNextRefKey(ref: FocusNextRef): string {
  return "sessionId" in ref ? JSON.stringify([ref.machine, ref.sessionId]) : JSON.stringify([ref.intentionId]);
}
function triage(v: unknown): v is FocusTriage {
  if (!object(v) || !keys(v, ["ref", "verdict", "reason", "stoppedAt", "suggestion", "doneIntention"]) || !object(v.ref)) return false;
  const session = keys(v.ref, ["machine", "sessionId"]) && id(v.ref.machine) && oneLine(v.ref.sessionId, 128);
  const intention = keys(v.ref, ["intentionId"]) && id(v.ref.intentionId);
  return (session ? timestamp(v.stoppedAt) : intention && v.stoppedAt === undefined)
    && typeof v.verdict === "string" && ["needs-you", "suggest", "quiet"].includes(v.verdict) && oneLine(v.reason, 300)
    && (v.suggestion === undefined || (v.verdict === "suggest" && oneLine(v.suggestion, 200)))
    && (v.doneIntention === undefined || (v.verdict === "suggest" && id(v.doneIntention)))
    && (v.verdict !== "suggest" || v.suggestion !== undefined || v.doneIntention !== undefined)
    && (v.suggestion === undefined || session);
}
function triageRows(v: unknown): v is FocusTriage[] {
  return Array.isArray(v) && v.length <= 200 && v.every(triage)
    && new Set(v.map(row => focusNextRefKey(row.ref))).size === v.length;
}
function daySummary(v: unknown): v is FocusDaySummary {
  return object(v) && keys(v, ["date", "done", "carried", "questions"]) && typeof v.date === "string" && /^\d{4}-\d\d-\d\d$/.test(v.date)
    && [v.done, v.carried, v.questions].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 10000);
}
export function emptyFocus(): FocusDocument { return { version: 1, revision: 0, updatedAt: null, intentions: [] }; }
export function isFocusDocument(v: unknown): v is FocusDocument {
  if (!object(v) || !keys(v, ["version", "revision", "updatedAt", "intentions", "nudge", "next", "notes", "daySummary", "seenDayNoteAt"])) return false;
  return v.version === 1 && Number.isSafeInteger(v.revision) && (v.revision as number) >= 0 && (v.updatedAt === null || timestamp(v.updatedAt))
    && Array.isArray(v.intentions) && v.intentions.length <= 200 && v.intentions.every(i => object(i)
      && keys(i, ["id", "title", "project", "machine", "sessions", "done", "doneAt", "createdAt"]) && id(i.id) && text(i.title, 500) && timestamp(i.createdAt)
      && intentionFields(i) && (i.done === undefined || typeof i.done === "boolean") && (i.doneAt === undefined || timestamp(i.doneAt)))
    && new Set(v.intentions.map(i => i.id)).size === v.intentions.length
    && (v.nudge === undefined || (object(v.nudge) && keys(v.nudge, ["text", "updatedAt", "author"]) && text(v.nudge.text, 1000, true) && timestamp(v.nudge.updatedAt) && text(v.nudge.author, 128)))
    && (v.next === undefined || (object(v.next) && keys(v.next, ["rows", "author", "updatedAt"]) && triageRows(v.next.rows) && oneLine(v.next.author, 128) && timestamp(v.next.updatedAt)))
    && (v.notes === undefined || text(v.notes, 16000, true)) && (v.daySummary === undefined || daySummary(v.daySummary))
    && (v.seenDayNoteAt === undefined || timestamp(v.seenDayNoteAt));
}
export function isFocusOp(v: unknown): v is FocusOp {
  if (!object(v)) return false;
  switch (v.type) {
    case "add": return keys(v, ["type", "intention"]) && object(v.intention) && keys(v.intention, ["id", "title", "project", "machine", "sessions"])
      && id(v.intention.id) && text(v.intention.title, 500) && intentionFields(v.intention);
    case "edit": return keys(v, ["type", "id", "patch"]) && id(v.id) && object(v.patch) && Object.keys(v.patch).length > 0
      && keys(v.patch, ["title", "project", "machine", "sessions"]) && intentionFields(v.patch);
    case "done": case "undo": case "drop": return keys(v, ["type", "id"]) && id(v.id);
    case "reorder": return keys(v, ["type", "ids"]) && strings(v.ids, 200);
    case "nudge": return keys(v, ["type", "text", "author"]) && text(v.text, 1000, true) && text(v.author, 128);
    case "next": return keys(v, ["type", "rows", "author"]) && triageRows(v.rows) && oneLine(v.author, 128);
    case "note": return keys(v, ["type", "text"]) && text(v.text, 16000, true);
    case "day-summary": return keys(v, ["type", "summary"]) && daySummary(v.summary);
    case "seen-day-note": return keys(v, ["type", "at"]) && timestamp(v.at);
    default: return false;
  }
}
export function reduceFocus(current: FocusDocument, ops: unknown, now: string): FocusDocument {
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > 100 || !ops.every(isFocusOp) || !timestamp(now)) throw new Error("invalid focus operations");
  const doc = structuredClone(current);
  for (const op of ops) {
    switch (op.type) {
      case "add":
        if (doc.intentions.some(i => i.id === op.intention.id)) throw new Error("duplicate intention id");
        doc.intentions.push({ ...op.intention, createdAt: now }); break;
      case "edit": case "done": case "undo": case "drop": {
        const index = doc.intentions.findIndex(i => i.id === op.id);
        if (index < 0) throw new Error(`intention not found: ${op.id}`);
        if (op.type === "drop") doc.intentions.splice(index, 1);
        else if (op.type === "edit") Object.assign(doc.intentions[index]!, op.patch);
        // a repeated done (the assistant re-running `wolfpack focus done`) keeps the first tick's time
        else if (op.type === "done") { const i = doc.intentions[index]!; Object.assign(i, { done: true, doneAt: i.done && i.doneAt ? i.doneAt : now }); }
        else { doc.intentions[index]!.done = false; delete doc.intentions[index]!.doneAt; }
        break;
      }
      case "reorder": {
        if (op.ids.length !== doc.intentions.length || !op.ids.every(key => doc.intentions.some(i => i.id === key))) throw new Error("reorder requires every intention id exactly once");
        doc.intentions = op.ids.map(key => doc.intentions.find(i => i.id === key)!); break;
      }
      case "nudge": doc.nudge = { text: op.text, author: op.author, updatedAt: now }; break;
      case "next":
        for (const row of op.rows) {
          for (const key of ["intentionId" in row.ref ? row.ref.intentionId : undefined, row.doneIntention]) {
            if (key && !doc.intentions.some(i => i.id === key)) throw new Error(`intention not found: ${key}`);
          }
        }
        doc.next = { rows: structuredClone(op.rows), author: op.author, updatedAt: now }; break;
      case "note": doc.notes = op.text; break;
      case "day-summary": doc.daySummary = op.summary; break;
      case "seen-day-note": doc.seenDayNoteAt = op.at; break;
    }
  }
  doc.revision++;
  doc.updatedAt = now;
  if (!isFocusDocument(doc)) throw new Error("focus document exceeds limits");
  return doc;
}
