import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVITY_KIND, ACTIVITY_PAGE_MAX, ACTIVITY_PATH, activeCwds, parseActivityGit, parseActivityPage, type ActivityGitRepo, type ActivityPeerPage, type ActivityRow,
} from "../activity-journal.js";
import {
  ASSISTANT_SESSION_NAME, InvalidInboxFile, applyAck, buildInbox, dayNoteMarkdown, dayNoteUpdateMarkdown, emptyCoverage, inboxFileName, inboxPrompt, isFocusCoverage,
  isInboxFileName, isNeedsInputSnapshot, settledProvisional, withoutAssistantRows,
  type FocusCoverage, type GitRepoLog, type InboxDay, type InboxMachine, type MachineCursor,
} from "../focus-coverage.js";
import {
  ASSISTANT_TIMING_DEFAULTS, ROUTINE, STALE_AFTER_MS, activityDayOf, addDays, activityDayWindow, decideRoutines, pendingNeedsInput,
  type AssistantTiming, type RoutineAction, type SchedulerMachine, type NeedsInputSnapshot,
} from "../focus-scheduler.js";
import type { SendOutcome } from "../focus-send-queue.js";
import { readValidatedJsonFile, writePrivateFile, writePrivateJsonFile } from "../persistence.js";
import type { ActivityJournal } from "./activity-journal.js";
import type { ActivityPeer } from "./activity-peers.js";
import { readGitLogs } from "./activity-recorder.js";
import { createLogger, errMsg } from "../log.js";

