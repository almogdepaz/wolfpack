import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVITY_KIND, serializeActivityRow, type ActivityRowBody } from "../../src/activity-journal.ts";
import { ActivityJournal } from "../../src/server/activity-journal.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string { const dir = mkdtempSync(join(tmpdir(), "activity-journal-")); roots.push(dir); return dir; }
const task = (id: string): ActivityRowBody => ({ kind: ACTIVITY_KIND.TASK_UPDATED, taskId: id, eventType: "task.completed" });

describe("activity journal writer", () => {
  test("buffers appends, flushes on close, and continues seq across restart", () => {
    const dir = join(root(), "activity");
    let now = Date.parse("2026-11-06T23:59:59.000Z");
    const first = new ActivityJournal({ dir, now: () => now, flushMs: 60_000 });
    first.append(task("a"));
    now += 2000; // crosses the UTC day boundary: second row lands in the next file
    first.append(task("b"));
    expect(readdirSync(dir)).toEqual([]);
    first.close();
    expect(readdirSync(dir).sort()).toEqual(["2026-11-06.jsonl", "2026-11-07.jsonl"]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "2026-11-07.jsonl")).mode & 0o777).toBe(0o600);
    const second = new ActivityJournal({ dir, now: () => now });
    expect(second.append(task("c")).seq).toBe(3);
    const page = second.read(0, 10);
    expect(page.rows.map(r => r.seq)).toEqual([1, 2, 3]);
    expect(page).toMatchObject({ next: 3, headSeq: 3, oldestSeq: 1, truncated: false });
    expect(second.read(2, 10).rows.map(r => r.seq)).toEqual([3]);
    second.close();
  });

  test("recovers from a crash-truncated tail without reusing or corrupting rows", () => {
    const dir = join(root(), "activity");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "2026-11-06.jsonl");
    const at = "2026-11-06T10:00:00.000Z";
    writeFileSync(file, serializeActivityRow({ seq: 7, at, ...task("a") } as never) + serializeActivityRow({ seq: 8, at, ...task("b") } as never).slice(0, 15));
    const journal = new ActivityJournal({ dir, now: () => Date.parse("2026-11-06T11:00:00.000Z") });
    expect(journal.append(task("c")).seq).toBe(8);
    journal.flush();
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    expect(lines.map(l => JSON.parse(l).seq)).toEqual([7, 8]);
    expect(journal.read(0, 10).rows.map(r => "taskId" in r ? r.taskId : r.kind)).toEqual(["a", "c"]);
    journal.close();
  });

  test("retention prunes old days at open and on tick, keeps the newest file, reads the window setting live", () => {
    const dir = join(root(), "activity");
    mkdirSync(dir, { recursive: true });
    for (const [day, seq] of [["2026-09-01", 1], ["2026-10-07", 2], ["2026-10-08", 3]] as const) {
      appendFileSync(join(dir, `${day}.jsonl`), serializeActivityRow({ seq, at: `${day}T10:00:00.000Z`, ...task(day) } as never));
    }
    let days = 30;
    const journal = new ActivityJournal({ dir, now: () => Date.parse("2026-11-07T12:00:00.000Z"), retentionDays: () => days });
    expect(journal.status()).toMatchObject({ headSeq: 3, oldestSeq: 3 });
    expect(readdirSync(dir).sort()).toEqual(["2026-10-08.jsonl"]);
    const page = journal.read(1, 10);
    expect(page).toMatchObject({ oldestSeq: 3, truncated: true });
    days = 1;
    journal.prune();
    expect(readdirSync(dir)).toEqual(["2026-10-08.jsonl"]);
    journal.append(task("today"));
    journal.flush();
    journal.prune();
    expect(readdirSync(dir)).toEqual(["2026-11-07.jsonl"]);
    expect(journal.status()).toMatchObject({ headSeq: 4, oldestSeq: 4 });
    journal.close();
  });

  test("status reports the latest row and latest user input for scheduler probes", () => {
    const dir = join(root(), "activity");
    let now = Date.parse("2026-11-06T10:00:00.000Z");
    const journal = new ActivityJournal({ dir, now: () => now });
    journal.append({ kind: ACTIVITY_KIND.INPUT, session: "app", source: "browser", bucket: "2026-11-06T10:00:00.000Z" });
    now += 60_000;
    journal.append(task("later"));
    expect(journal.status()).toEqual({ headSeq: 2, oldestSeq: 1, lastRowAt: "2026-11-06T10:01:00.000Z", lastInputAt: "2026-11-06T10:00:00.000Z" });
    journal.close();
    const reopened = new ActivityJournal({ dir, now: () => now });
    expect(reopened.status()).toEqual({ headSeq: 2, oldestSeq: 1, lastRowAt: "2026-11-06T10:01:00.000Z", lastInputAt: "2026-11-06T10:00:00.000Z" });
    reopened.close();
  });
});

test("windowed reads return only rows inside [from, to) and page by seq", () => {
  const dir = join(root(), "activity");
  let now = Date.parse("2026-11-05T23:00:00.000Z");
  const journal = new ActivityJournal({ dir, now: () => now });
  for (const step of [0, 2, 4, 26]) { now = Date.parse("2026-11-05T23:00:00.000Z") + step * 3_600_000; journal.append(task(`h${step}`)); }
  const window = { from: Date.parse("2026-11-06T00:00:00.000Z"), to: Date.parse("2026-11-07T00:00:00.000Z") };
  expect(journal.read(0, 10, window).rows.map(r => r.seq)).toEqual([2, 3]);
  expect(journal.read(0, 1, window)).toMatchObject({ next: 2, headSeq: 4 });
  expect(journal.read(2, 10, window).rows.map(r => r.seq)).toEqual([3]);
  expect(journal.readAll().map(r => r.seq)).toEqual([1, 2, 3, 4]);
  journal.close();
});
