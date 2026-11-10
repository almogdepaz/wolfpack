import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVITY_KIND } from "../../src/activity-journal.ts";
import { EventBus } from "../../src/event-bus.ts";
import { WOLFPACK_EVENT_KIND } from "../../src/events-contract.ts";
import { ActivityJournal } from "../../src/server/activity-journal.ts";
import { ActivityRecorder, readGitHead } from "../../src/server/activity-recorder.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string { const dir = mkdtempSync(join(tmpdir(), "activity-recorder-")); roots.push(dir); return dir; }
const identity = (id: string, name: string, cwd: string) => ({ wolfpackSessionId: id, wolfpackSessionName: name, projectPath: cwd, agentKind: "pi", createdAt: "2026-11-06T09:00:00.000Z", updatedAt: "2026-11-06T09:00:00.000Z" });

function setup() {
  const dir = root();
  let now = Date.parse("2026-11-06T10:01:00.000Z");
  const journal = new ActivityJournal({ dir: join(dir, "activity"), now: () => now });
  const events = new EventBus();
  const git: string[] = [];
  const facts = [{ name: "app", alive: true, identity: identity("id-app", "app", "/dev/app") }];
  const recorder = new ActivityRecorder({
    journal, events, now: () => now,
    facts: async () => facts,
    git: async cwd => { git.push(cwd); return cwd === "/dev/app" ? { branch: "main", head: `head-${git.length}` } : {}; },
  });
  return { journal, events, recorder, git, facts, advance: (ms: number) => { now += ms; } };
}

describe("activity recorder", () => {
  test("journals created/state/exited/task events with harness and git captured off the create path", async () => {
    const { journal, events, recorder } = setup();
    recorder.start();
    expect(events.eventSubscriberCount()).toBe(1);
    events.publishEvent({ kind: WOLFPACK_EVENT_KIND.SESSION_CREATED, sessionId: "id-app", session: "app", cwd: "/dev/app" });
    events.publishEvent({ kind: WOLFPACK_EVENT_KIND.SESSION_STATE, session: "app", sessionId: "id-app", state: "needs-input", label: "Needs input", transitionSequence: 2, inputKind: "question", message: "approve?" });
    events.publishEvent({ kind: WOLFPACK_EVENT_KIND.TASK_UPDATED, taskId: "task-1", eventId: "e1", eventType: "task.completed", sequence: "1" });
    events.publishEvent({ kind: WOLFPACK_EVENT_KIND.PARENT_NOTIFIED, session: "app", sessionId: "id-app", seq: 1, message: "hello" });
    await recorder.settled();
    events.publishEvent({ kind: WOLFPACK_EVENT_KIND.SESSION_EXITED, sessionId: "id-app", session: "app", reason: "exit", exitCode: 0 });
    await recorder.settled();
    const rows = journal.read(0, 50).rows.map(({ seq: _seq, at: _at, ...rest }) => rest);
    expect(rows).toEqual([
      { kind: ACTIVITY_KIND.SESSION_STATE, session: "app", sessionId: "id-app", state: "needs-input", label: "Needs input", inputKind: "question", message: "approve?" },
      { kind: ACTIVITY_KIND.TASK_UPDATED, taskId: "task-1", eventType: "task.completed" },
      { kind: ACTIVITY_KIND.SESSION_CREATED, session: "app", sessionId: "id-app", cwd: "/dev/app", harness: "pi", branch: "main", head: "head-1" },
      { kind: ACTIVITY_KIND.SESSION_EXITED, session: "app", sessionId: "id-app", reason: "exit", exitCode: 0, head: "head-2" },
    ]);
    recorder.stop();
    expect(events.eventSubscriberCount()).toBe(0);
    journal.close();
  });

  test("presence: one row per session per 5-minute bucket, no content", async () => {
    const { journal, recorder, advance } = setup();
    await recorder.reconcile();
    recorder.notePresence("app", "browser");
    recorder.notePresence("app", "browser");
    recorder.notePresence("app", "cli");
    recorder.notePresence("other", "cli");
    advance(5 * 60_000);
    recorder.notePresence("app", "browser");
    const rows = journal.read(0, 50).rows.filter(r => r.kind === ACTIVITY_KIND.INPUT);
    expect(rows.map(({ seq: _s, at: _a, ...rest }) => rest)).toEqual([
      { kind: ACTIVITY_KIND.INPUT, session: "app", sessionId: "id-app", source: "browser", bucket: "2026-11-06T10:00:00.000Z" },
      { kind: ACTIVITY_KIND.INPUT, session: "other", source: "cli", bucket: "2026-11-06T10:00:00.000Z" },
      { kind: ACTIVITY_KIND.INPUT, session: "app", sessionId: "id-app", source: "browser", bucket: "2026-11-06T10:05:00.000Z" },
    ]);
    journal.close();
  });

  test("startup reconciliation writes one row per live session", async () => {
    const { journal, recorder, facts } = setup();
    facts.push({ name: "dead", alive: false, identity: identity("id-dead", "dead", "/dev/dead") });
    facts.push({ name: "shell", alive: true, identity: { ...identity("id-shell", "shell", "/tmp"), agentKind: "shell" } });
    await recorder.reconcile();
    expect(journal.read(0, 50).rows.map(({ seq: _s, at: _a, ...rest }) => rest)).toEqual([
      { kind: ACTIVITY_KIND.SESSION_LIVE, session: "app", sessionId: "id-app", cwd: "/dev/app", harness: "pi", branch: "main", head: "head-1" },
      { kind: ACTIVITY_KIND.SESSION_LIVE, session: "shell", sessionId: "id-shell", cwd: "/tmp", harness: "shell" },
    ]);
    journal.close();
  });

  test("reads branch and HEAD from a real repository and nothing outside one", async () => {
    const repo = root();
    execFileSync("git", ["init", "-q", "-b", "trunk", repo]);
    writeFileSync(join(repo, "f"), "x");
    execFileSync("git", ["-C", repo, "add", "f"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(await readGitHead(repo)).toEqual({ branch: "trunk", head });
    expect(await readGitHead(root())).toEqual({});
    expect(await readGitHead("/definitely/missing")).toEqual({});
  });
});

test("git log per repository within a time window", async () => {
  const { readGitLogs } = await import("../../src/server/activity-recorder.ts");
  const repo = root();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "f"), "x");
  execFileSync("git", ["-C", repo, "add", "f"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "ship\tit"], { env: { ...process.env, GIT_COMMITTER_DATE: "2026-11-06T10:00:00Z", GIT_AUTHOR_DATE: "2026-11-06T10:00:00Z" } });
  const window = [Date.parse("2026-11-06T03:00:00Z"), Date.parse("2026-11-07T03:00:00Z")] as const;
  const [inside, missing] = await readGitLogs([repo, "/definitely/missing"], ...window);
  expect(inside!.repository).toBe(true);
  expect(missing!.repository).toBe(false);
  expect(inside!.commits).toHaveLength(1);
  expect(inside!.commits[0]!.subject).toBe("ship it");
  expect(missing!.error).toBe("not a readable git repository");
  expect((await readGitLogs([repo], Date.parse("2026-11-07T03:00:00Z"), Date.parse("2026-11-08T03:00:00Z")))[0]!.commits).toEqual([]);
});

