import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, truncateSync, statSync } from "node:fs";
import { join } from "node:path";
import { ACTIVITY_RETENTION_DAYS_DEFAULT, activityFileDay, activityFileName, expiredActivityFiles, isActivityFileName } from "../activity-journal.js";
import { createLogger, errMsg } from "../log.js";
import { writePrivateFile } from "../persistence.js";
const log = createLogger("server");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
export const JOURNAL_FLUSH_MS = 1000;
export const JOURNAL_RETENTION_INTERVAL_MS = 60 * 60_000;
const BUFFER_MAX = 10_000;
export const JOURNAL_ID_FILE = "journal-id";
const JOURNAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface JournalStamp { seq: number; at: string }
export interface DayJournalOptions { dir: string; now?: () => number; flushMs?: number; retentionDays?: () => number }
export interface JournalStatus { journalId: string; headSeq: number; oldestSeq: number | null; lastRowAt: string | null }
export type JournalWindow = { from?: number; to?: number };
export interface JournalCodec<R> { parse(text: string): { rows: R[]; partialTailBytes: number }; serialize(row: R): string }
/** Shared local append-only storage; the codec, not this class, owns each journal's schema.
 * Buffered (no fsync), private day files, seq recovery, tail repair and retention.
 */
export class DayJournal<R extends JournalStamp, B> {
  readonly dir: string;
  private opened = false;
  private seq = 0;
  private oldestSeq: number | null = null;
  private lastRowAt: string | null = null;
  private journalId = "";
  private fileMaxSeq = new Map<string, number>();
  private buffer: R[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private retentionTimer?: ReturnType<typeof setInterval>;
  private retentionDays?: () => number;
  constructor(private readonly options: DayJournalOptions, private readonly codec: JournalCodec<R>) { this.dir = options.dir; }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private files(strict = false): string[] {
    try { return readdirSync(this.dir).filter(isActivityFileName).sort(); } catch (error) { if (strict && !missing(error)) throw error; return []; }
  }
  private readFile(name: string, strict = false): R[] {
    try { return this.codec.parse(readFileSync(join(this.dir, name), "utf8")).rows; } catch (error) { if (strict && !missing(error)) throw error; return []; }
  }
  protected open(): void {
    if (this.opened) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { this.journalId = this.readOrCreateId(); }
    catch (error) { log.warn("journal id unavailable; serving without one", { dir: this.dir, error: errMsg(error) }); }
    this.pruneFiles();
    const files = this.files();
    const newest = files.at(-1);
    if (newest) {
      const path = join(this.dir, newest);
      const { partialTailBytes } = this.codec.parse(readFileSync(path, "utf8"));
      if (partialTailBytes > 0) {
        truncateSync(path, statSync(path).size - partialTailBytes);
        log.warn("truncated unfinished journal row", { dir: this.dir, file: newest, bytes: partialTailBytes });
      }
    }
    for (const name of files) for (const row of this.readFile(name)) this.observe(row);
    this.opened = true;
  }
  private readOrCreateId(): string {
    const path = join(this.dir, JOURNAL_ID_FILE);
    const read = () => { try { return readFileSync(path, "utf8").trim(); } catch (error) { if (missing(error)) return ""; throw error; } };
    const existing = read();
    if (JOURNAL_ID.test(existing)) return existing;
    writePrivateFile(path, `${randomUUID()}\n`);
    const created = read();
    if (!JOURNAL_ID.test(created)) throw new Error("journal id did not persist");
    return created;
  }
  protected observe(row: R): void {
    if (row.seq > this.seq) { this.seq = row.seq; this.lastRowAt = row.at; }
    this.oldestSeq ??= row.seq;
    const file = activityFileName(activityFileDay(row.at));
    this.fileMaxSeq.set(file, Math.max(this.fileMaxSeq.get(file) ?? 0, row.seq));
  }
  /** Caller-provided event time is useful for delayed browser batches; seq stays server-owned. */
  append(body: B, at = new Date(this.now()).toISOString()): R {
    this.open();
    const row = { ...body, seq: this.seq + 1, at } as unknown as R;
    this.observe(row);
    this.buffer.push(row);
    if (this.buffer.length > BUFFER_MAX) {
      const dropped = this.buffer.splice(0, this.buffer.length - BUFFER_MAX);
      log.warn("journal buffer overflow; oldest rows dropped", { dir: this.dir, dropped: dropped.length });
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flush(); }, this.options.flushMs ?? JOURNAL_FLUSH_MS);
      this.flushTimer.unref?.();
    }
    return row;
  }
  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (this.buffer.length === 0) return;
    const byFile = new Map<string, R[]>();
    for (const row of this.buffer) {
      const name = activityFileName(activityFileDay(row.at));
      byFile.set(name, [...(byFile.get(name) ?? []), row]);
    }
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      for (const [name, rows] of byFile) {
        // A clock step or delayed batch can return to an older day file after a crash.
        const path = join(this.dir, name);
        try {
          const { partialTailBytes } = this.codec.parse(readFileSync(path, "utf8"));
          if (partialTailBytes) truncateSync(path, statSync(path).size - partialTailBytes);
        } catch (error) { if (!missing(error)) throw error; }
        appendFileSync(path, rows.map(row => this.codec.serialize(row)).join(""), { mode: 0o600 });
        const written = new Set(rows);
        this.buffer = this.buffer.filter(row => !written.has(row));
      }
    } catch (error) { log.warn("journal flush failed; rows kept in memory", { dir: this.dir, error: errMsg(error), rows: this.buffer.length }); }
  }
  protected journalStatus(): JournalStatus { this.open(); return { journalId: this.journalId, headSeq: this.seq, oldestSeq: this.oldestSeq, lastRowAt: this.lastRowAt }; }
  private filesIn(window: JournalWindow, strict = false): string[] {
    const first = window.from === undefined ? "" : activityFileName(activityFileDay(new Date(window.from).toISOString()));
    const last = window.to === undefined ? "~" : activityFileName(activityFileDay(new Date(window.to - 1).toISOString()));
    return this.files(strict).filter(name => name >= first && name <= last);
  }
  private rowsIn(names: readonly string[], window: JournalWindow, strict = false): R[] {
    return names.flatMap(name => this.readFile(name, strict)).filter(row => {
      const at = Date.parse(row.at); return (window.from === undefined || at >= window.from) && (window.to === undefined || at < window.to);
    }).sort((a, b) => a.seq - b.seq);
  }
  read(since: number, limit: number, window: JournalWindow = {}): { rows: R[]; next: number; headSeq: number; oldestSeq: number | null; truncated: boolean } {
    this.open(); this.flush();
    if (limit > 0 && this.buffer.some(row => row.seq > since)) throw new Error("journal rows are not on disk yet (storage unavailable)");
    const names = limit > 0 ? this.filesIn(window, true).filter(name => (this.fileMaxSeq.get(name) ?? Infinity) > since) : [];
    const rows = this.rowsIn(names, window, true).filter(row => row.seq > since).slice(0, limit);
    const oldestFile = this.files()[0];
    const oldestDayStart = oldestFile ? Date.parse(`${oldestFile.slice(0, 10)}T00:00:00.000Z`) : -Infinity;
    const truncated = this.oldestSeq !== null && since < this.oldestSeq - 1 && (window.from === undefined || window.from < oldestDayStart);
    return { rows, next: rows.at(-1)?.seq ?? since, headSeq: this.seq, oldestSeq: this.oldestSeq, truncated };
  }
  readAll(window: JournalWindow = {}): R[] { this.open(); this.flush(); return this.rowsIn(this.filesIn(window), window); }
  private pruneFiles(): void {
    const days = (this.retentionDays ?? this.options.retentionDays)?.() ?? ACTIVITY_RETENTION_DAYS_DEFAULT;
    const expired = expiredActivityFiles(this.files(), new Date(this.now()).toISOString().slice(0, 10), days);
    for (const name of expired) { rmSync(join(this.dir, name), { force: true }); this.fileMaxSeq.delete(name); }
    if (expired.length) log.info("journal retention pruned files", { dir: this.dir, files: expired.length, days });
  }
  prune(): void {
    this.open(); this.flush(); this.pruneFiles();
    const first = this.files()[0];
    this.oldestSeq = first ? this.readFile(first)[0]?.seq ?? null : null;
  }
  startRetention(intervalMs = JOURNAL_RETENTION_INTERVAL_MS, retentionDays?: () => number): void {
    if (this.retentionTimer) return;
    if (retentionDays) this.retentionDays = retentionDays;
    const run = () => { try { this.prune(); } catch (error) { log.warn("journal retention failed", { dir: this.dir, error: errMsg(error) }); } };
    run(); this.retentionTimer = setInterval(run, intervalMs); this.retentionTimer.unref?.();
  }
  close(): void { clearInterval(this.retentionTimer); this.retentionTimer = undefined; this.flush(); }
}
