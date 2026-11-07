import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ACTIVITY_PAGE_MAX, ACTIVITY_PATH, activeCwds, type ActivityPage, type ActivityRow } from "../activity-journal.js";
import {
  InvalidInboxFile, applyAck, buildInbox, dayNoteMarkdown, emptyCoverage, inboxFileName, inboxPrompt, isFocusCoverage, isInboxFileName, withoutAssistantRows,
  type FocusCoverage, type GitRepoLog, type InboxMachine, type MachineCursor,
} from "../focus-coverage.js";
import {
  ASSISTANT_TIMING_DEFAULTS, ROUTINE, STALE_AFTER_MS, activityDayOf, addDays, activityDayWindow, decideRoutines,
  type AssistantTiming, type RoutineAction, type SchedulerMachine,
} from "../focus-scheduler.js";
import type { SendOutcome } from "../focus-send-queue.js";
import { readValidatedJsonFile, writePrivateFile, writePrivateJsonFile } from "../persistence.js";
import type { ActivityJournal, ActivityJournalStatus } from "./activity-journal.js";
import type { ActivityPeer } from "./activity-peers.js";
import { readGitLogs } from "./activity-recorder.js";
import { createLogger, errMsg } from "../log.js";

const log = createLogger("server");
export const ROUTINE_TICK_MS = 60_000;
const CATCH_UP_ROW_CAP = 2000;
const REVIEW_ROW_CAP = 5000;
type Page = ActivityPage & Pick<ActivityJournalStatus, "lastRowAt" | "lastInputAt">;
type GitRepos = { repos: { cwd: string; commits: GitRepoLog["commits"]; error?: string }[] };

/** One machine's journal: this server's own (direct) or a verified peer's `/api/activity`. */
export interface ActivitySource {
  id: string;
  name: string;
  local: boolean;
  read(since: number, limit: number, window?: { from: number; to: number }): Promise<Page>;
  git(from: number, to: number): Promise<GitRepos>;
}
export function localActivitySource(id: string, name: string, journal: ActivityJournal): ActivitySource {
  return {
    id, name, local: true,
    read: async (since, limit, window) => ({ ...journal.read(since, limit, window ?? {}), ...journal.status() }),
    git: async (from, to) => ({ repos: await readGitLogs(activeCwds(journal.readAll(), from, to), from, to) }),
  };
}
export function peerActivitySource(peer: ActivityPeer): ActivitySource {
  const query = (since: number, limit: number, window?: { from: number; to: number }) =>
    `?since=${since}&limit=${limit}${window ? `&from=${new Date(window.from).toISOString()}&to=${new Date(window.to).toISOString()}` : ""}`;
  return {
    id: peer.installationId, name: peer.name, local: false,
    read: (since, limit, window) => peer.get<Page>(`${ACTIVITY_PATH}${query(since, limit, window)}`, 2 * 1024 * 1024),
    git: (from, to) => peer.get<GitRepos>(`${ACTIVITY_PATH}/git${query(0, 0, { from, to })}`, 1024 * 1024),
  };
}

export interface RoutineDeps {
  folder: string;
  enabled: () => boolean;
  sources: () => Promise<ActivitySource[]>;
  timing: () => Promise<AssistantTiming>;
  /** Assistant incarnation and whether its harness is resting. */
  assistant: () => Promise<{ sessionId?: string; idle: boolean }>;
  queueBusy: () => boolean;
  enqueue: (text: string, settled: (outcome: SendOutcome) => void) => void;
  now?: () => number;
}

export interface RoutineStatus {
  reviewedThrough: string | null;
  lastAckAt: string | null;
  catchingUp: { machines: number; since: string | null; routine?: string } | null;
  stale: { since: string } | null;
  unreachable: { name: string; since: string | null }[];
  surfaced: { file: string; sends: number } | null;
  /** The last completed activity day and whether its note exists. */
  yesterday: { date: string; note: boolean };
  notice?: string;
  error?: string;
}

/**
 * Home-server routines: the server pulls deltas, writes the inbox (rows
 * labelled untrusted), sends one `process inbox <file>` through the existing
 * queue and advances cursors only on ack. Coverage lives in the assistant folder.
 */