test("D2: a real repository with missing objects keeps its read error instead of being classified as a directory", async () => {
  const { readGitLogs } = await import("../../src/server/activity-recorder.ts");
  const repo = root();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, ".git/refs/heads/main"), `${"1".repeat(40)}\n`);
  const [log] = await readGitLogs([repo], Date.parse("2026-11-06T03:00:00Z"), Date.parse("2026-11-07T03:00:00Z"));
  expect(log?.repository).toBe(true);
  expect(log?.commonDir).toBe(join(repo, ".git"));
  expect(log?.error).toBe("not a readable git repository");
});

test("day-note git facts identify real linked worktrees by the common git directory", async () => {
  const { readGitLogs } = await import("../../src/server/activity-recorder.ts");
  const repo = root(), linked = join(root(), "linked");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const env = { ...process.env, GIT_COMMITTER_DATE: "2026-11-06T10:00:00Z", GIT_AUTHOR_DATE: "2026-11-06T10:00:00Z" };
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "one outcome"], { env });
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "linked", linked]);
  const logs = await readGitLogs([repo, linked], Date.parse("2026-11-06T03:00:00Z"), Date.parse("2026-11-07T03:00:00Z"));
  expect(logs.map(log => log.commonDir)).toEqual([join(repo, ".git"), join(repo, ".git")]);
  expect(logs[0]!.commits[0]!.sha).toHaveLength(40);
  expect(logs[0]!.commits).toEqual(logs[1]!.commits);
});

const hasSshKeygen = (() => { try { execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" }); return true; } catch (error) { return (error as { status?: number }).status !== undefined; } })();
test.skipIf(!hasSshKeygen)("git log ignores a repository's log.showSignature: signature lines never become commits", async () => {
  const { readGitLog } = await import("../../src/server/activity-recorder.ts");
  const repo = root();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(repo, ".key")]);
  const env = { ...process.env, GIT_COMMITTER_DATE: "2026-11-06T10:00:00Z", GIT_AUTHOR_DATE: "2026-11-06T10:00:00Z" };
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "gpg.format=ssh", "-c", `user.signingkey=${join(repo, ".key.pub")}`, "commit", "-q", "-S", "--allow-empty", "-m", "signed"], { env });
  execFileSync("git", ["-C", repo, "config", "log.showSignature", "true"]);
  const log = await readGitLog(repo, Date.parse("2026-11-06T03:00:00Z"), Date.parse("2026-11-07T03:00:00Z"));
  expect(log.commits.map(c => c.subject)).toEqual(["signed"]);
});
