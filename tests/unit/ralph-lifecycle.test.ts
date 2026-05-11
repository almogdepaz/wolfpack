/**
 * Tests for ralph loop lifecycle: create → run → cancel → continue → dismiss.
 * Covers status derivation, lock management, strict completion detection,
 * and the continue-from-cancel flow per docs/ralph-behavior.md.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import {
  writeFileSync, readFileSync, appendFileSync,
  mkdtempSync, rmSync, existsSync, unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TASK_HEADER, countTasksInContent } from "../../src/wolfpack-context.js";
import { parseRalphLog, countProgressDone } from "../../src/server/ralph.js";
import { startFakeRalph, stopFakeRalph, type FakeRalph } from "../helpers/fake-ralph-pid.js";

// PID stand-in for fixtures that need parseRalphLog active=true under the
// PID-reuse-safe filter (issues.md H6). See tests/helpers/fake-ralph-pid.ts.
let fakeRalphPid: number = process.pid;
let fakeRalph: FakeRalph | null = null;
beforeAll(() => { fakeRalph = startFakeRalph(); fakeRalphPid = fakeRalph.pid; });
afterAll(() => { if (fakeRalph) stopFakeRalph(fakeRalph); });

// ── Replicated worker logic (same pattern as plan-mutation.test.ts) ──

function taskSectionHeader(task: string): string | null {
  const line = task.split("\n")[0];
  return TASK_HEADER.test(line) ? line : null;
}

function readCompletedTasks(progressPath: string): Set<string> {
  const completed = new Set<string>();
  try {
    const content = readFileSync(progressPath, "utf-8");
    for (const line of content.split("\n")) {
      if (line.startsWith("DONE: ")) completed.add(line.slice(6));
    }
  } catch { /* no progress file yet */ }
  return completed;
}

function markTaskCompleted(progressPath: string, task: string, checkbox: boolean): void {
  const key = checkbox ? `checkbox: ${task}` : `section: ${taskSectionHeader(task) || task.split("\n")[0]}`;
  appendFileSync(progressPath, `DONE: ${key}\n`);
}

