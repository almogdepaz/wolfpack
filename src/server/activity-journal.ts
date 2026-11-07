import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, truncateSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVITY_KIND,
  ACTIVITY_RETENTION_DAYS_DEFAULT,
  activityFileDay,
  activityFileName,
  expiredActivityFiles,
  isActivityFileName,
  pageActivity,
  parseActivityLines,
  serializeActivityRow,
  type ActivityPage,
  type ActivityRow,
  type ActivityRowBody,
} from "../activity-journal.js";
import { createLogger, errMsg } from "../log.js";
import { resolveWolfpackDir } from "../wolfpack-dir.js";

const log = createLogger("server");
export const ACTIVITY_FLUSH_MS = 1000;
export const ACTIVITY_RETENTION_INTERVAL_MS = 60 * 60_000;
/** Rows held while the disk refuses writes; beyond this the oldest are dropped with a warning. */
const BUFFER_MAX = 10_000;

/** Name of the file holding this journal's random identity; a new id means a new seq space. */
export const ACTIVITY_JOURNAL_ID_FILE = "journal-id";
export interface ActivityJournalStatus { journalId: string; headSeq: number; oldestSeq: number | null; lastRowAt: string | null; lastInputAt: string | null }
type Window = { from?: number; to?: number };
export interface ActivityJournalOptions {
  dir?: string;
  now?: () => number;
  flushMs?: number;
  retentionDays?: () => number;
}

/**
 * Buffered, append-only writer for this machine's journal. No per-row fsync
 * (a crash loses at most the unflushed buffer and leaves a partial line that
 * open() truncates). `seq` continues from the newest file across restarts.
 */
export class ActivityJournal {
  readonly dir: string;
  private opened = false;
  private seq = 0;
  private oldestSeq: number | null = null;
  private lastRowAt: string | null = null;
  private lastInputAt: string | null = null;
  private journalId = "";
  /** Newest input time per session, so the quiet gate can ignore the assistant's own typing. */
  private lastInputBySession = new Map<string, string>();
  /** Highest seq per day file: a read skips files with nothing after its cursor, in any file order. */
  private fileMaxSeq = new Map<string, number>();
  private buffer: ActivityRow[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private retentionTimer?: ReturnType<typeof setInterval>;
  private retentionDays?: () => number;

  constructor(private readonly options: ActivityJournalOptions = {}) {
    this.dir = options.dir ?? join(resolveWolfpackDir(), "activity");
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private files(): string[] { try { return readdirSync(this.dir).filter(isActivityFileName).sort(); } catch { return []; } }
  private readFile(name: string): ActivityRow[] {
    try { return parseActivityLines(readFileSync(join(this.dir, name), "utf8")).rows; } catch { return []; }
  }

  private open(): void {
    if (this.opened) return;
    this.opened = true;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.journalId = this.readOrCreateId();
    this.pruneFiles();
    const files = this.files();
    const newest = files.at(-1);
    if (newest) {
      const path = join(this.dir, newest);
      const text = readFileSync(path, "utf8");
      const { partialTailBytes } = parseActivityLines(text);
      // Never append after an unfinished line: it would merge two rows into one malformed line.
      if (partialTailBytes > 0) {
        truncateSync(path, statSync(path).size - partialTailBytes);
        log.warn("truncated unfinished activity row", { file: newest, bytes: partialTailBytes });
      }
    }
    for (const name of files) {
      for (const row of this.readFile(name)) this.observe(row);
    }
  }

  private readOrCreateId(): string {
    const path = join(this.dir, ACTIVITY_JOURNAL_ID_FILE);
    try {
      writeFileSync(path, randomUUID(), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return readFileSync(path, "utf8").trim();
  }

  private observe(row: ActivityRow): void {
    if (row.seq > this.seq) { this.seq = row.seq; this.lastRowAt = row.at; }
    this.oldestSeq ??= row.seq;
    const file = activityFileName(activityFileDay(row.at));
    this.fileMaxSeq.set(file, Math.max(this.fileMaxSeq.get(file) ?? 0, row.seq));
    if (row.kind !== ACTIVITY_KIND.INPUT) return;
    if (!this.lastInputAt || row.at > this.lastInputAt) this.lastInputAt = row.at;
    const last = this.lastInputBySession.get(row.session);
    if (!last || row.at > last) this.lastInputBySession.set(row.session, row.at);
  }

  append(body: ActivityRowBody): ActivityRow {
    this.open();
    const row = { ...body, seq: this.seq + 1, at: new Date(this.now()).toISOString() } as ActivityRow;
    this.observe(row);
    this.buffer.push(row);
    if (this.buffer.length > BUFFER_MAX) {
      const dropped = this.buffer.splice(0, this.buffer.length - BUFFER_MAX);
      log.warn("activity buffer overflow; oldest rows dropped", { dropped: dropped.length });
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flush(); }, this.options.flushMs ?? ACTIVITY_FLUSH_MS);
      this.flushTimer.unref?.();
    }
    return row;
  }

  /** Synchronous so SIGTERM handling can call it before the process exits. */
  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (this.buffer.length === 0) return;
    const byFile = new Map<string, ActivityRow[]>();
    for (const row of this.buffer) {
      const name = activityFileName(activityFileDay(row.at));
      byFile.set(name, [...(byFile.get(name) ?? []), row]);
    }
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      for (const [name, rows] of byFile) {
        appendFileSync(join(this.dir, name), rows.map(serializeActivityRow).join(""), { mode: 0o600 });
        // Drop each file's rows as soon as they are on disk: a later file failing must not re-append them.
        const written = new Set(rows);
        this.buffer = this.buffer.filter(row => !written.has(row));
      }
    } catch (error) {
      log.warn("activity flush failed; rows kept in memory", { error: errMsg(error), rows: this.buffer.length });
    }
  }

