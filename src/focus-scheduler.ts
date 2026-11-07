/**
 * Pure routine scheduling for the focus assistant. The home server feeds it
 * cursors, journal heads, assistant idleness and coverage; it returns at most
 * the next routine step. One inbox is outstanding at a time.
 *
 * Day boundary: an activity day turns at the configured fallback time (03:00
 * by default), so work that runs past midnight belongs to the day it started
 * and the fallback review fires exactly when that day ends.
 */
export const ROUTINE = { CATCH_UP: "catch-up", DAY_REVIEW: "day-review", GAP_REVIEW: "gap-review" } as const;
export type Routine = typeof ROUTINE[keyof typeof ROUTINE];
export const ROUTINE_RESEND_CAP = 3;
export const STALE_AFTER_MS = 24 * 60 * 60_000;

export interface AssistantTiming { quietMinutes: number; fallbackTime: string; catchUpDebounceMinutes: number; journalRetentionDays: number }
export const ASSISTANT_TIMING_DEFAULTS: AssistantTiming = Object.freeze({ quietMinutes: 90, fallbackTime: "03:00", catchUpDebounceMinutes: 15, journalRetentionDays: 30 });
const RANGES = { quietMinutes: [15, 480], catchUpDebounceMinutes: [1, 120], journalRetentionDays: [1, 365] } as const;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN = 60_000;

const inRange = (key: keyof typeof RANGES, v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= RANGES[key][0] && (v as number) <= RANGES[key][1];
/** Lenient read of stored settings: each invalid or missing field falls back to its default. */
export function parseAssistantTiming(raw: unknown): AssistantTiming {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    quietMinutes: inRange("quietMinutes", v.quietMinutes) ? v.quietMinutes : ASSISTANT_TIMING_DEFAULTS.quietMinutes,
    fallbackTime: typeof v.fallbackTime === "string" && TIME.test(v.fallbackTime) ? v.fallbackTime : ASSISTANT_TIMING_DEFAULTS.fallbackTime,
    catchUpDebounceMinutes: inRange("catchUpDebounceMinutes", v.catchUpDebounceMinutes) ? v.catchUpDebounceMinutes : ASSISTANT_TIMING_DEFAULTS.catchUpDebounceMinutes,
    journalRetentionDays: inRange("journalRetentionDays", v.journalRetentionDays) ? v.journalRetentionDays : ASSISTANT_TIMING_DEFAULTS.journalRetentionDays,
  };
}
/** Strict validation of a settings write: all four fields, in range, nothing else. */
export function validateAssistantTiming(raw: unknown): { ok: true; value: AssistantTiming } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "assistant settings must be an object" };
  const v = raw as Record<string, unknown>;
  const keys = Object.keys(ASSISTANT_TIMING_DEFAULTS);
  if (Object.keys(v).some(k => !keys.includes(k)) || keys.some(k => !(k in v))) return { ok: false, error: `assistant settings require exactly ${keys.join(", ")}` };
  for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    if (!inRange(key, v[key])) return { ok: false, error: `${key} must be a whole number from ${RANGES[key][0]} to ${RANGES[key][1]}` };
  }
  if (typeof v.fallbackTime !== "string" || !TIME.test(v.fallbackTime)) return { ok: false, error: "fallbackTime must be HH:MM (00:00–23:59)" };
  return { ok: true, value: v as unknown as AssistantTiming };
}

const pad = (n: number) => String(n).padStart(2, "0");
const label = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return label(new Date(y!, m! - 1, d! + n));
}
/** Local [start, end) of an activity day. Evening boundaries label the window by its end date. */
export function activityDayWindow(day: string, fallbackTime: string): { start: number; end: number } {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = fallbackTime.split(":").map(Number);
  const shift = hh! * 60 + mm! > 12 * 60 ? -1 : 0;
  return { start: new Date(y!, m! - 1, d! + shift, hh, mm).getTime(), end: new Date(y!, m! - 1, d! + shift + 1, hh, mm).getTime() };
}
export function activityDayOf(ms: number, fallbackTime: string): string {
  const day = label(new Date(ms));
  const window = activityDayWindow(day, fallbackTime);
  return ms < window.start ? addDays(day, -1) : ms >= window.end ? addDays(day, 1) : day;
}

