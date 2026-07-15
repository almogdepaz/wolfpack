import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRalphLog } from "../../src/server/ralph.js";

// Set test env so module loads cleanly
process.env.WOLFPACK_TEST = "1";

let projectDir: string;
let siblingDir: string;
let parentDir: string;

function writeLog(dir: string, content: string): void {
  writeFileSync(join(dir, ".ralph.log"), content);
}

function logWithWorkdir(workdir: string): string {
  return [
    "🥋 ralph — 3 iterations",
    "agent: claude",
    "plan: PLAN.md",
    "progress: progress.txt",
    "pid: 0",
    "started: Mon Jan 01 2024 12:00:00 GMT-0500",
    `workdir: ${workdir}`,
    "",
  ].join("\n");
}

describe("parseRalphLog — workdir path boundary check (ISS-02)", () => {
  beforeEach(() => {
    // Create /tmp/xxx/project and /tmp/xxx/project2 to test boundary
    parentDir = mkdtempSync(join(tmpdir(), "ralph-boundary-"));
    projectDir = join(parentDir, "project");
    siblingDir = join(parentDir, "project2");
    mkdirSync(projectDir);
    mkdirSync(siblingDir);
  });

  afterEach(() => {
    rmSync(parentDir, { recursive: true, force: true });
  });

  test("rejects sibling path that shares string prefix (project2 vs project)", () => {
    // Place plan in sibling dir — should NOT be used
    writeFileSync(join(siblingDir, "PLAN.md"), "- [x] evil task\n");
    // Place different plan in project dir
    writeFileSync(join(projectDir, "PLAN.md"), "- [ ] real task\n");
    // Log references workdir as the sibling
    writeLog(projectDir, logWithWorkdir(siblingDir));

    const s = parseRalphLog(projectDir)!;
    // Should fall back to projectDir, not use siblingDir
    expect(s.tasksTotal).toBe(1);
    expect(s.tasksDone).toBe(0); // from projectDir's plan (unchecked)
  });

  test("accepts exact projectDir as workdir", () => {
    writeFileSync(join(projectDir, "PLAN.md"), "- [x] done\n- [ ] pending\n");
    writeLog(projectDir, logWithWorkdir(projectDir));

    const s = parseRalphLog(projectDir)!;
    expect(s.tasksTotal).toBe(2);
  });

  test("accepts child path under projectDir", () => {
    const worktree = join(projectDir, ".wolfpack", "worktrees", "fix-branch");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "PLAN.md"), "- [x] wt task\n");
    writeFileSync(join(worktree, "progress.txt"), "DONE: checkbox: wt task\n");
    writeLog(projectDir, logWithWorkdir(worktree));

    const s = parseRalphLog(projectDir)!;
    expect(s.tasksTotal).toBe(1);
    expect(s.tasksDone).toBe(1);
  });

  test("rejects absolute planFile path (log injection)", () => {
    // A corrupted or malicious log with plan: /etc/passwd should not read that file
    const evilLog = [
      "🥋 ralph — 3 iterations",
      "agent: claude",
      "plan: /etc/passwd",
      "progress: progress.txt",
      "pid: 0",
      "started: Mon Jan 01 2024 12:00:00 GMT-0500",
      "",
    ].join("\n");
    writeLog(projectDir, evilLog);

    const s = parseRalphLog(projectDir)!;
    expect(s.planFile).toBe("");
    expect(s.tasksTotal).toBe(0);
  });

  test("rejects planFile with .. traversal", () => {
    // plan: ../../etc/passwd should be rejected, not passed to readFileSync
    const evilLog = [
      "🥋 ralph — 3 iterations",
      "agent: claude",
      "plan: ../../etc/passwd",
      "progress: progress.txt",
      "pid: 0",
      "started: Mon Jan 01 2024 12:00:00 GMT-0500",
      "",
    ].join("\n");
    writeLog(projectDir, evilLog);

    const s = parseRalphLog(projectDir)!;
    expect(s.planFile).toBe("");
    expect(s.tasksTotal).toBe(0);
  });
});
