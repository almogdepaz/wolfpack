import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FocusUiJournal } from "../../src/server/focus-ui-journal";
import { FOCUS_UI_ACTION as A } from "../../src/focus-ui-log";
test("private ui journal survives restart, repairs multibyte tails, partitions and retains independently", () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-journal-"));
  const today = "2026-11-16";
  const event = (at: string) => ({ action: A.OPEN, visit: "v1", at });
  const options = { dir, now: () => Date.parse(`${today}T12:00:00.000Z`) };
  try {
    const journal = new FocusUiJournal(options);
    expect(journal.append(event(`${today}T11:00:00.000Z`)).seq).toBe(1);
    journal.close();
    const path = join(dir, `${today}.jsonl`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    appendFileSync(path, '{"unfinished":"🐺');
    const restarted = new FocusUiJournal(options);
    expect(restarted.append(event(`${today}T12:00:00.000Z`)).seq).toBe(2);
    restarted.close();
    expect(readFileSync(path, "utf8").trim().split("\n").map(s => JSON.parse(s).seq)).toEqual([1, 2]);
    writeFileSync(join(dir, "2026-01-01.jsonl"), JSON.stringify({ ...event("2026-01-01T00:00:00.000Z"), seq: 100 }) + "\n");
    const pruned = new FocusUiJournal(options);
    expect(pruned.append(event("2026-11-15T23:59:59.000Z")).seq).toBe(3);
    pruned.close();
    expect(readdirSync(dir)).not.toContain("2026-01-01.jsonl");
    expect(readdirSync(dir)).toContain("2026-11-15.jsonl");
    expect(pruned.readAll().map(r => r.seq)).toEqual([1, 2, 3]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