export class FocusRoutines {
  readonly path: string;
  private booting = true;
  private restartPending = false;
  private lastSessionId?: string;
  private queuedFile?: string;
  private reached = new Set<string>();
  private snapshot: FocusCoverage = emptyCoverage();
  private pending = false;
  private notice?: string;
  private error?: string;
  private probed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private queuedTick?: Promise<void>;
  private manualRequested = false;
  private fallbackTime = ASSISTANT_TIMING_DEFAULTS.fallbackTime;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: RoutineDeps) {
    this.path = join(deps.folder, "routines.json");
    try { this.snapshot = this.read(); } catch (error) { this.error = errMsg(error); }
  }
  /** Ticks, acks and send bookkeeping are serialized: each is a read-modify-write of routines.json. */
  private exclusive<T>(work: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private iso(): string { return new Date(this.now()).toISOString(); }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, ROUTINE_TICK_MS);
    this.timer.unref?.();
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }

  private read(): FocusCoverage { return readValidatedJsonFile(this.path, "routines", isFocusCoverage) ?? emptyCoverage(); }
  private save(coverage: FocusCoverage): void { writePrivateJsonFile(this.path, coverage); this.snapshot = coverage; }

  /** At most one tick waits behind the running one; a manual request rides on it. */
  tick(trigger: { manual?: boolean } = {}): Promise<void> {
    if (trigger.manual) this.manualRequested = true;
    return this.queuedTick ??= this.exclusive(async () => {
      this.queuedTick = undefined;
      try { await this.run(); } catch (error) { this.error = errMsg(error); log.warn("focus routine tick failed", { error: this.error }); }
    });
  }

  private async run(): Promise<void> {
    const manual = this.manualRequested;
    this.manualRequested = false;
    if (!this.deps.enabled()) return;
    let coverage: FocusCoverage;
    try { coverage = this.read(); this.error = undefined; } catch (error) { this.error = errMsg(error); return; }
    if (manual) this.notice = undefined;
    const now = this.now();
    const timing = await this.deps.timing();
    this.fallbackTime = timing.fallbackTime;
    const sources = await this.deps.sources();
    this.reached.clear();
    await Promise.all(sources.map(source => this.probe(coverage, source, timing)));
    this.probed = true;
    const sample = await this.deps.assistant();
    if (sample.sessionId && sample.sessionId !== this.lastSessionId) { this.lastSessionId = sample.sessionId; this.restartPending = true; }
    const idle = sample.idle && !this.deps.queueBusy();
    const machines: SchedulerMachine[] = Object.entries(coverage.catchUpCursors).map(([id, c]) => ({
      id, reachable: this.reached.has(id), pendingRows: c.headSeq > c.seq, lastRowAt: c.lastRowAt, lastInputAt: c.lastInputAt,
    }));
    this.pending = machines.some(m => m.pendingRows);
    const inbox = coverage.inbox && { ...coverage.inbox, queued: this.queuedFile === coverage.inbox.file };
    const actions = decideRoutines({ now, timing, enabled: true, idle, booting: this.booting, restarted: this.restartPending, manual, machines,
      reviewedThrough: coverage.reviewedThrough, lastRun: coverage.lastRun, inbox });
    if (!actions.length && this.booting && idle && !coverage.inbox) this.booting = false;
    for (const action of actions) coverage = await this.execute(action, coverage, sources, timing, manual);
    this.save(coverage);
  }

  /** Heads and last input per machine; a replaced journal (head behind the cursor) restarts that cursor. */
  private async probe(coverage: FocusCoverage, source: ActivitySource, timing: AssistantTiming): Promise<void> {
    try {
      const status = await source.read(0, 0);
      let cursor: MachineCursor | undefined = coverage.catchUpCursors[source.id];
      if (cursor && status.headSeq < cursor.seq) { log.warn("activity journal replaced; cursor restarted", { machine: source.name }); cursor = undefined; }
      if (!cursor) {
        // First contact: catch-ups start at today's first row; earlier days belong to reviews.
        const today = activityDayWindow(activityDayOf(this.now(), timing.fallbackTime), timing.fallbackTime);
        const first = (await source.read(0, 1, { from: today.start, to: today.end })).rows[0];
        cursor = { name: source.name, seq: first ? first.seq - 1 : status.headSeq, headSeq: status.headSeq, lastReachedAt: null, lastRowAt: null, lastInputAt: null };
      }
      coverage.catchUpCursors[source.id] = { ...cursor, name: source.name, headSeq: status.headSeq, lastReachedAt: this.iso(), lastRowAt: status.lastRowAt, lastInputAt: status.lastInputAt };
      this.reached.add(source.id);
    } catch (error) { log.debug("activity source unreachable", { machine: source.name, error: errMsg(error) }); }
  }

  private async pull(source: ActivitySource, since: number, cap: number, window?: { from: number; to: number }): Promise<{ rows: ActivityRow[]; through: number; truncated: boolean }> {
    const rows: ActivityRow[] = [];
    let cursor = since, truncated = false;
    for (;;) {
      const page = await source.read(cursor, Math.min(ACTIVITY_PAGE_MAX, cap - rows.length), window);
      truncated ||= page.truncated;
      rows.push(...(source.local ? withoutAssistantRows(page.rows) : page.rows));
      // Filtered rows still advance the cursor: they carried nothing for the assistant.
      cursor = page.next;
      if (page.rows.length < ACTIVITY_PAGE_MAX || rows.length >= cap || cursor >= page.headSeq) break;
    }
    return { rows, through: cursor, truncated };
  }

  private unreachedBlocks(coverage: FocusCoverage): InboxMachine[] {
    return Object.entries(coverage.catchUpCursors).filter(([id]) => !this.reached.has(id))
      .map(([installationId, c]) => ({ installationId, name: c.name, reached: false as const, lastReachedAt: c.lastReachedAt }));
  }

  private send(file: string): void {
    this.queuedFile = file;
    try {
      this.deps.enqueue(inboxPrompt(file), outcome => {
        if (this.queuedFile === file) this.queuedFile = undefined;
        // A failed send may still have reached the terminal (unverified submission), so it
        // counts toward the re-send cap and the debounce; only a never-attempted (dropped) send is free.
        if (outcome === "dropped") return;
        const sentAt = this.iso();
        void this.exclusive(() => {
          const current = this.read();
          if (current.inbox?.file !== file) return;
          this.save({ ...current, inbox: { ...current.inbox, sends: current.inbox.sends + 1, lastSentAt: sentAt } });
        }).catch(error => { log.warn("routine send bookkeeping failed", { error: errMsg(error) }); });
      });
    } catch (error) { this.queuedFile = undefined; log.warn("routine send not queued", { file, error: errMsg(error) }); }
  }

  private writeInbox(coverage: FocusCoverage, routine: typeof ROUTINE[keyof typeof ROUTINE], doc: Omit<Parameters<typeof buildInbox>[0], "file" | "routine" | "createdAt">,
    through: Record<string, number>, days?: string[]): FocusCoverage {
    const createdAt = this.iso();
    const file = inboxFileName(routine, this.now());
    mkdirSync(join(this.deps.folder, "inbox"), { recursive: true, mode: 0o700 });
    writePrivateJsonFile(join(this.deps.folder, "inbox", file), buildInbox({ file, routine, createdAt, ...doc }));
    const next: FocusCoverage = { ...coverage, lastRun: { ...coverage.lastRun, [routine]: createdAt },
      inbox: { file, routine, createdAt, sends: 0, lastSentAt: null, surfaced: false, through, ...(days && { days }) } };
    this.save(next);
    this.send(file);
    return next;
  }

  private async execute(action: RoutineAction, coverage: FocusCoverage, sources: ActivitySource[], timing: AssistantTiming, manual: boolean): Promise<FocusCoverage> {
    const reachable = sources.filter(s => this.reached.has(s.id));
    switch (action.type) {
      case "drop-inbox":
        rmSync(join(this.deps.folder, "inbox", action.file), { force: true });
        return { ...coverage, inbox: null };
      case "surface":
        return coverage.inbox ? { ...coverage, inbox: { ...coverage.inbox, surfaced: true } } : coverage;
      case "resend":
        this.send(action.file);
        return coverage;
      case ROUTINE.CATCH_UP: {
        this.booting = false;
        this.restartPending = false;
        const blocks: InboxMachine[] = [];
        const through: Record<string, number> = {};
        for (const source of reachable) {
          const cursor = coverage.catchUpCursors[source.id]!;
          const pulled = await this.pull(source, cursor.seq, CATCH_UP_ROW_CAP);
          through[source.id] = pulled.through;
          if (pulled.rows.length) blocks.push({ installationId: source.id, name: source.name, reached: true, from: cursor.seq, through: pulled.through, truncated: pulled.truncated, rows: pulled.rows });
        }
        if (!blocks.length) {
          for (const [id, seq] of Object.entries(through)) coverage.catchUpCursors[id] = { ...coverage.catchUpCursors[id]!, seq: Math.max(coverage.catchUpCursors[id]!.seq, seq) };
          if (manual) this.notice = "nothing new to catch up on";
          return coverage;
        }
        return this.writeInbox(coverage, ROUTINE.CATCH_UP, { machines: [...blocks, ...this.unreachedBlocks(coverage)] }, through);
      }
      case ROUTINE.DAY_REVIEW: case ROUTINE.GAP_REVIEW: {
        const windows = action.days.map(date => ({ date, ...activityDayWindow(date, timing.fallbackTime) }));
        const span = { from: windows[0]!.start, to: windows.at(-1)!.end };
        const perMachine = await Promise.all(reachable.map(async source => ({ source, ...(await this.pull(source, 0, REVIEW_ROW_CAP, span)) })));
        const active = windows.filter(w => perMachine.some(m => m.rows.some(r => activityDayOf(Date.parse(r.at), timing.fallbackTime) === w.date)));
        if (!active.length) {
          const reviewed = action.days.at(-1)!;
          return { ...coverage, reviewedThrough: !coverage.reviewedThrough || reviewed > coverage.reviewedThrough ? reviewed : coverage.reviewedThrough, lastRun: { ...coverage.lastRun, [action.type]: this.iso() } };
        }
        mkdirSync(join(this.deps.folder, "days"), { recursive: true, mode: 0o700 });
        for (const window of active) {
          const note = join(this.deps.folder, "days", `${window.date}.md`);
          if (existsSync(note)) continue;
          const dayRows = perMachine.map(m => ({ name: m.source.name, rows: m.rows.filter(r => activityDayOf(Date.parse(r.at), timing.fallbackTime) === window.date) })).filter(m => m.rows.length);
          const git: GitRepoLog[] = (await Promise.all(perMachine.map(async m => {
            try { return (await m.source.git(window.start, window.end)).repos.map(repo => ({ machine: m.source.name, ...repo })); }
            catch (error) { return [{ machine: m.source.name, cwd: "(all repositories)", commits: [], error: errMsg(error) }]; }
          }))).flat();
          writePrivateFile(note, dayNoteMarkdown(window.date, window, dayRows, git));
        }
        const through: Record<string, number> = {};
        for (const m of perMachine) if (m.rows.length) through[m.source.id] = Math.max(...m.rows.map(r => r.seq));
        return this.writeInbox(coverage, action.type, {
          days: active.map(w => ({ date: w.date, note: `days/${w.date}.md`, from: new Date(w.start).toISOString(), to: new Date(w.end).toISOString() })),
          machines: [...perMachine.filter(m => m.rows.length).map(m => ({ installationId: m.source.id, name: m.source.name, reached: true as const, from: 0, through: through[m.source.id]!, truncated: m.truncated, rows: m.rows })), ...this.unreachedBlocks(coverage)],
        }, through, action.days);
      }
    }
  }

  /** `wolfpack activity ack <file>`: the only path that advances cursors and review coverage. */
  ack(file: string): Promise<{ ok: true; already: boolean }> {
    const name = file.split("/").at(-1) ?? "";
    if (!isInboxFileName(name)) return Promise.reject(new InvalidInboxFile());
    return this.exclusive(() => {
      const result = applyAck(this.read(), name, this.iso());
      if (!result.already) {
        this.save(result.coverage);
        rmSync(join(this.deps.folder, "inbox", name), { force: true });
        if (this.queuedFile === name) this.queuedFile = undefined;
      }
      return { ok: true as const, already: result.already };
    });
  }

  dayNote(date: string): string | null {
    if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw new Error("date must be YYYY-MM-DD");
    try { return readFileSync(join(this.deps.folder, "days", `${date}.md`), "utf8"); } catch { return null; }
  }

  /** Render-ready routine state for `/api/focus`. */
  status(): RoutineStatus {
    const c = this.snapshot;
    const inbox = c.inbox;
    const catchingUp = this.deps.enabled() && (this.booting || (inbox && !inbox.surfaced))
      ? { machines: Math.max(1, Object.keys(c.catchUpCursors).length), since: c.lastAckAt, ...(inbox && { routine: inbox.routine }) } : null;
    const yesterday = addDays(activityDayOf(this.now(), this.fallbackTime), -1);
    const stale = !catchingUp && this.pending && c.lastAckAt && this.now() - Date.parse(c.lastAckAt) > STALE_AFTER_MS ? { since: c.lastAckAt } : null;
    return {
      reviewedThrough: c.reviewedThrough, lastAckAt: c.lastAckAt, catchingUp, stale,
      unreachable: this.probed ? Object.entries(c.catchUpCursors).filter(([id]) => !this.reached.has(id)).map(([, m]) => ({ name: m.name, since: m.lastReachedAt })) : [],
      surfaced: inbox?.surfaced ? { file: inbox.file, sends: inbox.sends } : null,
      yesterday: { date: yesterday, note: existsSync(join(this.deps.folder, "days", `${yesterday}.md`)) },
      ...(this.notice && { notice: this.notice }), ...(this.error && { error: this.error }),
    };
  }
}
