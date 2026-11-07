/**
 * Per-machine activity journal contract: append-only JSONL rows with a
 * monotonic `seq`, day-partitioned files, tail recovery and cursor paging.
 * Rows describe sessions, never terminal content. Shared by server and cli.
 */
export const ACTIVITY_PATH = "/api/activity";
export const ACTIVITY_KIND = {
  SESSION_CREATED: "session.created",
  /** Startup reconciliation: a session already live when this server started. */
  SESSION_LIVE: "session.live",
  SESSION_STATE: "session.state",
  SESSION_EXITED: "session.exited",
  TASK_UPDATED: "task.updated",
  /** Coarse presence: one row per session per bucket, never content. */
  INPUT: "input",
} as const;
export type ActivityKind = typeof ACTIVITY_KIND[keyof typeof ACTIVITY_KIND];
export const INPUT_SOURCE = { BROWSER: "browser", CLI: "cli" } as const;
export type InputSource = typeof INPUT_SOURCE[keyof typeof INPUT_SOURCE];

interface SessionStart { session: string; sessionId: string; cwd: string; harness?: string; branch?: string; head?: string; state?: string }
export type ActivityRowBody =
  | ({ kind: typeof ACTIVITY_KIND.SESSION_CREATED | typeof ACTIVITY_KIND.SESSION_LIVE } & SessionStart)
  | { kind: typeof ACTIVITY_KIND.SESSION_STATE; session: string; sessionId?: string; state: string; label: string; message?: string; inputKind?: string }
  | { kind: typeof ACTIVITY_KIND.SESSION_EXITED; session?: string; sessionId: string; reason: string; exitCode?: number; signal?: number; head?: string }
  | { kind: typeof ACTIVITY_KIND.TASK_UPDATED; taskId: string; eventType: string }
  | { kind: typeof ACTIVITY_KIND.INPUT; session: string; sessionId?: string; source: InputSource; bucket: string };
export type ActivityRow = ActivityRowBody & { seq: number; at: string };

export const PRESENCE_BUCKET_MS = 5 * 60_000;
export const ACTIVITY_PAGE_DEFAULT = 500;
export const ACTIVITY_PAGE_MAX = 1000;
export const ACTIVITY_RETENTION_DAYS_DEFAULT = 30;
const LABEL_MAX = 200;
const MESSAGE_MAX = 500;
const FILE_PATTERN = /^(\d{4}-\d\d-\d\d)\.jsonl$/;
const DAY_MS = 86_400_000;

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 4096) => typeof v === "string" && v.length > 0 && v.length <= max;
const opt = (v: unknown, max = 4096) => v === undefined || str(v, max);
const optInt = (v: unknown) => v === undefined || Number.isSafeInteger(v);
const iso = (v: unknown) => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));
const BASE = ["seq", "at", "kind"];

export function isActivityRow(v: unknown): v is ActivityRow {
  if (!object(v) || !Number.isSafeInteger(v.seq) || (v.seq as number) < 1 || !iso(v.at)) return false;
  switch (v.kind) {
    case ACTIVITY_KIND.SESSION_CREATED: case ACTIVITY_KIND.SESSION_LIVE:
      return only(v, [...BASE, "session", "sessionId", "cwd", "harness", "branch", "head", "state"]) && str(v.session, 256) && str(v.sessionId, 256)
        && str(v.cwd) && opt(v.harness, 64) && opt(v.branch, 256) && opt(v.head, 64) && opt(v.state, 64);
    case ACTIVITY_KIND.SESSION_STATE:
      return only(v, [...BASE, "session", "sessionId", "state", "label", "message", "inputKind"]) && str(v.session, 256) && opt(v.sessionId, 256)
        && str(v.state, 64) && typeof v.label === "string" && v.label.length <= LABEL_MAX && opt(v.message, MESSAGE_MAX) && opt(v.inputKind, 64);
    case ACTIVITY_KIND.SESSION_EXITED:
      return only(v, [...BASE, "session", "sessionId", "reason", "exitCode", "signal", "head"]) && opt(v.session, 256) && str(v.sessionId, 256)
        && str(v.reason, 64) && optInt(v.exitCode) && optInt(v.signal) && opt(v.head, 64);
    case ACTIVITY_KIND.TASK_UPDATED:
      return only(v, [...BASE, "taskId", "eventType"]) && str(v.taskId, 256) && str(v.eventType, 128);
    case ACTIVITY_KIND.INPUT:
      return only(v, [...BASE, "session", "sessionId", "source", "bucket"]) && str(v.session, 256) && opt(v.sessionId, 256)
        && Object.values(INPUT_SOURCE).includes(v.source as InputSource) && iso(v.bucket);
    default: return false;
  }
}

