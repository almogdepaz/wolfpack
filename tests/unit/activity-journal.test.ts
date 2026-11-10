import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_KIND,
  activityFileDay,
  expiredActivityFiles,
  isActivityRow,
  pageActivity,
  parseActivityGit,
  parseActivityLines,
  parseActivityPage,
  parseActivityQuery,
  presenceBucket,
  serializeActivityRow,
  type ActivityRow,
} from "../../src/activity-journal.ts";

const row = (seq: number, at = "2026-11-06T10:00:00.000Z"): ActivityRow => ({ seq, at, kind: ACTIVITY_KIND.TASK_UPDATED, taskId: `t${seq}`, eventType: "task.completed" });

describe("activity journal rows", () => {
  test("every row kind round-trips through one line and validates", () => {
    const rows: ActivityRow[] = [
      { seq: 1, at: "2026-11-06T10:00:00.000Z", kind: ACTIVITY_KIND.SESSION_CREATED, session: "app", sessionId: "id-1", cwd: "/dev/app", harness: "pi", branch: "main", head: "abc123" },
      { seq: 2, at: "2026-11-06T10:00:01.000Z", kind: ACTIVITY_KIND.SESSION_LIVE, session: "app", sessionId: "id-1", cwd: "/dev/app", harness: "pi", state: "idle" },
      { seq: 3, at: "2026-11-06T10:00:02.000Z", kind: ACTIVITY_KIND.SESSION_STATE, session: "app", sessionId: "id-1", state: "needs-input", label: "Needs input", message: "approve?", inputKind: "question" },
      { seq: 4, at: "2026-11-06T10:00:03.000Z", kind: ACTIVITY_KIND.SESSION_EXITED, session: "app", sessionId: "id-1", reason: "exit", exitCode: 0, head: "def456" },
      { seq: 5, at: "2026-11-06T10:00:04.000Z", kind: ACTIVITY_KIND.TASK_UPDATED, taskId: "task-1", eventType: "task.completed" },
      { seq: 6, at: "2026-11-06T10:05:00.000Z", kind: ACTIVITY_KIND.INPUT, session: "app", sessionId: "id-1", source: "browser", bucket: "2026-11-06T10:05:00.000Z" },
    ];
    const text = rows.map(serializeActivityRow).join("");
    expect(text.split("\n").length).toBe(rows.length + 1);
    expect(parseActivityLines(text)).toEqual({ rows, partialTailBytes: 0 });
    for (const r of rows) expect(isActivityRow(r)).toBe(true);
  });

  test("presence rows carry a bucket, never content", () => {
    expect(isActivityRow({ ...row(1), kind: ACTIVITY_KIND.INPUT, session: "a", source: "browser", bucket: "2026-11-06T10:05:00.000Z", text: "secret" })).toBe(false);
    expect(presenceBucket(Date.parse("2026-11-06T10:09:59.999Z"))).toBe("2026-11-06T10:05:00.000Z");
    expect(presenceBucket(Date.parse("2026-11-06T10:10:00.000Z"))).toBe("2026-11-06T10:10:00.000Z");
  });

  test("labels and messages are bounded at serialization", () => {
    const long: ActivityRow = { seq: 1, at: "2026-11-06T10:00:00.000Z", kind: ACTIVITY_KIND.SESSION_STATE, session: "a", state: "working", label: "l".repeat(1000), message: "m".repeat(5000) };
    const [parsed] = parseActivityLines(serializeActivityRow(long)).rows as Extract<ActivityRow, { kind: "session.state" }>[];
    expect(parsed!.label.length).toBeLessThanOrEqual(200);
    expect(parsed!.message!.length).toBeLessThanOrEqual(500);
  });

  test("a partial last line is skipped and measured; malformed middle lines are skipped", () => {
    const text = serializeActivityRow(row(1)) + "not json\n" + serializeActivityRow(row(2)) + serializeActivityRow(row(3)).slice(0, 20);
    const parsed = parseActivityLines(text);
    expect(parsed.rows.map(r => r.seq)).toEqual([1, 2]);
    expect(parsed.partialTailBytes).toBe(20);
    // A complete-looking final row without its newline is still an unfinished append.
    expect(parseActivityLines(serializeActivityRow(row(1)).trimEnd()).partialTailBytes).toBeGreaterThan(0);
  });

  test("rows are day-partitioned by UTC day", () => {
    expect(activityFileDay("2026-11-06T23:59:59.999Z")).toBe("2026-11-06");
    expect(activityFileDay("2026-11-07T00:00:00.000Z")).toBe("2026-11-07");
  });
});