  /** `exceptSession` leaves one session's input out of `lastInputAt` (the assistant's own typing). */
  status(options: { exceptSession?: string } = {}): ActivityJournalStatus {
    this.open();
    let lastInputAt = this.lastInputAt;
    if (options.exceptSession !== undefined) {
      lastInputAt = null;
      for (const [session, at] of this.lastInputBySession) if (session !== options.exceptSession && (!lastInputAt || at > lastInputAt)) lastInputAt = at;
    }
    return { journalId: this.journalId, headSeq: this.seq, oldestSeq: this.oldestSeq, lastRowAt: this.lastRowAt, lastInputAt };
  }

  /** Day files that can hold rows of the window, oldest first. */
  private filesIn(window: Window): string[] {
    const first = window.from === undefined ? "" : activityFileName(activityFileDay(new Date(window.from).toISOString()));
    const last = window.to === undefined ? "~" : activityFileName(activityFileDay(new Date(window.to - 1).toISOString()));
    return this.files().filter(name => name >= first && name <= last);
  }

  private rowsIn(names: readonly string[], window: Window): ActivityRow[] {
    const inWindow = (row: ActivityRow) => { const at = Date.parse(row.at); return (window.from === undefined || at >= window.from) && (window.to === undefined || at < window.to); };
    // A clock step can put a higher seq in an earlier-named file; pages are by seq.
    return names.flatMap(name => this.readFile(name)).filter(inWindow).sort((a, b) => a.seq - b.seq);
  }

  /**
   * Reads only the files holding rows after the cursor. A time window
   * (`from`/`to`, epoch ms) restricts both the files read and the rows, and
   * then `truncated` means retention removed rows inside that window.
   */
  read(since: number, limit: number, window: Window = {}): ActivityPage {
    this.open();
    this.flush();
    const names = limit > 0 ? this.filesIn(window).filter(name => (this.fileMaxSeq.get(name) ?? Infinity) > since) : [];
    const page = pageActivity(this.rowsIn(names, window), since, limit, this.oldestSeq);
    const oldestFile = this.files()[0];
    const oldestDayStart = oldestFile ? Date.parse(`${oldestFile.slice(0, 10)}T00:00:00.000Z`) : -Infinity;
    const truncated = page.truncated && (window.from === undefined || window.from < oldestDayStart);
    return { ...page, headSeq: this.seq, truncated };
  }

  /** Retained rows, optionally bounded by a window; for infrequent day-review work such as resolving session cwds. */
  readAll(window: Window = {}): ActivityRow[] { this.open(); this.flush(); return this.rowsIn(this.filesIn(window), window); }

  private pruneFiles(): void {
    const days = (this.retentionDays ?? this.options.retentionDays)?.() ?? ACTIVITY_RETENTION_DAYS_DEFAULT;
    const expired = expiredActivityFiles(this.files(), new Date(this.now()).toISOString().slice(0, 10), days);
    for (const name of expired) { rmSync(join(this.dir, name), { force: true }); this.fileMaxSeq.delete(name); }
    if (expired.length) log.info("activity retention pruned files", { files: expired.length, days });
  }

  prune(): void {
    this.open();
    this.flush();
    this.pruneFiles();
    const first = this.files()[0];
    this.oldestSeq = first ? this.readFile(first)[0]?.seq ?? null : null;
  }

  /** Same shape as the log-rotation monitor: unref'd interval, errors logged, never thrown. */
  startRetention(intervalMs = ACTIVITY_RETENTION_INTERVAL_MS, retentionDays?: () => number): void {
    if (this.retentionTimer) return;
    if (retentionDays) this.retentionDays = retentionDays;
    const run = () => { try { this.prune(); } catch (error) { log.warn("activity retention failed", { error: errMsg(error) }); } };
    run();
    this.retentionTimer = setInterval(run, intervalMs);
    this.retentionTimer.unref?.();
  }

  close(): void {
    clearInterval(this.retentionTimer);
    this.retentionTimer = undefined;
    this.flush();
  }
}