/** Bounded free text (labels, program messages) so one row stays one short line. */
function bounded(row: ActivityRow): ActivityRow {
  if (row.kind !== ACTIVITY_KIND.SESSION_STATE) return row;
  const out = { ...row, label: row.label.slice(0, LABEL_MAX) };
  if (row.message !== undefined) out.message = row.message.slice(0, MESSAGE_MAX);
  return out;
}
export function serializeActivityRow(row: ActivityRow): string { return JSON.stringify(bounded(row)) + "\n"; }

/**
 * Appends are buffered and never fsynced, so a crash can leave an unfinished
 * last line. Only newline-terminated lines count; the unfinished tail is
 * reported in bytes so the writer can truncate it before appending again.
 */
export function parseActivityLines(text: string): { rows: ActivityRow[]; partialTailBytes: number } {
  const end = text.lastIndexOf("\n") + 1;
  const rows: ActivityRow[] = [];
  for (const line of text.slice(0, end).split("\n")) {
    if (!line) continue;
    try { const value = JSON.parse(line) as unknown; if (isActivityRow(value)) rows.push(value); } catch { /* malformed line: skipped */ }
  }
  return { rows, partialTailBytes: Buffer.byteLength(text.slice(end)) };
}

export function activityFileDay(at: string): string { return new Date(at).toISOString().slice(0, 10); }
export function activityFileName(day: string): string { return `${day}.jsonl`; }
export function isActivityFileName(name: string): boolean { return FILE_PATTERN.test(name); }
export function presenceBucket(nowMs: number): string { return new Date(Math.floor(nowMs / PRESENCE_BUCKET_MS) * PRESENCE_BUCKET_MS).toISOString(); }

export interface ActivityPage { rows: ActivityRow[]; next: number; headSeq: number; oldestSeq: number | null; truncated: boolean }
/**
 * `rows` sorted by seq and covering every row after `since`; `oldestSeq` defaults to the first row.
 * `truncated` means retention dropped rows the cursor never saw.
 */
export function pageActivity(rows: readonly ActivityRow[], since: number, limit: number, oldestSeq: number | null = rows[0]?.seq ?? null): ActivityPage {
  const page = rows.filter(r => r.seq > since).slice(0, limit);
  return { rows: page, next: page.at(-1)?.seq ?? since, headSeq: rows.at(-1)?.seq ?? 0, oldestSeq, truncated: oldestSeq !== null && since < oldestSeq - 1 };
}

export type ParsedActivityQuery = { ok: true; since: number; limit: number } | { ok: false; error: string };
export function parseActivityQuery(params: URLSearchParams): ParsedActivityQuery {
  for (const key of params.keys()) if (key !== "since" && key !== "limit") return { ok: false, error: `unknown parameter: ${key}` };
  const int = (name: string, fallback: number, max: number) => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    const value = /^\d{1,16}$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(value) && value <= max ? value : undefined;
  };
  const since = int("since", 0, Number.MAX_SAFE_INTEGER);
  const limit = int("limit", ACTIVITY_PAGE_DEFAULT, ACTIVITY_PAGE_MAX);
  if (since === undefined) return { ok: false, error: "since must be a non-negative integer" };
  if (limit === undefined) return { ok: false, error: `limit must be an integer from 0 to ${ACTIVITY_PAGE_MAX}` };
  return { ok: true, since, limit };
}

/** Files whose UTC day is older than the window. The newest file always stays: it anchors `seq` recovery. */
export function expiredActivityFiles(names: readonly string[], today: string, retentionDays: number): string[] {
  const files = names.filter(isActivityFileName).sort();
  const cutoff = new Date(Date.parse(`${today}T00:00:00.000Z`) - retentionDays * DAY_MS).toISOString().slice(0, 10);
  return files.slice(0, -1).filter(name => name.slice(0, 10) < cutoff);
}
