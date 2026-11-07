import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, truncateSync, statSync } from "node:fs";
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

export interface ActivityJournalStatus { headSeq: number; oldestSeq: number | null; lastRowAt: string | null; lastInputAt: string | null }
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

  private observe(row: ActivityRow): void {
    if (row.seq > this.seq) { this.seq = row.seq; this.lastRowAt = row.at; }
    this.oldestSeq ??= row.seq;
    if (row.kind === ACTIVITY_KIND.INPUT && (!this.lastInputAt || row.at > this.lastInputAt)) this.lastInputAt = row.at;
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
    const byFile = new Map<string, string>();
    for (const row of this.buffer) {
      const name = activityFileName(activityFileDay(row.at));
      byFile.set(name, (byFile.get(name) ?? "") + serializeActivityRow(row));
    }
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      for (const [name, text] of byFile) appendFileSync(join(this.dir, name), text, { mode: 0o600 });
      this.buffer = [];
    } catch (error) {
      log.warn("activity flush failed; rows kept in memory", { error: errMsg(error), rows: this.buffer.length });
    }
  }

  status(): ActivityJournalStatus {
    this.open();
    return { headSeq: this.seq, oldestSeq: this.oldestSeq, lastRowAt: this.lastRowAt, lastInputAt: this.lastInputAt };
  }

  /**
   * Reads newest files backwards only until the cursor is covered. A time
   * window (`from`/`to`, epoch ms) restricts both the files read and the rows.
   */
  read(since: number, limit: number, window: { from?: number; to?: number } = {}): ActivityPage {
    this.open();
    this.flush();
    const chunks: ActivityRow[][] = [];
    const first = window.from === undefined ? "" : activityFileName(activityFileDay(new Date(window.from).toISOString()));
    const last = window.to === undefined ? "~" : activityFileName(activityFileDay(new Date(window.to - 1).toISOString()));
    if (limit > 0) {
      for (const name of this.files().reverse()) {
        if (name > last) continue;
        if (name < first) break;
        const rows = this.readFile(name);
        chunks.unshift(rows);
        if (rows.length && rows[0]!.seq <= since + 1) break;
      }
    }
    const inWindow = (row: ActivityRow) => { const at = Date.parse(row.at); return (window.from === undefined || at >= window.from) && (window.to === undefined || at < window.to); };
    const page = pageActivity(chunks.flat().filter(inWindow), since, limit, this.oldestSeq);
    return { ...page, headSeq: this.seq };
  }

  /** Every retained row; for infrequent day-review work such as resolving session cwds. */
  readAll(): ActivityRow[] { this.open(); this.flush(); return this.files().flatMap(name => this.readFile(name)); }

  private pruneFiles(): void {
    const days = (this.retentionDays ?? this.options.retentionDays)?.() ?? ACTIVITY_RETENTION_DAYS_DEFAULT;
    const expired = expiredActivityFiles(this.files(), new Date(this.now()).toISOString().slice(0, 10), days);
    for (const name of expired) rmSync(join(this.dir, name), { force: true });
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
