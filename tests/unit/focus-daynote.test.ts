import { expect, test } from "bun:test";
import { AGENT_STATUS_STATE } from "../../src/agent-status-contract";
import { ACTIVITY_KIND, type ActivityRow } from "../../src/activity-journal";
import { dayNoteMarkdown, dayNoteUpdateMarkdown } from "../../src/focus-coverage";
const at = "2026-11-09T12:00:00.000Z";
const window = { start: Date.parse(at), end: Date.parse(at) + 86400_000 };
const commit = (n: number) => ({ sha: String(n).padStart(40, "a"), at, subject: `outcome ${n}` });

test("day notes collapse worktrees by machine/common dir and dedupe commit hashes", () => {
  const git = [
    { machine: "home", cwd: "/dev/wolfpack", commonDir: "/dev/wolfpack/.git", commits: [commit(1), commit(2)] },
    { machine: "home", cwd: "/dev/wolfpack-focus", commonDir: "/dev/wolfpack/.git", commits: [commit(1), commit(3)] },
    { machine: "peer", cwd: "/dev/wolfpack", commonDir: "/dev/wolfpack/.git", commits: [commit(1)] },
  ];
  const note = dayNoteMarkdown("2026-11-09", window, [], git);
  expect(note.match(/### wolfpack \(home\)/g)).toHaveLength(1);
  expect(note.match(/### wolfpack \(peer\)/g)).toHaveLength(1);
  const home = note.split("### wolfpack (home)")[1]!.split("### wolfpack (peer)")[0]!;
  expect(home.match(/outcome 1/g)).toHaveLength(1);
  expect(home.match(/outcome [123]/g)).toHaveLength(3);
  expect(home.match(/\/dev\/wolfpack-focus/g)).toHaveLength(1);
  expect(home).toContain("worktrees: /dev/wolfpack · /dev/wolfpack-focus");
});

test("same display names on different installations never merge their repository facts", () => {
  const git = ["one", "two"].map(installationId => ({ machine: "same name", installationId, cwd: "/dev/repo", commonDir: "/dev/repo/.git", commits: [commit(1)] }));
  const note = dayNoteMarkdown("2026-11-09", window, [], git);
  expect(note.match(/### repo \(same name\)/g)).toHaveLength(2);
});

test("D2: non-repository directories fold once per owning machine without hiding repository errors", () => {
  const note = dayNoteMarkdown("2026-11-09", window, [], [
    { machine: "home", installationId: "one", cwd: "/home/u", repository: false, commits: [], error: "not a readable git repository" },
    { machine: "home", installationId: "one", cwd: "/tmp/x", repository: false, commits: [], error: "not a readable git repository" },
    { machine: "home", installationId: "one", cwd: "/tmp/x", repository: false, commits: [], error: "not a readable git repository" },
    { machine: "peer", installationId: "two", cwd: "/home/u", repository: false, commits: [], error: "not a readable git repository" },
    { machine: "home", installationId: "one", cwd: "/dev/repo", commonDir: "/dev/repo/.git", repository: true, commits: [], error: "commit objects unreadable" },
    { machine: "peer", installationId: "two", cwd: "(all repositories)", commits: [], error: "invalid git payload" },
  ]);
  expect(note).toContain("- not repositories (home): /home/u, /tmp/x");
  expect(note).toContain("- not repositories (peer): /home/u");
  expect(note).not.toContain("### u");
  expect(note).not.toContain("### x");
  expect(note).toContain("### repo (home)");
  expect(note).toContain("commit objects unreadable");
  expect(note).toContain("invalid git payload");
});

test("day note repository blocks cap visible commits and count the remaining bounded facts", () => {
  const note = dayNoteMarkdown("2026-11-09", window, [], [{ machine: "home", cwd: "/dev/repo", commits: Array.from({ length: 25 }, (_, n) => commit(n)) }]);
  expect(note.match(/outcome \d+/g)).toHaveLength(20);
  expect(note).toContain("+ 5 more");
});

test("sessions roll up by project and incarnation, listing only attention/failed or live sessions", () => {
  const rows: ActivityRow[] = [
    { seq: 1, at, kind: ACTIVITY_KIND.SESSION_CREATED, session: "quiet-helper", sessionId: "a", cwd: "/dev/wolfpack-focus", harness: "pi" },
    { seq: 2, at, kind: ACTIVITY_KIND.INPUT, session: "quiet-helper", sessionId: "a", source: "cli", bucket: at },
    { seq: 3, at, kind: ACTIVITY_KIND.SESSION_EXITED, session: "quiet-helper", sessionId: "a", reason: "exit" },
    { seq: 4, at, kind: ACTIVITY_KIND.SESSION_CREATED, session: "failed-helper", sessionId: "b", cwd: "/dev/wolfpack-focus", harness: "pi" },
    { seq: 5, at, kind: ACTIVITY_KIND.SESSION_STATE, session: "failed-helper", sessionId: "b", state: AGENT_STATUS_STATE.FAILED, label: "Failed" },
    { seq: 6, at, kind: ACTIVITY_KIND.SESSION_EXITED, session: "failed-helper", sessionId: "b", reason: "exit" },
    { seq: 7, at, kind: ACTIVITY_KIND.SESSION_LIVE, session: "review", sessionId: "c", cwd: "/dev/wolfpack-focus", harness: "claude" },
    { seq: 8, at, kind: ACTIVITY_KIND.SESSION_STATE, session: "review", sessionId: "c", state: AGENT_STATUS_STATE.NEEDS_INPUT, label: "Needs input" },
    { seq: 9, at, kind: ACTIVITY_KIND.SESSION_CREATED, session: "quiet-helper", sessionId: "d", cwd: "/dev/other", harness: "pi" },
    { seq: 10, at, kind: ACTIVITY_KIND.SESSION_EXITED, sessionId: "d", reason: "exit" },
  ];
  const machines = [{ name: "home", rows }]; const before = structuredClone(machines);
  const note = dayNoteMarkdown("2026-11-09", window, machines, []);
  expect(note).toContain("wolfpack-focus: 3 sessions (2 pi, 1 claude), 2 exited");
  expect(note).toContain("other: 1 session (1 pi), 1 exited");
  expect(note).toContain("failed-helper: failed · exited");
  expect(note).toContain("review: needs input · live");
  expect(note).not.toContain("quiet-helper");
  expect(note).not.toMatch(/state changes|five-minute buckets/);
  expect(machines).toEqual(before);
});

test("later sections retain their trust/heading contract and use the same bounded blocks", () => {
  const text = dayNoteUpdateMarkdown(window, [], [{ machine: "home", cwd: "/dev/no-git", commits: [], error: "not readable" }], [{ name: "laptop", lastReachedAt: null }]);
  expect(text).toContain("# later · after");
  expect(text).toContain("untrusted data");
  expect(text).toContain("not reached at review time");
  expect(text).toContain("not readable");
  expect(text).toEndWith("## assistant\n\n");
});