describe("activity paging", () => {
  const rows = [3, 4, 5, 6, 7].map(seq => row(seq));
  test("since/limit pages with a next cursor, head and oldest seq", () => {
    expect(pageActivity(rows, 0, 2)).toEqual({ rows: rows.slice(0, 2), next: 4, headSeq: 7, oldestSeq: 3, truncated: true });
    expect(pageActivity(rows, 2, 2).truncated).toBe(false);
    expect(pageActivity(rows, 4, 10)).toEqual({ rows: rows.slice(2), next: 7, headSeq: 7, oldestSeq: 3, truncated: false });
    expect(pageActivity(rows, 7, 10)).toEqual({ rows: [], next: 7, headSeq: 7, oldestSeq: 3, truncated: false });
    expect(pageActivity(rows, 5, 0)).toEqual({ rows: [], next: 5, headSeq: 7, oldestSeq: 3, truncated: false });
    expect(pageActivity([], 0, 10)).toEqual({ rows: [], next: 0, headSeq: 0, oldestSeq: null, truncated: false });
  });
  test("query validation", () => {
    expect(parseActivityQuery(new URLSearchParams(""))).toEqual({ ok: true, since: 0, limit: 500 });
    expect(parseActivityQuery(new URLSearchParams("since=12&limit=0"))).toEqual({ ok: true, since: 12, limit: 0 });
    for (const bad of ["since=-1", "since=1.5", "limit=1001", "limit=x", "other=1"]) expect(parseActivityQuery(new URLSearchParams(bad)).ok).toBe(false);
  });
});

describe("activity retention", () => {
  test("drops files older than the retention window but always keeps the newest", () => {
    const names = ["2026-10-01.jsonl", "2026-10-07.jsonl", "2026-10-08.jsonl", "2026-11-06.jsonl", "notes.txt"];
    expect(expiredActivityFiles(names, "2026-11-07", 30)).toEqual(["2026-10-01.jsonl", "2026-10-07.jsonl"]);
    expect(expiredActivityFiles(["2026-01-01.jsonl", "2026-01-02.jsonl"], "2026-11-07", 30)).toEqual(["2026-01-01.jsonl"]);
  });
});