export interface SchedulerMachine {
  id: string;
  reachable: boolean;
  /** Journal head is past this machine's catch-up cursor. */
  pendingRows: boolean;
  lastRowAt: string | null;
  /** Last user input row (from the latest probe, else the last known value from the cursors). */
  lastInputAt: string | null;
}
export interface SchedulerInbox { file: string; routine: Routine; sends: number; lastSentAt: string | null; queued: boolean; surfaced: boolean }
export interface SchedulerInput {
  now: number;
  timing: AssistantTiming;
  enabled: boolean;
  /** Assistant resting and its send queue empty. */
  idle: boolean;
  /** Server just started: the first catch-up bypasses the debounce. */
  booting: boolean;
  /** Assistant incarnation changed since the last routine. */
  restarted: boolean;
  /** User pressed `catch up now`. */
  manual: boolean;
  machines: readonly SchedulerMachine[];
  reviewedThrough: string | null;
  /** Day of a provisional quiet review already run: no further quiet review that day. */
  provisional?: string | null;
  lastRun: Partial<Record<Routine, string>>;
  inbox: SchedulerInbox | null;
}
export type RoutineAction =
  | { type: typeof ROUTINE.GAP_REVIEW; days: string[] }
  | { type: typeof ROUTINE.DAY_REVIEW; days: string[]; reason: "quiet" | "fallback" }
  | { type: typeof ROUTINE.CATCH_UP; reason: "activity" | "boot" | "restart" | "manual" }
  | { type: "resend" | "surface" | "drop-inbox"; file: string };

const ms = (at: string | null | undefined) => at ? Date.parse(at) : NaN;
const elapsed = (now: number, at: string | null | undefined, minutes: number) => !(now - ms(at) < minutes * MIN);

export function decideRoutines(input: SchedulerInput): RoutineAction[] {
  const { now, timing, inbox } = input;
  if (!input.enabled) return [];
  if (input.manual) return [...(inbox ? [{ type: "drop-inbox" as const, file: inbox.file }] : []), { type: ROUTINE.CATCH_UP, reason: "manual" }];
  if (!input.idle) return [];
  if (inbox) {
    if (inbox.queued || inbox.surfaced) return [];
    if (inbox.lastSentAt && !elapsed(now, inbox.lastSentAt, timing.catchUpDebounceMinutes)) return [];
    return [{ type: inbox.sends > ROUTINE_RESEND_CAP ? "surface" : "resend", file: inbox.file }];
  }
  const today = activityDayOf(now, timing.fallbackTime);
  const yesterday = addDays(today, -1);
  // Completed days not yet reviewed: one turn for all of them, bounded by what the journals still hold.
  if (input.reviewedThrough === null || input.reviewedThrough < yesterday) {
    const first = [input.reviewedThrough ? addDays(input.reviewedThrough, 1) : yesterday, addDays(today, -timing.journalRetentionDays)].sort().at(-1)!;
    const days: string[] = [];
    for (let day = first; day <= yesterday; day = addDays(day, 1)) days.push(day);
    const routine = !input.booting && input.reviewedThrough === addDays(yesterday, -1);
    return [routine ? { type: ROUTINE.DAY_REVIEW, days, reason: "fallback" } : { type: ROUTINE.GAP_REVIEW, days }];
  }
  // Today's (provisional) review: someone typed today, and every machine with rows today has been quiet for the threshold.
  const window = activityDayWindow(today, timing.fallbackTime);
  const todays = input.machines.filter(m => ms(m.lastRowAt) >= window.start);
  if (input.reviewedThrough < today && input.provisional !== today && todays.some(m => ms(m.lastInputAt) >= window.start)
    && todays.every(m => elapsed(now, m.lastInputAt, timing.quietMinutes))) {
    return [{ type: ROUTINE.DAY_REVIEW, days: [today], reason: "quiet" }];
  }
  if (!input.machines.some(m => m.pendingRows)) return [];
  if (input.booting) return [{ type: ROUTINE.CATCH_UP, reason: "boot" }];
  if (input.restarted) return [{ type: ROUTINE.CATCH_UP, reason: "restart" }];
  return elapsed(now, input.lastRun[ROUTINE.CATCH_UP], timing.catchUpDebounceMinutes) ? [{ type: ROUTINE.CATCH_UP, reason: "activity" }] : [];
}