function extractCurrentTask(planPath: string, progressPath: string): { task: string; checkbox: boolean } | null {
  try {
    const plan = readFileSync(planPath, "utf-8");
    const completed = readCompletedTasks(progressPath);

    for (const line of plan.split("\n")) {
      const cbMatch = line.match(/^- \[ \] (.+)$/);
      if (cbMatch && !completed.has(`checkbox: ${cbMatch[1]}`)) {
        return { task: cbMatch[1], checkbox: true };
      }
    }

    const lines = plan.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (TASK_HEADER.test(line)) {
        if (completed.has(`section: ${line}`)) continue;
        const level = line.match(/^(#{2,3})/)?.[1] || "##";
        const sectionLines = [line];
        for (let j = i + 1; j < lines.length; j++) {
          const nextMatch = lines[j].match(/^(#{1,3}) /);
          if (nextMatch && nextMatch[1].length <= level.length) break;
          sectionLines.push(lines[j]);
        }
        const children = sectionLines.filter(l => /^- \[ \] /.test(l));
        const allChildrenDone = children.length > 0 && children.every(l => {
          const text = l.match(/^- \[ \] (.+)$/)?.[1];
          return text && completed.has(`checkbox: ${text}`);
        });
        if (allChildrenDone) continue;
        return { task: sectionLines.join("\n").trim(), checkbox: false };
      }
    }
    return null;
  } catch { return null; }
}

// ── Frontend status derivation (mirrors app-ralph.ts getRalphStatus) ──

function getRalphStatus(loop: any) {
  const hitLimit = !loop.active && !loop.completed && loop.finished;
  return {
    hitLimit,
    status: loop.audit ? "audit" : loop.cleanup ? "cleanup" : loop.active ? "running" : loop.completed ? "done" : hitLimit ? "limit" : "idle",
    statusLabel: loop.audit ? "AUDIT" : loop.cleanup ? "CLEANUP" : loop.active ? "RUNNING" : loop.completed ? "DONE" : hitLimit ? "STOPPED" : "IDLE",
    dotClass: loop.active ? "purple" : "gray",
    dotTitle: loop.active ? "active" : "idle",
  };
}

// ── Test helpers ──

let tmpDir: string;
let planPath: string;
let progressPath: string;

function writePlan(content: string): void {
  writeFileSync(planPath, content);
}

function writeLog(content: string): void {
  writeFileSync(join(tmpDir, ".ralph.log"), content);
}

function writeProgress(content: string): void {
  writeFileSync(progressPath, content);
}

function buildLogHeader(opts: {
  iterations?: number;
  agent?: string;
  plan?: string;
  progress?: string;
  pid?: number;
  started?: string;
  cleanupPhase?: "on" | "off";
  auditFixPhase?: "on" | "off";
  worktree?: string;
} = {}): string {
  return [
    `🥋 ralph — ${opts.iterations ?? 5} iterations`,
    `agent: ${opts.agent ?? "claude"}`,
    `plan: ${opts.plan ?? "PLAN.md"}`,
    `progress: ${opts.progress ?? "progress.txt"}`,
    `phase_cleanup: ${opts.cleanupPhase ?? "on"}`,
    `phase_audit_fix: ${opts.auditFixPhase ?? "off"}`,
    `worktree: ${opts.worktree ?? "false"}`,
    `pid: ${opts.pid ?? 99999}`,
    `bin: /usr/local/bin/claude`,
    `started: ${opts.started ?? "Mon Jan 01 2024 12:00:00 GMT-0500"}`,
    "",
  ].join("\n");
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ralph-lifecycle-"));
  planPath = join(tmpDir, "PLAN.md");
  progressPath = join(tmpDir, "progress.txt");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// getRalphStatus — frontend status derivation
// Per spec: audit > cleanup > running > done > limit > idle
// ═══════════════════════════════════════════════════════════════════════════

describe("getRalphStatus", () => {
  test("audit phase takes priority", () => {
    const r = getRalphStatus({ active: true, audit: true, cleanup: false, completed: false, finished: "" });
    expect(r.status).toBe("audit");
    expect(r.statusLabel).toBe("AUDIT");
  });

  test("cleanup phase when audit is false", () => {
    const r = getRalphStatus({ active: true, audit: false, cleanup: true, completed: false, finished: "" });
    expect(r.status).toBe("cleanup");
    expect(r.statusLabel).toBe("CLEANUP");
  });

  test("running when active, no special phase", () => {
    const r = getRalphStatus({ active: true, audit: false, cleanup: false, completed: false, finished: "" });
    expect(r.status).toBe("running");
    expect(r.statusLabel).toBe("RUNNING");
    expect(r.dotClass).toBe("purple");
  });

  test("done when completed", () => {
    const r = getRalphStatus({ active: false, audit: false, cleanup: false, completed: true, finished: "some date" });
    expect(r.status).toBe("done");
    expect(r.statusLabel).toBe("DONE");
    expect(r.dotClass).toBe("gray");
  });

  test("limit (stopped) when not active, not completed, but finished", () => {
    const r = getRalphStatus({ active: false, audit: false, cleanup: false, completed: false, finished: "some date" });
    expect(r.status).toBe("limit");
    expect(r.statusLabel).toBe("STOPPED");
    expect(r.hitLimit).toBeTruthy();
  });

  test("idle when nothing applies", () => {
    const r = getRalphStatus({ active: false, audit: false, cleanup: false, completed: false, finished: "" });
    expect(r.status).toBe("idle");
    expect(r.statusLabel).toBe("IDLE");
    expect(r.hitLimit).toBeFalsy();
  });

  test("audit takes priority over cleanup when both true", () => {
    const r = getRalphStatus({ active: true, audit: true, cleanup: true, completed: false, finished: "" });
    expect(r.status).toBe("audit");
  });

  test("active takes priority over completed", () => {
    const r = getRalphStatus({ active: true, audit: false, cleanup: false, completed: true, finished: "" });
    expect(r.status).toBe("running");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cancel → Continue lifecycle
// Per spec: cancel deletes progress.txt → continue starts fresh
// ═══════════════════════════════════════════════════════════════════════════

describe("cancel → continue lifecycle", () => {
  test("cancel deletes progress, continue starts fresh", () => {
    writePlan("- [ ] Task A\n- [ ] Task B\n- [ ] Task C\n- [ ] Task D\n- [ ] Task E\n");
    writeProgress("DONE: checkbox: Task A\nDONE: checkbox: Task B\nDONE: checkbox: Task C\n");
    expect(extractCurrentTask(planPath, progressPath)?.task).toBe("Task D");

    // Cancel: delete progress (as routes.ts does)
    unlinkSync(progressPath);

    // Continue: all tasks available again
    const result = extractCurrentTask(planPath, progressPath);
    expect(result).toEqual({ task: "Task A", checkbox: true });
  });

  test("cancel preserves plan file", () => {
    const planContent = "- [ ] Task A\n- [ ] Task B\n";
    writePlan(planContent);
    writeProgress("DONE: checkbox: Task A\n");

    unlinkSync(progressPath);

    expect(readFileSync(planPath, "utf-8")).toBe(planContent);
  });

  test("cancel preserves log file", () => {
    writePlan("- [ ] Task\n");
    writeLog(buildLogHeader());
    writeProgress("DONE: checkbox: Task\n");

    unlinkSync(progressPath);

    expect(existsSync(join(tmpDir, ".ralph.log"))).toBe(true);
  });

  test("continue with section tasks — restarts from first section", () => {
    writePlan("## 1. Setup\nDetails\n\n## 2. Build\nMore\n\n## 3. Deploy\nFinal\n");
    writeProgress("DONE: section: ## 1. Setup\nDONE: section: ## 2. Build\n");
    expect(extractCurrentTask(planPath, progressPath)?.task).toContain("## 3. Deploy");

    unlinkSync(progressPath);

    expect(extractCurrentTask(planPath, progressPath)?.task).toContain("## 1. Setup");
  });

  test("continue with subtask-expanded plan — subtasks still in plan, all re-available", () => {
    // Subtasks appended at bottom, outside any section
    writePlan("## 1. Big task\nOverview\n\n## 2. Other\nMore\n\n- [ ] Sub A\n- [ ] Sub B\n");
    writeProgress("DONE: section: ## 1. Big task\nDONE: checkbox: Sub A\nDONE: checkbox: Sub B\n");
    // Section 2 has Sub A/Sub B as children (they fall under it), all children done → skipped
    // So extractCurrentTask returns null (all done)
    expect(extractCurrentTask(planPath, progressPath)).toBeNull();

    unlinkSync(progressPath);

    // Continue: checkboxes first (Sub A before sections)
    expect(extractCurrentTask(planPath, progressPath)?.task).toBe("Sub A");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Dismiss lifecycle
// Per spec: deletes log + lock + progress, optionally plan
// ═══════════════════════════════════════════════════════════════════════════

describe("dismiss lifecycle", () => {
  test("dismiss removes log, lock, and progress", () => {
    writePlan("- [ ] Task\n");
    writeLog(buildLogHeader());
    writeProgress("DONE: checkbox: Task\n");
    writeFileSync(join(tmpDir, ".ralph.lock"), "12345");

    unlinkSync(join(tmpDir, ".ralph.log"));
    unlinkSync(join(tmpDir, ".ralph.lock"));
    unlinkSync(progressPath);

    expect(existsSync(join(tmpDir, ".ralph.log"))).toBe(false);
    expect(existsSync(join(tmpDir, ".ralph.lock"))).toBe(false);
    expect(existsSync(progressPath)).toBe(false);
    expect(existsSync(planPath)).toBe(true);
  });

  test("dismiss with deletePlan removes plan too", () => {
    writePlan("- [ ] Task\n");
    writeLog(buildLogHeader());

    unlinkSync(join(tmpDir, ".ralph.log"));
    unlinkSync(planPath);

    expect(existsSync(planPath)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Strict all-done detection
// Per spec: worker writes `all_tasks_done: true` to log when
// extractCurrentTask() returns null and plan has tasks.
// No count-based heuristics.
// ═══════════════════════════════════════════════════════════════════════════

describe("strict all-done detection", () => {
  test("all checkboxes completed → extractCurrentTask null + planTotal > 0", () => {
    writePlan("- [ ] A\n- [ ] B\n- [ ] C\n");
    writeProgress("DONE: checkbox: A\nDONE: checkbox: B\nDONE: checkbox: C\n");
    expect(extractCurrentTask(planPath, progressPath)).toBeNull();
    const { total } = countTasksInContent(readFileSync(planPath, "utf-8"));
    expect(total).toBeGreaterThan(0);
  });

  test("all sections completed → extractCurrentTask null + planTotal > 0", () => {
    writePlan("## 1. First\nBody\n\n## 2. Second\nMore\n");
    writeProgress("DONE: section: ## 1. First\nDONE: section: ## 2. Second\n");
    expect(extractCurrentTask(planPath, progressPath)).toBeNull();
    const { total } = countTasksInContent(readFileSync(planPath, "utf-8"));
    expect(total).toBeGreaterThan(0);
  });

  test("sections with all-children-done → extractCurrentTask null (no explicit section DONE needed)", () => {
    writePlan("## 1. Setup\n- [ ] Install\n- [ ] Config\n\n## 2. Build\n- [ ] Compile\n");
    writeProgress("DONE: checkbox: Install\nDONE: checkbox: Config\nDONE: checkbox: Compile\n");
    // extractCurrentTask returns null: no unchecked checkboxes, both sections have all-children-done
    expect(extractCurrentTask(planPath, progressPath)).toBeNull();
    // planTotal > 0 → worker would write all_tasks_done: true
    const { total } = countTasksInContent(readFileSync(planPath, "utf-8"));
    // Headers present → only headers counted (ISS-09 fix: no double-counting with checkboxes)
    expect(total).toBe(2); // 2 section headers only
    expect(total).toBeGreaterThan(0);
  });

  test("tasksDone != tasksTotal does NOT prevent completed when all_tasks_done is in log", () => {
    // This is the key scenario: sections implicitly done via children,
    // progress has 3 DONE lines but plan has 5 tasks.
    // Old code: completed=false. New code: completed=true via all_tasks_done.
    const DEAD_PID = 2147483647;
    writePlan("## 1. Setup\n- [ ] Install\n- [ ] Config\n\n## 2. Build\n- [ ] Compile\n");
    writeProgress("DONE: checkbox: Install\nDONE: checkbox: Config\nDONE: checkbox: Compile\n");
    writeLog(
      buildLogHeader({ pid: DEAD_PID, plan: "PLAN.md", progress: "progress.txt" }) +
      "\n=== 🥋 All tasks completed — date ===\n" +
      "all_tasks_done: true\n" +
      "finished: Mon Jan 01 2024\n"
    );

    const status = parseRalphLog(tmpDir);
    expect(status!.completed).toBe(true);
    // tasksDone (3 DONE lines) != tasksTotal (2 headers) but completed=true via all_tasks_done
    // ISS-09: headers-only counting means total=2, not 5
    expect(status!.tasksDone).toBe(3);
    expect(status!.tasksTotal).toBe(2);
  });

  test("completed=false when all_tasks_done is NOT in log (tasks remain)", () => {
    const DEAD_PID = 2147483647;
    writePlan("- [ ] A\n- [ ] B\n- [ ] C\n");
    writeProgress("DONE: checkbox: A\n");
    writeLog(
      buildLogHeader({ pid: DEAD_PID, plan: "PLAN.md", progress: "progress.txt" }) +
      "finished: Mon Jan 01 2024\n"
    );

    const status = parseRalphLog(tmpDir);
    expect(status!.completed).toBe(false);
    expect(status!.tasksDone).toBe(1);
    expect(status!.tasksTotal).toBe(3);
  });

  test("completed=false when active even with all_tasks_done in log", () => {
    writePlan("- [ ] A\n");
    writeProgress("DONE: checkbox: A\n");
    writeLog(
      buildLogHeader({ pid: fakeRalphPid, plan: "PLAN.md", progress: "progress.txt" }) +
      "all_tasks_done: true\n"
    );

    const status = parseRalphLog(tmpDir);
    expect(status!.active).toBe(true);
    expect(status!.completed).toBe(false);
  });

  test("corrupted plan (no parseable tasks) → not allDone", () => {
    writePlan("## Rewritten header\nContent\n## Another\nMore\n");
    const { total } = countTasksInContent(readFileSync(planPath, "utf-8"));
    expect(total).toBe(0);
    // planTotal === 0 → allDone is false
    expect(total > 0).toBe(false);
  });

  test("empty plan → not allDone", () => {
    writePlan("");
    const { total } = countTasksInContent(readFileSync(planPath, "utf-8"));
    expect(total).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseRalphLog completed status — strict via all_tasks_done log line
// ═══════════════════════════════════════════════════════════════════════════

describe("parseRalphLog completed status (strict)", () => {
  const DEAD_PID = 2147483647;

  test("completed=true when all_tasks_done in log + PID dead", () => {
    writePlan("- [ ] Task A\n- [ ] Task B\n");
    writeProgress("DONE: checkbox: Task A\nDONE: checkbox: Task B\n");
    writeLog(
      buildLogHeader({ pid: DEAD_PID, plan: "PLAN.md", progress: "progress.txt" }) +
      "all_tasks_done: true\n" +
      "finished: Mon Jan 01 2024\n"
    );

    const status = parseRalphLog(tmpDir);
    expect(status!.completed).toBe(true);
    expect(status!.active).toBe(false);
  });

  test("completed=false when no all_tasks_done line", () => {
    writePlan("- [ ] Task A\n- [ ] Task B\n- [ ] Task C\n");
    writeProgress("DONE: checkbox: Task A\n");
    writeLog(
      buildLogHeader({ pid: DEAD_PID, plan: "PLAN.md", progress: "progress.txt" }) +
      "finished: Mon Jan 01 2024\n"
    );

    const status = parseRalphLog(tmpDir);
    expect(status!.completed).toBe(false);
  });

  test("completed=false when active (even with all_tasks_done)", () => {
    writePlan("- [ ] Task A\n");
    writeProgress("DONE: checkbox: Task A\n");
    writeLog(
      buildLogHeader({ pid: fakeRalphPid, plan: "PLAN.md", progress: "progress.txt" }) +
      "all_tasks_done: true\n"
    );

    const status = parseRalphLog(tmpDir);
    expect(status!.active).toBe(true);
    expect(status!.completed).toBe(false);
  });

  test("completed=false when no progress file", () => {
    writePlan("- [ ] Task A\n");
    writeLog(
      buildLogHeader({ pid: DEAD_PID, plan: "PLAN.md", progress: "progress.txt" }) +
      "finished: Mon Jan 01 2024\n"
    );

    const status = parseRalphLog(tmpDir);
    expect(status!.completed).toBe(false);
  });

  test("section plan with all_tasks_done — completed", () => {
    writePlan("## 1. First\nBody\n\n## 2. Second\nMore\n");
    writeProgress("DONE: section: ## 1. First\nDONE: section: ## 2. Second\n");
    writeLog(
      buildLogHeader({ pid: DEAD_PID, plan: "PLAN.md", progress: "progress.txt" }) +
      "all_tasks_done: true\n" +
      "finished: Mon Jan 01 2024\n"
    );

    const status = parseRalphLog(tmpDir);
    expect(status!.completed).toBe(true);
  });

  test("mixed plan with subtask expansion — completed via all_tasks_done", () => {
    writePlan("## 1. Setup\n- [ ] Install\n- [ ] Config\n\n## 2. Build\nBody\n");
    writeProgress(
      "DONE: section: ## 1. Setup\n" +
      "DONE: checkbox: Install\n" +
      "DONE: checkbox: Config\n" +
      "DONE: section: ## 2. Build\n"
    );
    writeLog(
      buildLogHeader({ pid: DEAD_PID, plan: "PLAN.md", progress: "progress.txt" }) +
      "all_tasks_done: true\n" +
      "finished: Mon Jan 01 2024\n"
    );

    const status = parseRalphLog(tmpDir);
    expect(status!.completed).toBe(true);
    // ISS-09: headers-only counting → total=2 (not 4). tasksDone=4 from progress file.
    expect(status!.tasksTotal).toBe(2);
    expect(status!.tasksDone).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// countProgressDone
// ═══════════════════════════════════════════════════════════════════════════

describe("countProgressDone", () => {
  test("counts DONE: lines in progress file", () => {
    writeProgress("# Progress\nDONE: checkbox: A\nDONE: checkbox: B\nDONE: section: ## 1. C\n");
    expect(countProgressDone(progressPath)).toBe(3);
  });

  test("returns 0 for missing file", () => {
    expect(countProgressDone(join(tmpDir, "nonexistent.txt"))).toBe(0);
  });

  test("ignores non-DONE lines", () => {
    writeProgress("# Progress\nSome freeform notes\nDONE: checkbox: A\nMore notes\n");
    expect(countProgressDone(progressPath)).toBe(1);
  });

  test("returns 0 for empty file", () => {
    writeProgress("");
    expect(countProgressDone(progressPath)).toBe(0);
  });

  test("deduplicates identical DONE lines", () => {
    writeProgress(
      "DONE: section: ## 1. Task\n" +
      "DONE: section: ## 1. Task\n" +
      "DONE: section: ## 1. Task\n" +
      "DONE: checkbox: Sub A\n" +
      "DONE: checkbox: Sub A\n"
    );
    expect(countProgressDone(progressPath)).toBe(2);
  });

  test("counts unique keys when agent duplicates entries", () => {
    // simulates real bug: agent writes DONE + worker writes DONE
    writeProgress(
      "## Task 1 notes\nDONE: section: ## 1. Setup\n" +
      "## Task 1 repeat\nDONE: section: ## 1. Setup\n" +
      "DONE: section: ## 2. Build\n"
    );
    expect(countProgressDone(progressPath)).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Same-task-twice guard with progress tracking
// Per spec: if same section task picked consecutively → force-mark done, skip
// ═══════════════════════════════════════════════════════════════════════════

describe("same-task-twice guard", () => {
  test("same section task returned when not marked done", () => {
    writePlan("## 1. Big task\nDetails\n\n## 2. Other\nMore\n");
    const first = extractCurrentTask(planPath, progressPath);
    const second = extractCurrentTask(planPath, progressPath);
    expect(first!.task).toBe(second!.task);
  });

  test("force-marking done advances to next task", () => {
    writePlan("## 1. Big task\nDetails\n\n## 2. Other\nMore\n");
    const first = extractCurrentTask(planPath, progressPath);
    expect(first!.task).toContain("## 1. Big task");

    markTaskCompleted(progressPath, first!.task, first!.checkbox);

    const next = extractCurrentTask(planPath, progressPath);
    expect(next!.task).toContain("## 2. Other");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseRalphLog — worktreeMode parsing
// ═══════════════════════════════════════════════════════════════════════════

describe("parseRalphLog worktreeMode", () => {
  test("parses worktree mode from log header", () => {
    writePlan("- [ ] task\n");
    writeLog(buildLogHeader({ worktree: "plan" }));
    const status = parseRalphLog(tmpDir);
    expect(status!.worktreeMode).toBe("plan");
  });

  test("defaults to false when not present", () => {
    writePlan("- [ ] task\n");
    writeLog("🥋 ralph — 5 iterations\nagent: claude\nplan: PLAN.md\nprogress: progress.txt\npid: 99999\nstarted: Mon Jan 01 2024\n");
    const status = parseRalphLog(tmpDir);
    expect(status!.worktreeMode).toBe("false");
  });

  test("parses task mode", () => {
    writePlan("- [ ] task\n");
    writeLog(buildLogHeader({ worktree: "task" }));
    const status = parseRalphLog(tmpDir);
    expect(status!.worktreeMode).toBe("task");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseRalphLog — phase config parsing
// ═══════════════════════════════════════════════════════════════════════════

describe("parseRalphLog phase config", () => {
  test("parses cleanup=on audit-fix=off", () => {
    writePlan("- [ ] task\n");
    writeLog(buildLogHeader({ cleanupPhase: "on", auditFixPhase: "off" }));
    const status = parseRalphLog(tmpDir);
    expect(status!.cleanupEnabled).toBe(true);
    expect(status!.auditFixEnabled).toBe(false);
  });

  test("parses cleanup=off audit-fix=on", () => {
    writePlan("- [ ] task\n");
    writeLog(buildLogHeader({ cleanupPhase: "off", auditFixPhase: "on" }));
    const status = parseRalphLog(tmpDir);
    expect(status!.cleanupEnabled).toBe(false);
    expect(status!.auditFixEnabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Lock file management
// Per spec: .ralph.lock prevents concurrent runs
// ═══════════════════════════════════════════════════════════════════════════

describe("lock file behavior", () => {
  test("lock file created atomically with wx flag", () => {
    const lockPath = join(tmpDir, ".ralph.lock");
    writeFileSync(lockPath, "", { flag: "wx" });
    expect(existsSync(lockPath)).toBe(true);

    expect(() => writeFileSync(lockPath, "", { flag: "wx" })).toThrow();
  });

  test("lock with PID content is parseable", () => {
    const lockPath = join(tmpDir, ".ralph.lock");
    writeFileSync(lockPath, "12345");
    const pid = Number(readFileSync(lockPath, "utf-8").trim());
    expect(pid).toBe(12345);
  });

  test("lock with empty content → PID NaN → treated as stale", () => {
    const lockPath = join(tmpDir, ".ralph.lock");
    writeFileSync(lockPath, "");
    const pid = Number(readFileSync(lockPath, "utf-8").trim());
    expect(Number.isNaN(pid) || pid === 0).toBe(true);
  });

  test("lock with garbage content → PID NaN → treated as stale", () => {
    const lockPath = join(tmpDir, ".ralph.lock");
    writeFileSync(lockPath, "not-a-pid");
    const pid = Number(readFileSync(lockPath, "utf-8").trim());
    expect(Number.isNaN(pid)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Subtask expansion + completion tracking end-to-end
// ═══════════════════════════════════════════════════════════════════════════

describe("subtask expansion lifecycle", () => {
  test("full subtask expansion → completion flow", () => {
    // Section 2 comes AFTER subtasks are appended, so subtasks fall under section 1's scope
    // In reality, appendSubtasksToPlan appends at end of file
    writePlan("## 1. Big feature\nDesign it\n\n## 2. Tests\nTest it\n");

    // Iteration 1: agent emits subtasks for section 1
    // Worker marks parent done and appends checkboxes at end of file
    markTaskCompleted(progressPath, "## 1. Big feature\nDesign it", false);
    appendFileSync(planPath, "\n- [ ] Sub A\n- [ ] Sub B\n");
    // Note: Sub A and Sub B are appended AFTER ## 2, so they fall under section 2's scope.

    // Iteration 2: picks Sub A (checkboxes scanned first)
    let task = extractCurrentTask(planPath, progressPath);
    expect(task).toEqual({ task: "Sub A", checkbox: true });
    markTaskCompleted(progressPath, "Sub A", true);

    // Iteration 3: picks Sub B
    task = extractCurrentTask(planPath, progressPath);
    expect(task).toEqual({ task: "Sub B", checkbox: true });
    markTaskCompleted(progressPath, "Sub B", true);

    // All checkboxes done. Section 1 is explicitly done. Section 2 has all-children-done (Sub A, Sub B).
    // extractCurrentTask returns null → all done
    expect(extractCurrentTask(planPath, progressPath)).toBeNull();
    const { total } = countTasksInContent(readFileSync(planPath, "utf-8"));
    expect(total).toBeGreaterThan(0);
  });

  test("multiple subtask expansions tracked correctly", () => {
    // Use a single section to avoid subtasks falling under wrong section
    writePlan("## 1. Auth\nAuth stuff\n");

    markTaskCompleted(progressPath, "## 1. Auth\nAuth stuff", false);
    appendFileSync(planPath, "\n- [ ] Auth sub 1\n- [ ] Auth sub 2\n");

    let task = extractCurrentTask(planPath, progressPath);
    expect(task).toEqual({ task: "Auth sub 1", checkbox: true });
    markTaskCompleted(progressPath, "Auth sub 1", true);

    task = extractCurrentTask(planPath, progressPath);
    expect(task).toEqual({ task: "Auth sub 2", checkbox: true });
    markTaskCompleted(progressPath, "Auth sub 2", true);

    // Auth sub 2 done, section 1 all-children-done → returns null
    expect(extractCurrentTask(planPath, progressPath)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Full lifecycle simulation
// ═══════════════════════════════════════════════════════════════════════════

describe("full lifecycle simulation", () => {
  test("create → run all tasks → completed status", () => {
    const DEAD_PID = 2147483647;

    writePlan("- [ ] Task A\n- [ ] Task B\n");
    writeLog(
      buildLogHeader({ pid: DEAD_PID, iterations: 2, plan: "PLAN.md", progress: "progress.txt" }) +
      "\n=== 🥋 Wax On 1/2 — date ===\ntask: Task A\n=== ✅ Iteration 1 complete ===\n" +
      "\n=== 🥋 Wax On 2/2 — date ===\ntask: Task B\n=== ✅ Iteration 2 complete ===\n" +
      "all_tasks_done: true\n" +
      "finished: Mon Jan 01 2024 13:00:00\n"
    );
    writeProgress("DONE: checkbox: Task A\nDONE: checkbox: Task B\n");

    const status = parseRalphLog(tmpDir);
    expect(status!.active).toBe(false);
    expect(status!.completed).toBe(true);
    expect(status!.tasksDone).toBe(2);
    expect(status!.tasksTotal).toBe(2);
    expect(status!.iteration).toBe(2);

    const { status: uiStatus } = getRalphStatus(status!);
    expect(uiStatus).toBe("done");
  });

  test("create → run some tasks → hit limit → stopped status", () => {
    const DEAD_PID = 2147483647;

    writePlan("- [ ] Task A\n- [ ] Task B\n- [ ] Task C\n");
    writeLog(
      buildLogHeader({ pid: DEAD_PID, iterations: 2, plan: "PLAN.md", progress: "progress.txt" }) +
      "\n=== 🥋 Wax On 1/2 — date ===\ntask: Task A\n=== ✅ Iteration 1 complete ===\n" +
      "\n=== 🥋 Wax On 2/2 — date ===\ntask: Task B\n=== ✅ Iteration 2 complete ===\n" +
      "=== Completed 2 iterations ===\n" +
      "finished: Mon Jan 01 2024 13:00:00\n"
    );
    writeProgress("DONE: checkbox: Task A\nDONE: checkbox: Task B\n");

    const status = parseRalphLog(tmpDir);
    expect(status!.active).toBe(false);
    expect(status!.completed).toBe(false); // no all_tasks_done line
    expect(status!.finished).not.toBe("");
    expect(status!.tasksDone).toBe(2);
    expect(status!.tasksTotal).toBe(3);

    const { status: uiStatus } = getRalphStatus(status!);
    expect(uiStatus).toBe("limit");
  });

  test("create → cancel → continue → complete → done", () => {
    const DEAD_PID = 2147483647;

    // Phase 1: run 1 task, then cancel
    writePlan("- [ ] Task A\n- [ ] Task B\n");
    writeProgress("DONE: checkbox: Task A\n");

    // Cancel: delete progress
    unlinkSync(progressPath);

    // Continue: all tasks re-available
    expect(extractCurrentTask(planPath, progressPath)?.task).toBe("Task A");

    // Phase 2: run all tasks
    writeProgress("DONE: checkbox: Task A\nDONE: checkbox: Task B\n");
    writeLog(
      buildLogHeader({ pid: DEAD_PID, plan: "PLAN.md", progress: "progress.txt" }) +
      "all_tasks_done: true\n" +
      "finished: Mon Jan 01 2024\n"
    );

    const status = parseRalphLog(tmpDir);
    expect(status!.completed).toBe(true);
    expect(status!.tasksDone).toBe(2);
  });

  test("implicitly-done sections → completed via all_tasks_done (not count comparison)", () => {
    const DEAD_PID = 2147483647;

    // Plan with sections that have child checkboxes
    writePlan("## 1. Setup\n- [ ] Install\n- [ ] Config\n\n## 2. Build\n- [ ] Compile\n");
    // Only checkboxes marked done — section headers NOT in progress
    writeProgress("DONE: checkbox: Install\nDONE: checkbox: Config\nDONE: checkbox: Compile\n");
    // Worker detected all done via extractCurrentTask and wrote the signal
    writeLog(
      buildLogHeader({ pid: DEAD_PID, plan: "PLAN.md", progress: "progress.txt" }) +
      "all_tasks_done: true\n" +
      "finished: Mon Jan 01 2024\n"
    );

    const status = parseRalphLog(tmpDir);
    // completed=true even though tasksDone(3) != tasksTotal(2)
    // ISS-09: headers-only counting → total=2, not 5
    expect(status!.completed).toBe(true);
    expect(status!.tasksDone).toBe(3);
    expect(status!.tasksTotal).toBe(2);

    const { status: uiStatus } = getRalphStatus(status!);
    expect(uiStatus).toBe("done");
  });
});