describe("activity windows", () => {
  test("from/to bound rows by time; cwds come from session rows seen in the window", async () => {
    const { activeCwds } = await import("../../src/activity-journal.ts");
    expect(parseActivityQuery(new URLSearchParams("from=2026-11-06T03:00:00.000Z&to=2026-11-07T03:00:00.000Z"))).toEqual({ ok: true, since: 0, limit: 500, from: Date.parse("2026-11-06T03:00:00.000Z"), to: Date.parse("2026-11-07T03:00:00.000Z") });
    expect(parseActivityQuery(new URLSearchParams("from=yesterday")).ok).toBe(false);
    expect(parseActivityQuery(new URLSearchParams("from=2026-11-07T03:00:00.000Z&to=2026-11-06T03:00:00.000Z")).ok).toBe(false);
    const rows: ActivityRow[] = [
      { seq: 1, at: "2026-11-05T10:00:00.000Z", kind: ACTIVITY_KIND.SESSION_CREATED, session: "old", sessionId: "id-old", cwd: "/dev/old" },
      { seq: 2, at: "2026-11-05T11:00:00.000Z", kind: ACTIVITY_KIND.SESSION_CREATED, session: "quiet", sessionId: "id-quiet", cwd: "/dev/quiet" },
      { seq: 3, at: "2026-11-06T10:00:00.000Z", kind: ACTIVITY_KIND.SESSION_STATE, session: "old", sessionId: "id-old", state: "working", label: "Working" },
      { seq: 4, at: "2026-11-06T11:00:00.000Z", kind: ACTIVITY_KIND.INPUT, session: "app", source: "browser", bucket: "2026-11-06T11:00:00.000Z" },
      { seq: 5, at: "2026-11-06T12:00:00.000Z", kind: ACTIVITY_KIND.SESSION_LIVE, session: "app", sessionId: "id-app", cwd: "/dev/app" },
      { seq: 6, at: "2026-11-07T12:00:00.000Z", kind: ACTIVITY_KIND.SESSION_CREATED, session: "later", sessionId: "id-later", cwd: "/dev/later" },
    ];
    expect(activeCwds(rows, Date.parse("2026-11-06T00:00:00.000Z"), Date.parse("2026-11-07T00:00:00.000Z"))).toEqual(["/dev/app", "/dev/old"]);
  });
});

describe("peer payload validation", () => {
  const page = { rows: [row(1), row(2)], next: 2, headSeq: 2, oldestSeq: 1, truncated: false, lastRowAt: "2026-11-06T10:00:00.000Z", lastInputAt: null, journalId: "j-1" };
  test("a valid page passes and invalid rows are dropped", () => {
    expect(parseActivityPage(page)).toEqual(page);
    const mixed = parseActivityPage({ ...page, rows: [row(1), { seq: 2, at: "x", kind: "task.updated" }, row(3)] });
    expect(mixed?.rows.map(r => r.seq)).toEqual([1, 3]);
    const { journalId: _, ...older } = page;
    expect(parseActivityPage(older)).toEqual(older);
    // a peer whose id file could not be created serves "": read it like an older peer, never reject the page
    expect(parseActivityPage({ ...page, journalId: "" })).toEqual(older);
  });
  test("a page with a bad cursor, timestamp or shape is rejected whole", () => {
    for (const bad of [
      { ...page, lastRowAt: "not-a-date" }, { ...page, lastInputAt: 5 }, { ...page, next: 1.5 }, { ...page, headSeq: "2" },
      { ...page, oldestSeq: -1 }, { ...page, truncated: "no" }, { ...page, rows: {} }, { ...page, journalId: 7 }, { ...page, journalId: "x".repeat(129) }, null, [],
    ]) expect(parseActivityPage(bad)).toBeNull();
    expect(parseActivityPage({ ...page, oldestSeq: null })?.oldestSeq).toBeNull();
  });
  test("git payloads need repos with commits", () => {
    const repo = { cwd: "/w", commits: [{ sha: "abc", at: "2026-11-06T10:00:00+02:00", subject: "x" }] };
    expect(parseActivityGit({ repos: [repo, { cwd: "/n", commits: [], error: "not a readable git repository" }] })?.repos).toHaveLength(2);
    expect(parseActivityGit({ repos: [{ ...repo, commonDir: "/w/.git" }] })?.repos[0]?.commonDir).toBe("/w/.git");
    expect(parseActivityGit({ repos: [{ ...repo, commonDir: 123 }] })).toBeNull();
    expect(parseActivityGit({ repos: [{ ...repo, repository: false }] })?.repos[0]?.repository).toBe(false);
    expect(parseActivityGit({ repos: [{ ...repo, repository: "false" }] })).toBeNull();
    expect(parseActivityGit({ repos: [{ cwd: "/w" }] })).toBeNull();
    expect(parseActivityGit({ repos: [{ ...repo, commits: [{ sha: 1 }] }] })).toBeNull();
    expect(parseActivityGit({})).toBeNull();
  });
});