const log = createLogger("server");
export const ROUTINE_TICK_MS = 60_000;
const CATCH_UP_ROW_CAP = 2000;
/** Rows per machine per review day: a heavy day is capped instead of hiding the days after it. */
const REVIEW_DAY_ROW_CAP = 2000;
/** Rows per review turn; days after the one that reaches it wait for the next review. */
const REVIEW_ROW_CAP = 5000;
type Page = ActivityPeerPage;
type GitRepos = { repos: ActivityGitRepo[] };
type PulledRows = { rows: ActivityRow[]; through: number; truncated: boolean; capped: boolean };
type JournalPosition = Pick<MachineCursor, "journalId" | "seq" | "headSeq">;
const positionOf = ({ journalId, seq, headSeq }: MachineCursor): JournalPosition => ({ journalId, seq, headSeq });
const samePosition = (a: JournalPosition | undefined, b: JournalPosition) => !!a && a.journalId === b.journalId && a.seq === b.seq && a.headSeq === b.headSeq;

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
    // The quiet gate must see the same input pull() feeds the assistant: never its own terminal.
    read: async (since, limit, window) => ({ ...journal.read(since, limit, window ?? {}), ...journal.status({ exceptSession: ASSISTANT_SESSION_NAME }) }),
    git: async (from, to) => ({ repos: await readGitLogs(activeCwds(journal.readAll({ to }), from, to), from, to) }),
  };
}
export function peerActivitySource(peer: ActivityPeer): ActivitySource {
  const query = (since: number, limit: number, window?: { from: number; to: number }) =>
    `?since=${since}&limit=${limit}${window ? `&from=${new Date(window.from).toISOString()}&to=${new Date(window.to).toISOString()}` : ""}`;
  return {
    id: peer.installationId, name: peer.name, local: false,
    // Peer bodies are validated at this boundary; a bad page throws, so the peer counts as unreached this tick.
    read: async (since, limit, window) => {
      const page = parseActivityPage(await peer.get<unknown>(`${ACTIVITY_PATH}${query(since, limit, window)}`, 2 * 1024 * 1024));
      if (!page) throw new Error("invalid activity page");
      return page;
    },
    git: async (from, to) => {
      const git = parseActivityGit(await peer.get<unknown>(`${ACTIVITY_PATH}/git${query(0, 0, { from, to })}`, 1024 * 1024));
      if (!git) throw new Error("invalid git payload");
      return git;
    },
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
  /** `unconfirmed`: the outstanding inbox's last send could not be verified (it may still have arrived). */
  catchingUp: { machines: number; since: string | null; routine?: string; unconfirmed?: true } | null;
  stale: { since: string } | null;
  unreachable: { name: string; since: string | null }[];
  surfaced: { file: string; sends: number } | null;
  /** The day-summary day (else the last completed activity day), whether its note exists, and the activity-day turn that ends it. */
  yesterday: { date: string; note: boolean; endsAt: string };
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
  private unconfirmedFile?: string;
  private reached = new Set<string>();
  private pendingPulls = new Map<string, { position: JournalPosition; pulled: PulledRows }>();
  private baselineAttempts = new Map<string, JournalPosition>();
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
  /** A value that would not read back fails the tick here instead of bricking routines.json. */
  private save(coverage: FocusCoverage): void {
    if (!isFocusCoverage(coverage)) throw new Error("routine coverage failed validation; not saved");
    writePrivateJsonFile(this.path, coverage);
    this.snapshot = coverage;
  }

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
    // A notice answers one manual request; any later tick (or the inbox it writes) supersedes it.
    this.notice = undefined;
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
    // A busy live assistant without a routine is doing terminal work, not boot catch-up.
    // restartPending still requests the ordinary catch-up once it rests.
    if (sample.sessionId && !sample.idle && !coverage.inbox && !this.deps.queueBusy()) this.booting = false;
    const machines: SchedulerMachine[] = Object.entries(coverage.catchUpCursors).map(([id, c]) => ({
      id, reachable: this.reached.has(id), pendingRows: c.headSeq > c.seq, lastRowAt: c.lastRowAt, lastInputAt: c.lastInputAt,
    }));
    this.pending = machines.some(m => m.pendingRows);
    const inbox = coverage.inbox && { ...coverage.inbox, queued: this.queuedFile === coverage.inbox.file };
    const input = { now, timing, enabled: true, idle, booting: this.booting, restarted: this.restartPending, manual, machines,
      reviewedThrough: coverage.reviewedThrough, provisional: coverage.provisional?.date ?? null, lastRun: coverage.lastRun, lastUrgentCatchUpAt: coverage.lastUrgentCatchUpAt, inbox };
    let actions = decideRoutines(input);
    const pending = new Map<string, PulledRows>();
    // Reviews and already-due catch-ups need no speculative pending pull. Only
    // inspect for an early urgent run; unchanged journal positions reuse a pull.
    if (!actions.length && idle && !coverage.inbox) {
      await Promise.all(sources.filter(s => this.reached.has(s.id)).map(async source => {
        const cursor = coverage.catchUpCursors[source.id]!;
        if (cursor.headSeq <= cursor.seq) return;
        await this.restoreNeedsInput(source, cursor, timing);
        const pulled = await this.readPending(source, cursor);
        if (!pulled) return;
        pending.set(source.id, pulled);
        const baseline = !pulled.truncated ? cursor.needsInputSnapshot : undefined;
        machines.find(m => m.id === source.id)!.newlyNeedsInput = pendingNeedsInput(pulled.rows, baseline).newlyNeedsInput;
      }));
      actions = decideRoutines(input);
    }
    if (!actions.length && this.booting && idle && !coverage.inbox) this.booting = false;
    for (const action of actions) coverage = await this.execute(action, coverage, sources, timing, manual, pending);
    this.save(coverage);
  }

  /**
   * Heads and last input per machine. A replaced journal (a different journal
   * id, or a head behind the cursor) restarts that cursor and forgets every
   * seq recorded against the old journal.
   */
  private async probe(coverage: FocusCoverage, source: ActivitySource, timing: AssistantTiming): Promise<void> {
    try {
      const status = await source.read(0, 0);
      let cursor: MachineCursor | undefined = coverage.catchUpCursors[source.id];
      const otherJournal = !!cursor?.journalId && !!status.journalId && cursor.journalId !== status.journalId;
      // Without ids, a head behind any seq already recorded for this machine (acked or outstanding) means a new journal.
      const recorded = Math.max(cursor?.seq ?? 0, coverage.inbox?.through[source.id] ?? 0, coverage.provisional?.through[source.id] ?? 0);
      if (cursor && (otherJournal || status.headSeq < recorded)) {
        log.warn("activity journal replaced; cursor restarted", { machine: source.name });
        cursor = undefined;
        if (coverage.inbox) {
          delete coverage.inbox.through[source.id];
          if (coverage.inbox.needsInputSessions) delete coverage.inbox.needsInputSessions[source.id];
          if (coverage.inbox.needsInputSnapshots) delete coverage.inbox.needsInputSnapshots[source.id];
        }
        if (coverage.provisional) delete coverage.provisional.through[source.id];
      }
      if (!cursor) {
        // First contact: catch-ups start at today's first row; earlier days belong to reviews.
        const today = activityDayWindow(activityDayOf(this.now(), timing.fallbackTime), timing.fallbackTime);
        const first = (await source.read(0, 1, { from: today.start, to: today.end })).rows[0];
        cursor = { name: source.name, seq: first ? first.seq - 1 : status.headSeq, headSeq: status.headSeq, lastReachedAt: null, lastRowAt: null, lastInputAt: null,
          needsInputSnapshot: { complete: true, needsInputSessions: [], sessionIdentities: {} } };
      }
      coverage.catchUpCursors[source.id] = { ...cursor, name: source.name, headSeq: status.headSeq, lastReachedAt: this.iso(), lastRowAt: status.lastRowAt, lastInputAt: status.lastInputAt,
        ...(status.journalId && { journalId: status.journalId }) };
      this.reached.add(source.id);
    } catch (error) { log.debug("activity source unreachable", { machine: source.name, error: errMsg(error) }); }
  }

  /** Best-effort cache recovery, never a liveness probe. Replay at most the
   * previous/current activity days in one pass (one bounded page for a peer).
   * A missing prefix leaves unobserved identities unknown, not non-waiting.
   */
  private async restoreNeedsInput(source: ActivitySource, cursor: MachineCursor, timing: AssistantTiming): Promise<void> {
    if (cursor.needsInputSnapshot || samePosition(this.baselineAttempts.get(source.id), cursor)) return;
    this.baselineAttempts.set(source.id, positionOf(cursor));
    const today = activityDayOf(this.now(), timing.fallbackTime);
    const from = activityDayWindow(addDays(today, -1), timing.fallbackTime).start;
    const to = activityDayWindow(today, timing.fallbackTime).end;
    try {
      // Local reads already parse the selected files once; avoid re-parsing
      // them page by page. Peer requests retain the public page-size bound.
      const page = await source.read(0, source.local ? Number.MAX_SAFE_INTEGER : ACTIVITY_PAGE_MAX, { from, to });
      if (page.next < cursor.seq) { log.debug("activity baseline incomplete", { machine: source.name }); return; }
      const rows = page.rows.filter(row => row.seq <= cursor.seq);
      const { newlyNeedsInput: _, ...snapshot } = pendingNeedsInput(source.local ? withoutAssistantRows(rows) : rows);
      snapshot.complete = cursor.seq === 0 || (!page.truncated && rows[0]?.seq === 1);
      if (isNeedsInputSnapshot(snapshot)) cursor.needsInputSnapshot = snapshot;
      else log.debug("activity baseline exceeds cache bounds", { machine: source.name });
    } catch (error) { log.warn("activity baseline unavailable; source remains reached", { machine: source.name, error: errMsg(error) }); }
  }

  private async readPending(source: ActivitySource, cursor: MachineCursor): Promise<PulledRows | null> {
    const cached = this.pendingPulls.get(source.id);
    if (cached && samePosition(cached.position, cursor)) return cached.pulled;
    const pulled = await this.tryPull(source, cursor.seq, CATCH_UP_ROW_CAP);
    if (pulled) this.pendingPulls.set(source.id, { position: positionOf(cursor), pulled });
    return pulled;
  }

  /** `capped`: the row cap stopped the pull; `truncated`: retention removed rows the cursor or window needed. */
  private async pull(source: ActivitySource, since: number, cap: number, window?: { from: number; to: number }): Promise<PulledRows> {
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
    return { rows, through: cursor, truncated, capped: rows.length >= cap };
  }

  /** A source that fails mid-routine counts as unreached for the rest of this tick. */
  private async tryPull(source: ActivitySource, ...args: [number, number, { from: number; to: number }?]) {
    try { return await this.pull(source, ...args); }
    catch (error) { this.reached.delete(source.id); log.debug("activity source failed mid-routine", { machine: source.name, error: errMsg(error) }); return null; }
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
        if (outcome === "failed") this.unconfirmedFile = file;
        else if (outcome === "sent" && this.unconfirmedFile === file) this.unconfirmedFile = undefined;
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
    through: Record<string, number>, days?: string[], provisional?: string, urgent = false): FocusCoverage {
    const createdAt = this.iso();
    const file = inboxFileName(routine, this.now());
    mkdirSync(join(this.deps.folder, "inbox"), { recursive: true, mode: 0o700 });
    const path = join(this.deps.folder, "inbox", file);
    writePrivateJsonFile(path, buildInbox({ file, routine, createdAt, ...doc }));
    const needsInputSnapshots: Record<string, NeedsInputSnapshot> = {};
    // Day/gap windows can skip state rows between seq and through, even when a
    // later day advances the watermark. Only contiguous catch-up rows qualify.
    for (const machine of doc.machines) if (machine.reached && routine === ROUTINE.CATCH_UP && !machine.truncated) {
      const cursor = coverage.catchUpCursors[machine.installationId];
      if (machine.from !== (cursor?.seq ?? 0)) continue;
      const baseline = cursor?.needsInputSnapshot;
      const { newlyNeedsInput: _, ...snapshot } = pendingNeedsInput(machine.rows, baseline);
      if (isNeedsInputSnapshot(snapshot)) needsInputSnapshots[machine.installationId] = snapshot;
    }
    const next: FocusCoverage = { ...coverage, lastRun: { ...coverage.lastRun, [routine]: createdAt },
      ...(urgent && { lastUrgentCatchUpAt: createdAt }),
      inbox: { file, routine, createdAt, sends: 0, lastSentAt: null, surfaced: false, through, needsInputSnapshots, ...(days?.length && { days }), ...(provisional && { provisional }) } };
    // The file is only reachable through coverage: a refused save must not leave it behind.
    try { this.save(next); } catch (error) { rmSync(path, { force: true }); throw error; }
    this.send(file);
    return next;
  }

  private async execute(action: RoutineAction, coverage: FocusCoverage, sources: ActivitySource[], timing: AssistantTiming, manual: boolean, pending: Map<string, PulledRows>): Promise<FocusCoverage> {
    const reachable = sources.filter(s => this.reached.has(s.id));
    switch (action.type) {
      case "drop-inbox":
        rmSync(join(this.deps.folder, "inbox", action.file), { force: true });
        // A dropped provisional review was never processed: today may be reviewed again.
        return { ...coverage, inbox: null, ...(coverage.inbox?.provisional && { provisional: null }) };
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
          await this.restoreNeedsInput(source, cursor, timing);
          const pulled = pending.get(source.id) ?? await this.readPending(source, cursor);
          if (!pulled) continue;
          through[source.id] = pulled.through;
          if (pulled.rows.length) blocks.push({ installationId: source.id, name: source.name, reached: true, from: cursor.seq, through: pulled.through, truncated: pulled.truncated, capped: pulled.capped, rows: pulled.rows });
        }
        if (!blocks.length) {
          for (const [id, seq] of Object.entries(through)) coverage.catchUpCursors[id] = { ...coverage.catchUpCursors[id]!, seq: Math.max(coverage.catchUpCursors[id]!.seq, seq) };
          if (manual) this.notice = "nothing new to catch up on";
          return coverage;
        }
        return this.writeInbox(coverage, ROUTINE.CATCH_UP, { machines: [...blocks, ...this.unreachedBlocks(coverage)] }, through, undefined, undefined, action.reason === "urgent");
      }
      case ROUTINE.DAY_REVIEW: case ROUTINE.GAP_REVIEW:
        return this.review(action.type, action.days, coverage, reachable, timing);
    }
  }

  /**
   * Day and gap reviews. Each day is pulled per machine with its own cap, and
   * only days actually pulled are listed or closed. The current day is
   * provisional: it never advances `reviewedThrough`. A provisional day at
   * the turn is pulled only after the provisional review's rows; with no user
   * input after it the day closes without a turn, otherwise a later section is
   * appended to its note.
   */
  private async review(routine: typeof ROUTINE.DAY_REVIEW | typeof ROUTINE.GAP_REVIEW, days: string[], coverage: FocusCoverage, reachable: ActivitySource[], timing: AssistantTiming): Promise<FocusCoverage> {
    const today = activityDayOf(this.now(), timing.fallbackTime);
    const provisional = coverage.provisional ?? null;
    const dayOf = (row: ActivityRow) => activityDayOf(Date.parse(row.at), timing.fallbackTime);
    const pulled: { date: string; start: number; end: number; capped: boolean; machines: { source: ActivitySource; rows: ActivityRow[]; truncated: boolean }[] }[] = [];
    let total = 0;
    for (const date of days) {
      const window = activityDayWindow(date, timing.fallbackTime);
      const after = provisional?.date === date ? provisional : null;
      const machines: (typeof pulled)[number]["machines"] = [];
      let capped = false;
      for (const source of reachable.filter(s => this.reached.has(s.id))) {
        const result = await this.tryPull(source, after?.through[source.id] ?? 0, REVIEW_DAY_ROW_CAP, { from: window.start, to: window.end });
        if (!result) continue;
        const rows = result.rows.filter(r => dayOf(r) === date);
        capped ||= result.capped;
        machines.push({ source, rows, truncated: result.truncated });
        total += rows.length;
      }
      pulled.push({ date, start: after ? Date.parse(after.at) : window.start, end: window.end, capped, machines });
      if (total >= REVIEW_ROW_CAP) break;
    }
    const isUserInput = (row: ActivityRow) => row.kind === ACTIVITY_KIND.INPUT;
    // A machine unreached now but known (from its cursor) to have been active on a completed day still makes
    // that day reviewable: the assistant writes it from what catch-ups delivered, and the ack closes it.
    const unreachedOn = (date: string) => {
      const window = activityDayWindow(date, timing.fallbackTime);
      return Object.entries(coverage.catchUpCursors).filter(([id, cursor]) => {
        if (this.reached.has(id) || date >= today) return false;
        const onProvisionalDay = provisional?.date === date;
        const after = onProvisionalDay && provisional.through[id] !== undefined ? Date.parse(provisional.at) : -Infinity;
        // Like reached machines, the provisional day reopens only for user input, never for a state-only row.
        return (onProvisionalDay ? [cursor.lastInputAt] : [cursor.lastRowAt, cursor.lastInputAt]).some(at => { const t = at ? Date.parse(at) : NaN; return t >= window.start && t < window.end && t > after; });
      }).map(([, cursor]) => ({ name: cursor.name, lastReachedAt: cursor.lastReachedAt }));
    };
    const active = pulled.filter(d => unreachedOn(d.date).length > 0
      || d.machines.some(m => provisional?.date === d.date ? m.rows.some(isUserInput) : m.rows.length > 0));
    const completed = pulled.map(d => d.date).filter(date => date < today);
    const closed = completed.at(-1);
    const advance = (c: FocusCoverage): FocusCoverage => {
      const next = { ...c, ...(closed && (!c.reviewedThrough || closed > c.reviewedThrough) && { reviewedThrough: closed }) };
      return { ...next, provisional: settledProvisional(next) };
    };
    const reviewsToday = pulled.some(d => d.date === today);
    if (!active.length) {
      // Nothing for the assistant: close completed days, and for today only record the run.
      const next = advance({ ...coverage, lastRun: { ...coverage.lastRun, [routine]: this.iso() } });
      return reviewsToday ? { ...next, provisional: { date: today, at: this.iso(), through: {} } } : next;
    }
    mkdirSync(join(this.deps.folder, "days"), { recursive: true, mode: 0o700 });
    let noteUpdated = false;
    const inboxDays: InboxDay[] = [];
    for (const day of active) {
      const note = join(this.deps.folder, "days", `${day.date}.md`);
      const update = provisional?.date === day.date && existsSync(note);
      const machines = day.machines.filter(m => m.rows.length).map(m => ({ name: m.source.name, rows: m.rows }));
      const unreached = unreachedOn(day.date);
      if (update && !provisional.noteUpdated) {
        writePrivateFile(note, readFileSync(note, "utf8") + dayNoteUpdateMarkdown(day, machines, await this.gitFor(day, day.machines), unreached));
        noteUpdated = true;
      } else if (!existsSync(note)) {
        writePrivateFile(note, dayNoteMarkdown(day.date, day, machines, await this.gitFor(day, day.machines), unreached));
      }
      inboxDays.push({ date: day.date, note: `days/${day.date}.md`, from: new Date(day.start).toISOString(), to: new Date(day.end).toISOString(), capped: day.capped, ...(update && { update: true as const }) });
    }
    const blocks = new Map<string, { source: ActivitySource; rows: ActivityRow[]; truncated: boolean; capped: boolean }>();
    for (const day of pulled) for (const m of day.machines) {
      const block = blocks.get(m.source.id) ?? { source: m.source, rows: [], truncated: false, capped: false };
      block.rows.push(...m.rows);
      block.truncated ||= m.truncated;
      block.capped ||= day.capped && m.rows.length >= REVIEW_DAY_ROW_CAP;
      blocks.set(m.source.id, block);
    }
    const through: Record<string, number> = {};
    for (const [id, b] of blocks) if (b.rows.length) through[id] = Math.max(...b.rows.map(r => r.seq));
    let next = coverage;
    if (noteUpdated && provisional) next = { ...next, provisional: { ...provisional, noteUpdated: true } };
    if (reviewsToday) {
      const todays: Record<string, number> = {};
      for (const m of pulled.find(d => d.date === today)!.machines) if (m.rows.length) todays[m.source.id] = Math.max(...m.rows.map(r => r.seq));
      next = { ...next, provisional: { date: today, at: this.iso(), through: todays } };
    }
    return this.writeInbox(next, routine, {
      days: inboxDays,
      machines: [...[...blocks.values()].filter(b => b.rows.length).map(b => ({ installationId: b.source.id, name: b.source.name, reached: true as const, from: 0, through: through[b.source.id]!, truncated: b.truncated, capped: b.capped, rows: b.rows })), ...this.unreachedBlocks(next)],
    }, through, completed, reviewsToday ? today : undefined);
  }

  private async gitFor(window: { start: number; end: number }, machines: { source: ActivitySource }[]): Promise<GitRepoLog[]> {
    return (await Promise.all(machines.map(async m => {
      try { return (await m.source.git(window.start, window.end)).repos.map(repo => ({ machine: m.source.name, ...repo })); }
      catch (error) { return [{ machine: m.source.name, cwd: "(all repositories)", commits: [], error: errMsg(error) }]; }
    }))).flat();
  }

  /** `wolfpack activity ack <file>`: the only path that advances cursors and review coverage. */
  ack(file: string): Promise<{ ok: true; already: boolean }> {
    const name = file.split("/").at(-1) ?? "";
    if (!isInboxFileName(name)) return Promise.reject(new InvalidInboxFile());
    return this.exclusive(() => {
      const result = applyAck(this.read(), name, this.iso());
      if (!result.already) {
        this.save(result.coverage);
        // An ack is progress even while the harness is busy with its next turn.
        this.booting = false;
        rmSync(join(this.deps.folder, "inbox", name), { force: true });
        if (this.queuedFile === name) this.queuedFile = undefined;
      }
      return { ok: true as const, already: result.already };
    });
  }

  /** Why `catch up now` is refused right now, if it is: an inbox is in flight and not yet surfaced. */
  manualRefusal(): string | null {
    const inbox = this.snapshot.inbox;
    return inbox && !inbox.surfaced ? `the ${inbox.routine} inbox is not acknowledged yet; catch up now is offered if it stays unacknowledged` : null;
  }

  dayNote(date: string): string | null {
    if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw new Error("date must be YYYY-MM-DD");
    try { return readFileSync(join(this.deps.folder, "days", `${date}.md`), "utf8"); } catch { return null; }
  }

  /** Render-ready routine state for `/api/focus`; `summaryDate` is the focus document's day-summary date. */
  status(summaryDate?: string): RoutineStatus {
    const c = this.snapshot;
    const inbox = c.inbox;
    // A surfaced inbox waits for `catch up now`; it is not progress, even right after a restart.
    const catchingUp = this.deps.enabled() && !inbox?.surfaced && (this.booting || inbox)
      ? { machines: Math.max(1, Object.keys(c.catchUpCursors).length), since: c.lastAckAt, ...(inbox && { routine: inbox.routine }),
        ...(inbox && this.unconfirmedFile === inbox.file && { unconfirmed: true as const }) } : null;
    const yesterday = summaryDate && /^\d{4}-\d\d-\d\d$/.test(summaryDate) ? summaryDate : addDays(activityDayOf(this.now(), this.fallbackTime), -1);
    const stale = !catchingUp && this.pending && c.lastAckAt && this.now() - Date.parse(c.lastAckAt) > STALE_AFTER_MS ? { since: c.lastAckAt } : null;
    return {
      reviewedThrough: c.reviewedThrough, lastAckAt: c.lastAckAt, catchingUp, stale,
      unreachable: this.probed ? Object.entries(c.catchUpCursors).filter(([id]) => !this.reached.has(id)).map(([, m]) => ({ name: m.name, since: m.lastReachedAt })) : [],
      surfaced: inbox?.surfaced ? { file: inbox.file, sends: inbox.sends } : null,
      yesterday: { date: yesterday, note: existsSync(join(this.deps.folder, "days", `${yesterday}.md`)), endsAt: new Date(activityDayWindow(yesterday, this.fallbackTime).end).toISOString() },
      ...(this.notice && { notice: this.notice }), ...(this.error && { error: this.error }),
    };
  }
}
