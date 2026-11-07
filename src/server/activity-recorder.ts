import { execFile } from "node:child_process";
import { ACTIVITY_KIND, presenceBucket, type ActivityRowBody, type InputSource } from "../activity-journal.js";
import type { EventBus } from "../event-bus.js";
import { WOLFPACK_EVENT_KIND, type WolfpackEvent } from "../events-contract.js";
import type { SessionListFact } from "./backend-contract.js";
import type { ActivityJournal } from "./activity-journal.js";
import { createLogger, errMsg } from "../log.js";

const log = createLogger("server");
const GIT_TIMEOUT_MS = 2000;
export interface GitHead { branch?: string; head?: string }

/** Branch + HEAD for a cwd; empty outside a repository or on any git failure. */
export function readGitHead(cwd: string): Promise<GitHead> {
  return new Promise(resolve => {
    execFile("git", ["-C", cwd, "rev-parse", "HEAD", "--abbrev-ref", "HEAD"], { timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => {
      if (error) return resolve({});
      const [head, branch] = stdout.trim().split("\n");
      resolve({ ...(branch && { branch }), ...(head && /^[0-9a-f]{7,64}$/.test(head) && { head }) });
    });
  });
}

interface Known { name: string; cwd: string }

/**
 * Turns this server's live events, PTY input presence and startup state into
 * journal rows. Git lookups run after the event, never on the create path.
 */
export class ActivityRecorder {
  private unsubscribe?: () => void;
  private readonly known = new Map<string, Known>();
  private readonly presence = new Set<string>();
  private presenceBucket = "";
  private pending = new Set<Promise<void>>();

  constructor(private readonly options: {
    journal: ActivityJournal;
    events: EventBus;
    facts: () => Promise<readonly SessionListFact[]>;
    git?: (cwd: string) => Promise<GitHead>;
    now?: () => number;
  }) {}

  private git(cwd: string): Promise<GitHead> { return (this.options.git ?? readGitHead)(cwd); }
  private append(body: ActivityRowBody): void {
    try { this.options.journal.append(body); } catch (error) { log.warn("activity append failed", { kind: body.kind, error: errMsg(error) }); }
  }
  private later(work: () => Promise<void>): void {
    const task = work().catch(error => { log.warn("activity enrichment failed", { error: errMsg(error) }); }).finally(() => { this.pending.delete(task); });
    this.pending.add(task);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.events.subscribeEvents({}, event => this.onEvent(event));
  }
  stop(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }
  /** Test and shutdown helper: resolves when queued enrichments have been appended. */
  async settled(): Promise<void> { while (this.pending.size) await Promise.all([...this.pending]); }

  private harness(id: string): Promise<string | undefined> {
    return this.options.facts().then(facts => facts.find(f => f.identity?.wolfpackSessionId === id)?.identity?.agentKind, () => undefined);
  }

  private onEvent(event: WolfpackEvent): void {
    switch (event.kind) {
      case WOLFPACK_EVENT_KIND.SESSION_CREATED: {
        this.known.set(event.sessionId, { name: event.session, cwd: event.cwd });
        this.later(async () => {
          const [harness, git] = await Promise.all([this.harness(event.sessionId), this.git(event.cwd)]);
          this.append({ kind: ACTIVITY_KIND.SESSION_CREATED, session: event.session, sessionId: event.sessionId, cwd: event.cwd, ...(harness && { harness }), ...git });
        });
        return;
      }
      case WOLFPACK_EVENT_KIND.SESSION_STATE:
        this.append({ kind: ACTIVITY_KIND.SESSION_STATE, session: event.session, ...(event.sessionId && { sessionId: event.sessionId }), state: event.state, label: event.label,
          ...(event.inputKind && { inputKind: event.inputKind }), ...(event.message && { message: event.message }) });
        return;
      case WOLFPACK_EVENT_KIND.SESSION_EXITED: {
        const known = this.known.get(event.sessionId);
        this.known.delete(event.sessionId);
        this.later(async () => {
          const git = known ? await this.git(known.cwd) : {};
          const session = event.session ?? known?.name;
          this.append({ kind: ACTIVITY_KIND.SESSION_EXITED, ...(session && { session }), sessionId: event.sessionId, reason: event.reason,
            ...(event.exitCode !== undefined && { exitCode: event.exitCode }), ...(event.signal !== undefined && { signal: event.signal }), ...(git.head && { head: git.head }) });
        });
        return;
      }
      case WOLFPACK_EVENT_KIND.TASK_UPDATED:
        this.append({ kind: ACTIVITY_KIND.TASK_UPDATED, taskId: event.taskId, eventType: event.eventType });
        return;
      default:
        return;
    }
  }

  /** Input reached a PTY from a browser or the cli. Records presence only, never the bytes. */
  notePresence(session: string, source: InputSource): void {
    const bucket = presenceBucket((this.options.now ?? Date.now)());
    if (bucket !== this.presenceBucket) { this.presenceBucket = bucket; this.presence.clear(); }
    if (this.presence.has(session)) return;
    this.presence.add(session);
    const sessionId = [...this.known].find(([, k]) => k.name === session)?.[0];
    this.append({ kind: ACTIVITY_KIND.INPUT, session, ...(sessionId && { sessionId }), source, bucket });
  }

  /** Observation does not run while the server is down; record what is live now. */
  async reconcile(): Promise<void> {
    const live = (await this.options.facts()).filter(f => f.alive && f.identity);
    const enriched = await Promise.all(live.map(async fact => ({ fact, git: await this.git(fact.identity!.projectPath) })));
    for (const { fact, git } of enriched) {
      const identity = fact.identity!;
      this.known.set(identity.wolfpackSessionId, { name: fact.name, cwd: identity.projectPath });
      this.append({ kind: ACTIVITY_KIND.SESSION_LIVE, session: fact.name, sessionId: identity.wolfpackSessionId, cwd: identity.projectPath,
        ...(identity.agentKind && { harness: identity.agentKind }), ...git });
    }
  }
}

export interface GitCommit { sha: string; at: string; subject: string }
const GIT_LOG_MAX_COMMITS = 50;
const GIT_LOG_MAX_REPOS = 20;
/** Commits on any ref in [from, to) for one repository; `error` when it is not a readable repository. */
export function readGitLog(cwd: string, from: number, to: number): Promise<{ commits: GitCommit[]; error?: string }> {
  const args = ["-C", cwd, "log", "--all", "--no-merges", "--no-show-signature", `--since=${new Date(from).toISOString()}`, `--until=${new Date(to).toISOString()}`, "--format=%h%x09%cI%x09%s", "-n", String(GIT_LOG_MAX_COMMITS)];
  return new Promise(resolve => {
    execFile("git", args, { timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => {
      if (error) return resolve({ commits: [], error: "not a readable git repository" });
      const commits = stdout.split("\n").filter(Boolean).map(line => { const [sha = "", at = "", ...subject] = line.split("\t"); return { sha, at, subject: subject.join(" ").slice(0, 200) }; });
      resolve({ commits });
    });
  });
}
/** Distinct repositories (by cwd), bounded; cwds always come from this machine's own journal. */
export async function readGitLogs(cwds: readonly string[], from: number, to: number): Promise<{ cwd: string; commits: GitCommit[]; error?: string }[]> {
  return Promise.all(cwds.slice(0, GIT_LOG_MAX_REPOS).map(async cwd => ({ cwd, ...(await readGitLog(cwd, from, to)) })));
}
