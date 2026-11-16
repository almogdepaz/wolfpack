import { join } from "node:path";
import { ACTIVITY_KIND, isFocusAssistantActivity, parseActivityLines, serializeActivityRow, type ActivityRow, type ActivityRowBody } from "../activity-journal.js";
import { resolveWolfpackDir } from "../wolfpack-dir.js";
import { DayJournal, JOURNAL_FLUSH_MS, JOURNAL_RETENTION_INTERVAL_MS, JOURNAL_ID_FILE, type DayJournalOptions, type JournalStatus } from "./day-journal.js";
export const ACTIVITY_FLUSH_MS = JOURNAL_FLUSH_MS;
export const ACTIVITY_RETENTION_INTERVAL_MS = JOURNAL_RETENTION_INTERVAL_MS;
export const ACTIVITY_JOURNAL_ID_FILE = JOURNAL_ID_FILE;
export interface ActivityJournalOptions extends Omit<DayJournalOptions, "dir"> { dir?: string }
export interface ActivityJournalStatus extends JournalStatus { lastInputAt: string | null }
/** Session-specific facts over the shared private day-file writer. */
export class ActivityJournal extends DayJournal<ActivityRow, ActivityRowBody> {
  private lastInputAt: string | null = null;
  /** Newest input time per session, so the quiet gate can ignore the assistant's own typing. */
  private lastInputBySession = new Map<string, string>();
  private lastUserInputBySession = new Map<string, string>();
  constructor(options: ActivityJournalOptions = {}) {
    super({ ...options, dir: options.dir ?? join(resolveWolfpackDir(), "activity") }, { parse: parseActivityLines, serialize: serializeActivityRow });
  }
  protected override observe(row: ActivityRow): void {
    super.observe(row);
    if (row.kind !== ACTIVITY_KIND.INPUT) return;
    if (!this.lastInputAt || row.at > this.lastInputAt) this.lastInputAt = row.at;
    const last = this.lastInputBySession.get(row.session);
    if (!last || row.at > last) this.lastInputBySession.set(row.session, row.at);
    if (!isFocusAssistantActivity(row)) {
      const userInput = this.lastUserInputBySession.get(row.session);
      if (!userInput || row.at > userInput) this.lastUserInputBySession.set(row.session, row.at);
    }
  }
  inputAt(session: string): string | undefined { this.open(); return this.lastInputBySession.get(session); }
  /** Exclude helper terminals' own input from the user's quiet timing. */
  status(options: { exceptSession?: string; exceptSessions?: readonly string[]; excludeFocusAssistant?: boolean } = {}): ActivityJournalStatus {
    const status = this.journalStatus();
    let lastInputAt = this.lastInputAt;
    if (options.exceptSession !== undefined || options.exceptSessions !== undefined || options.excludeFocusAssistant) {
      lastInputAt = null;
      const inputs = options.excludeFocusAssistant ? this.lastUserInputBySession : this.lastInputBySession;
      for (const [session, at] of inputs) if (session !== options.exceptSession && !options.exceptSessions?.includes(session) && (!lastInputAt || at > lastInputAt)) lastInputAt = at;
    }
    return { ...status, lastInputAt };
  }
}
