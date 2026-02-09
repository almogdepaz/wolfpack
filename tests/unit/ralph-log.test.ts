import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── parseRalphLog replicated from serve.ts ──
// Module-private; replicated here with the same logic but operating on
// a configurable projectDir (the original hardcodes DEV_ROOT).

interface RalphStatus {
  project: string;
  active: boolean;
  completed: boolean;
  cleanup: boolean;
  iteration: number;
  totalIterations: number;
  agent: string;
  planFile: string;
  progressFile: string;
  started: string;
  finished: string;
  lastOutput: string;
  pid: number;
  tasksDone: number;
  tasksTotal: number;
}

function countPlanTasks(planPath: string): { done: number; total: number } {
  try {
    const plan = readFileSync(planPath, "utf-8");
    // checkbox mode
    if (/^- \[[ x]\] /m.test(plan)) {
      const done = (plan.match(/^- \[x\] /gm) || []).length;
      const pending = (plan.match(/^- \[ \] /gm) || []).length;
      return { done, total: done + pending };
    }
    // section mode
    const TASK_HEADER = /^#{2,3} (?:~~)?\d+[a-z]?[\.\)]\s+/;
    let total = 0;
    let done = 0;
    for (const line of plan.split("\n")) {
      if (TASK_HEADER.test(line)) {
        total++;
        if (line.includes("~~")) done++;
      }
    }
    return { done, total };
  } catch {
    return { done: 0, total: 0 };
  }
}

function parseRalphLog(projectDir: string): RalphStatus | null {
  const logPath = join(projectDir, ".ralph.log");
  if (!existsSync(logPath)) return null;

  const project = projectDir.split("/").pop() ?? "";
  const status: RalphStatus = {
    project,
    active: false,
    completed: false,
    cleanup: false,
    iteration: 0,
    totalIterations: 0,
    agent: "",
    planFile: "",
    progressFile: "",
    started: "",
    finished: "",
    lastOutput: "",
    pid: 0,
    tasksDone: 0,
    tasksTotal: 0,
  };

  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n");

    // parse header
    for (const line of lines.slice(0, 10)) {
      const agentMatch = line.match(/^agent:\s*(.+)/);
      if (agentMatch) status.agent = agentMatch[1].trim();
      const planMatch = line.match(/^plan:\s*(.+)/);
      if (planMatch) status.planFile = planMatch[1].trim();
      const progMatch = line.match(/^progress:\s*(.+)/);
      if (progMatch) status.progressFile = progMatch[1].trim();
      const startMatch = line.match(/^started:\s*(.+)/);
      if (startMatch) status.started = startMatch[1].trim();
      const pidMatch = line.match(/^pid:\s*(\d+)/);
      if (pidMatch) status.pid = Number(pidMatch[1]);
    }

    // parse total iterations from header line
    const totalMatch = content.match(/ralph — (\d+) iterations/);
    if (totalMatch) status.totalIterations = Number(totalMatch[1]);

    // find iterations (supports both old "Iteration" and new "Wax On" format)
    const iterRegex = /=== (?:Iteration|🥋 Wax On) (\d+)\/(\d+)/g;
    let match;
    while ((match = iterRegex.exec(content)) !== null) {
      status.iteration = Number(match[1]);
      status.totalIterations = Number(match[2]);
    }

    // check completion
    const finishedMatch = content.match(/^finished:\s*(.+)/m);
    if (finishedMatch) {
      status.finished = finishedMatch[1].trim();
    }

    // detect active: pid alive check
    if (status.pid > 1) {
      try {
        process.kill(status.pid, 0);
        status.active = true;
        status.completed = false;
        if (content.includes("Wax Off") && !content.includes("Wax Off complete")) {
          status.cleanup = true;
        }
      } catch {
        status.active = false;
      }
    }

    // last output lines (skip markers and blanks)
    const meaningful = lines.filter(
      (l) => l.trim() && !l.startsWith("===") && !l.startsWith("plan:") &&
        !l.startsWith("progress:") && !l.startsWith("started:") &&
        !l.startsWith("finished:") && !l.startsWith("pid:") &&
        !l.startsWith("agent:") && !l.startsWith("🥋"),
    );
    status.lastOutput = meaningful.slice(-5).join("\n");

    // count tasks from plan file
    if (status.planFile) {
      const tasks = countPlanTasks(join(projectDir, status.planFile));
      status.tasksDone = tasks.done;
      status.tasksTotal = tasks.total;
      if (tasks.done > 0 && tasks.done === tasks.total && !status.active) {
        status.completed = true;
      }
    }

    return status;
  } catch {
    return null;
  }
}

// ── Test helpers ──

let tmpDir: string;

function writeLog(content: string): void {
  writeFileSync(join(tmpDir, ".ralph.log"), content);
}

function writePlan(filename: string, content: string): void {
  writeFileSync(join(tmpDir, filename), content);
}

/** Build a realistic log header */
function logHeader(opts: {
  iterations?: number;
  agent?: string;
  plan?: string;
  progress?: string;
  pid?: number;
  started?: string;
} = {}): string {
  const lines = [
    `🥋 ralph — ${opts.iterations ?? 5} iterations`,
    `agent: ${opts.agent ?? "claude"}`,
    `plan: ${opts.plan ?? "PLAN.md"}`,
    `progress: ${opts.progress ?? "progress.txt"}`,
    `pid: ${opts.pid ?? 99999}`,
    `bin: /usr/local/bin/claude`,
    `started: ${opts.started ?? "Mon Jan 01 2024 12:00:00 GMT-0500"}`,
    "",
  ];
  return lines.join("\n");
}

// ── Tests ──

describe("parseRalphLog", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ralph-log-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Missing log file ──

  test("returns null when no .ralph.log exists", () => {
    expect(parseRalphLog(tmpDir)).toBeNull();
  });

  // ── Header parsing ──

  describe("header parsing", () => {
    test("parses agent from header", () => {
      writeLog(logHeader({ agent: "codex" }));
      const s = parseRalphLog(tmpDir)!;
      expect(s.agent).toBe("codex");
    });

    test("parses plan file from header", () => {
      writeLog(logHeader({ plan: "MY-PLAN.md" }));
      writePlan("MY-PLAN.md", "");
      const s = parseRalphLog(tmpDir)!;
      expect(s.planFile).toBe("MY-PLAN.md");
    });

    test("parses progress file from header", () => {
      writeLog(logHeader({ progress: "prog.txt" }));
      const s = parseRalphLog(tmpDir)!;
      expect(s.progressFile).toBe("prog.txt");
    });

    test("parses pid from header", () => {
      writeLog(logHeader({ pid: 12345 }));
      const s = parseRalphLog(tmpDir)!;
      expect(s.pid).toBe(12345);
    });

    test("parses started timestamp from header", () => {
      const ts = "Sat Feb 08 2025 10:30:00 GMT-0500";
      writeLog(logHeader({ started: ts }));
      const s = parseRalphLog(tmpDir)!;
      expect(s.started).toBe(ts);
    });

    test("parses total iterations from header line", () => {
      writeLog(logHeader({ iterations: 10 }));
      const s = parseRalphLog(tmpDir)!;
      expect(s.totalIterations).toBe(10);
    });

    test("extracts project name from directory path", () => {
      writeLog(logHeader());
      const s = parseRalphLog(tmpDir)!;
      expect(s.project).toBe(tmpDir.split("/").pop());
    });
  });

  // ── Iteration counting ──

  describe("iteration counting", () => {
    test("counts Wax On iterations — returns last iteration number", () => {
      writeLog(
        logHeader({ iterations: 5 }) +
        "\n=== 🥋 Wax On 1/5 — Mon Jan 01 2024 ===\ntask: do thing\n" +
        "\n=== ✅ Iteration 1 complete ===\n" +
        "\n=== 🥋 Wax On 2/5 — Mon Jan 01 2024 ===\ntask: do more\n" +
        "\n=== ✅ Iteration 2 complete ===\n" +
        "\n=== 🥋 Wax On 3/5 — Mon Jan 01 2024 ===\ntask: do even more\n"
      );
      const s = parseRalphLog(tmpDir)!;
      expect(s.iteration).toBe(3);
      expect(s.totalIterations).toBe(5);
    });

    test("counts old-style Iteration markers", () => {
      writeLog(
        logHeader({ iterations: 3 }) +
        "\n=== Iteration 1/3 — Mon Jan 01 2024 ===\n" +
        "\n=== Iteration 2/3 — Mon Jan 01 2024 ===\n"
      );
      const s = parseRalphLog(tmpDir)!;
      expect(s.iteration).toBe(2);
      expect(s.totalIterations).toBe(3);
    });

    test("zero iterations when no Wax On lines present", () => {
      writeLog(logHeader({ iterations: 5 }));
      const s = parseRalphLog(tmpDir)!;
      expect(s.iteration).toBe(0);
      // totalIterations still parsed from header
      expect(s.totalIterations).toBe(5);
    });

    test("totalIterations updated by iteration lines (dynamic expansion)", () => {
      // ralph can expand iterations mid-run via subtask detection
      writeLog(
        logHeader({ iterations: 3 }) +
        "\n=== 🥋 Wax On 1/3 — date ===\n" +
        "\n=== 🥋 Wax On 2/4 — date ===\n" +
        "\n=== 🥋 Wax On 3/5 — date ===\n"
      );
      const s = parseRalphLog(tmpDir)!;
      expect(s.iteration).toBe(3);
      expect(s.totalIterations).toBe(5); // last match wins
    });
  });

  // ── Status: idle (no PID / PID 0) ──

  describe("idle status (no PID)", () => {
    test("pid=0 → not active", () => {
      const header = [
        "🥋 ralph — 5 iterations",
        "agent: claude",
        "plan: PLAN.md",
        "progress: progress.txt",
        "pid: 0",
        "started: Mon Jan 01 2024",
        "",
      ].join("\n");
      writeLog(header);
      const s = parseRalphLog(tmpDir)!;
      expect(s.active).toBe(false);
      expect(s.pid).toBe(0);
    });

    test("pid=1 → not active (guarded by pid > 1)", () => {
      const header = [
        "🥋 ralph — 5 iterations",
        "agent: claude",
        "plan: PLAN.md",
        "progress: progress.txt",
        "pid: 1",
        "started: Mon Jan 01 2024",
        "",
      ].join("\n");
      writeLog(header);
      const s = parseRalphLog(tmpDir)!;
      expect(s.active).toBe(false);
    });
  });

  // ── Status: running (PID alive) ──

  describe("running status (PID alive)", () => {
    test("active=true when PID is current process (alive)", () => {
      // Use our own PID — guaranteed to be alive
      writeLog(logHeader({ pid: process.pid }));
      const s = parseRalphLog(tmpDir)!;
      expect(s.active).toBe(true);
      expect(s.completed).toBe(false);
    });

    test("active PID prevents completed even with finished line", () => {
      writeLog(
        logHeader({ pid: process.pid }) +
        "finished: Mon Jan 01 2024 13:00:00 GMT-0500\n"
      );
      const s = parseRalphLog(tmpDir)!;
      expect(s.active).toBe(true);
      expect(s.completed).toBe(false);
    });
  });

  // ── Status: dead PID (process not running) ──

  describe("dead PID (process not running)", () => {
    // Use a very high PID unlikely to exist
    const DEAD_PID = 2147483647;

    test("active=false when PID is dead", () => {
      writeLog(logHeader({ pid: DEAD_PID }));
      const s = parseRalphLog(tmpDir)!;
      expect(s.active).toBe(false);
    });

    test("completed=true when PID dead + all plan tasks done", () => {
      writeLog(logHeader({ pid: DEAD_PID, plan: "PLAN.md" }));
      writePlan("PLAN.md", "- [x] task one\n- [x] task two\n");
      const s = parseRalphLog(tmpDir)!;
      expect(s.active).toBe(false);
      expect(s.completed).toBe(true);
      expect(s.tasksDone).toBe(2);
      expect(s.tasksTotal).toBe(2);
    });

    test("completed=false when PID dead but tasks remain", () => {
      writeLog(logHeader({ pid: DEAD_PID, plan: "PLAN.md" }));
      writePlan("PLAN.md", "- [x] task one\n- [ ] task two\n");
      const s = parseRalphLog(tmpDir)!;
      expect(s.active).toBe(false);
      expect(s.completed).toBe(false);
      expect(s.tasksDone).toBe(1);
      expect(s.tasksTotal).toBe(2);
    });
  });

  // ── Status: stopped (iteration limit reached) ──

  describe("stopped status (iteration limit)", () => {
    const DEAD_PID = 2147483647;

    test("finished line present when iterations exhausted", () => {
      const ts = "Mon Jan 01 2024 14:00:00 GMT-0500";
      writeLog(
        logHeader({ pid: DEAD_PID, iterations: 3, plan: "PLAN.md" }) +
        "\n=== 🥋 Wax On 1/3 — date ===\n" +
        "\n=== ✅ Iteration 1 complete ===\n" +
        "\n=== 🥋 Wax On 2/3 — date ===\n" +
        "\n=== ✅ Iteration 2 complete ===\n" +
        "\n=== 🥋 Wax On 3/3 — date ===\n" +
        "\n=== ✅ Iteration 3 complete ===\n" +
        `=== Completed 3 iterations ===\n` +
        `finished: ${ts}\n`
      );
      writePlan("PLAN.md", "- [x] task one\n- [ ] task two\n- [ ] task three\n");
      const s = parseRalphLog(tmpDir)!;
      expect(s.active).toBe(false);
      expect(s.completed).toBe(false); // tasks remain
      expect(s.finished).toBe(ts);
      expect(s.iteration).toBe(3);
      expect(s.totalIterations).toBe(3);
      expect(s.tasksDone).toBe(1);
      expect(s.tasksTotal).toBe(3);
    });
  });

  // ── Status: cleanup phase ──

  describe("cleanup phase (Wax Off)", () => {
    test("cleanup=true when Wax Off started but not complete (PID alive)", () => {
      writeLog(
        logHeader({ pid: process.pid, plan: "PLAN.md" }) +
        "\n=== 🥋 Wax On 1/1 — date ===\n" +
        "\n=== ✅ Iteration 1 complete ===\n" +
        "\n=== 🥋 Wax Off — starting cleanup — date ===\n" +
        "some cleanup output\n"
      );
      writePlan("PLAN.md", "- [x] task one\n");
      const s = parseRalphLog(tmpDir)!;
      expect(s.active).toBe(true);
      expect(s.cleanup).toBe(true);
    });

    test("cleanup=false when Wax Off complete (PID alive)", () => {
      writeLog(
        logHeader({ pid: process.pid, plan: "PLAN.md" }) +
        "\n=== 🥋 Wax On 1/1 — date ===\n" +
        "\n=== ✅ Iteration 1 complete ===\n" +
        "\n=== 🥋 Wax Off — starting cleanup — date ===\n" +
        "\n=== ✅ Wax Off complete — date ===\n"
      );
      writePlan("PLAN.md", "- [x] task one\n");
      const s = parseRalphLog(tmpDir)!;
      expect(s.active).toBe(true);
      expect(s.cleanup).toBe(false);
    });

    test("cleanup=false when PID dead (even with Wax Off started)", () => {
      const DEAD_PID = 2147483647;
      writeLog(
        logHeader({ pid: DEAD_PID, plan: "PLAN.md" }) +
        "\n=== 🥋 Wax Off — starting cleanup — date ===\n"
      );
      writePlan("PLAN.md", "- [x] task one\n");
      const s = parseRalphLog(tmpDir)!;
      expect(s.active).toBe(false);
      expect(s.cleanup).toBe(false); // cleanup only set when active
    });
  });

  // ── Completed status (all tasks done) ──

  describe("completed status", () => {
    const DEAD_PID = 2147483647;

    test("completed=true when all checkbox tasks done + PID dead", () => {
      writeLog(logHeader({ pid: DEAD_PID, plan: "PLAN.md" }));
      writePlan("PLAN.md", "- [x] first\n- [x] second\n- [x] third\n");
      const s = parseRalphLog(tmpDir)!;
      expect(s.completed).toBe(true);
      expect(s.tasksDone).toBe(3);
      expect(s.tasksTotal).toBe(3);
    });

    test("completed=true when all section tasks struck through + PID dead", () => {
      writeLog(logHeader({ pid: DEAD_PID, plan: "PLAN.md" }));
      writePlan("PLAN.md", "## ~~1. Build widget~~\nstuff\n## ~~2. Test widget~~\nstuff\n");
      const s = parseRalphLog(tmpDir)!;
      expect(s.completed).toBe(true);
      expect(s.tasksDone).toBe(2);
      expect(s.tasksTotal).toBe(2);
    });

    test("completed=false when no tasks in plan (done=0)", () => {
      writeLog(logHeader({ pid: DEAD_PID, plan: "PLAN.md" }));
      writePlan("PLAN.md", "# Project Plan\nJust some notes.\n");
      const s = parseRalphLog(tmpDir)!;
      expect(s.completed).toBe(false);
      expect(s.tasksDone).toBe(0);
      expect(s.tasksTotal).toBe(0);
    });

    test("completed=false when plan file missing (countPlanTasks returns 0/0)", () => {
      writeLog(logHeader({ pid: DEAD_PID, plan: "NONEXISTENT.md" }));
      const s = parseRalphLog(tmpDir)!;
      expect(s.completed).toBe(false);
    });
  });

  // ── Last output extraction ──

  describe("lastOutput", () => {
    test("extracts last 5 meaningful lines", () => {
      writeLog(
        logHeader() +
        "\n=== 🥋 Wax On 1/5 — date ===\n" +
        "line one\nline two\nline three\nline four\nline five\nline six\nline seven\n"
      );
      const s = parseRalphLog(tmpDir)!;
      expect(s.lastOutput).toBe("line three\nline four\nline five\nline six\nline seven");
    });

    test("skips === marker lines", () => {
      writeLog(
        logHeader() +
        "\n=== 🥋 Wax On 1/5 — date ===\n" +
        "real output\n" +
        "=== ✅ Iteration 1 complete ===\n"
      );
      const s = parseRalphLog(tmpDir)!;
      // "bin:" line also passes the filter — it's not in the skip list
      expect(s.lastOutput).toContain("real output");
      expect(s.lastOutput).not.toContain("===");
    });

    test("skips header metadata lines", () => {
      writeLog(logHeader() + "task output here\n");
      const s = parseRalphLog(tmpDir)!;
      // header lines (agent:, plan:, progress:, started:, pid:, 🥋) are filtered
      // only "task output here" and "bin: ..." remain
      expect(s.lastOutput).toContain("task output here");
      expect(s.lastOutput).not.toContain("agent:");
      expect(s.lastOutput).not.toContain("plan:");
    });

    test("skips blank lines", () => {
      writeLog(logHeader() + "\n\n\nonly this\n\n\n");
      const s = parseRalphLog(tmpDir)!;
      expect(s.lastOutput).toContain("only this");
    });
  });

  // ── Finished timestamp ──

  describe("finished timestamp", () => {
    test("parses finished line", () => {
      const ts = "Wed Feb 05 2025 16:00:00 GMT-0500";
      writeLog(logHeader() + `finished: ${ts}\n`);
      const s = parseRalphLog(tmpDir)!;
      expect(s.finished).toBe(ts);
    });

    test("finished is empty when not present", () => {
      writeLog(logHeader());
      const s = parseRalphLog(tmpDir)!;
      expect(s.finished).toBe("");
    });
  });

  // ── Edge cases ──

  describe("edge cases", () => {
    test("empty log file returns defaults", () => {
      writeLog("");
      const s = parseRalphLog(tmpDir)!;
      expect(s.iteration).toBe(0);
      expect(s.totalIterations).toBe(0);
      expect(s.agent).toBe("");
      expect(s.active).toBe(false);
      expect(s.completed).toBe(false);
    });

    test("malformed header lines are ignored gracefully", () => {
      writeLog("🥋 ralph — iterations\nagent:\npid: notanumber\nstarted:\n");
      const s = parseRalphLog(tmpDir)!;
      expect(s.agent).toBe("");
      expect(s.pid).toBe(0); // regex /\d+/ doesn't match "notanumber" — pid stays default 0
      expect(s.started).toBe("");
    });

    test("handles log with only header (no iterations)", () => {
      writeLog(logHeader({ iterations: 10, agent: "codex", plan: "P.md", progress: "p.txt" }));
      writePlan("P.md", "- [ ] task 1\n- [ ] task 2\n");
      const s = parseRalphLog(tmpDir)!;
      expect(s.totalIterations).toBe(10);
      expect(s.iteration).toBe(0);
      expect(s.agent).toBe("codex");
      expect(s.planFile).toBe("P.md");
      expect(s.progressFile).toBe("p.txt");
      expect(s.tasksDone).toBe(0);
      expect(s.tasksTotal).toBe(2);
    });

    test("realistic full lifecycle log", () => {
      const DEAD_PID = 2147483647;
      writeLog(
        logHeader({ pid: DEAD_PID, iterations: 3, plan: "PLAN.md", agent: "claude" }) +
        "\n=== 🥋 Wax On 1/3 — Mon Jan 01 2024 12:01:00 ===\n" +
        "task: implement feature A\n" +
        "working on feature A...\n" +
        "done with feature A\n" +
        "\n=== ✅ Iteration 1 complete — Mon Jan 01 2024 12:10:00 ===\n" +
        "\n=== 🥋 Wax On 2/3 — Mon Jan 01 2024 12:11:00 ===\n" +
        "task: implement feature B\n" +
        "working on feature B...\n" +
        "done with feature B\n" +
        "\n=== ✅ Iteration 2 complete — Mon Jan 01 2024 12:20:00 ===\n" +
        "\n=== 🥋 Wax Off — starting cleanup — Mon Jan 01 2024 12:21:00 ===\n" +
        "cleaning up dead code\n" +
        "\n=== ✅ Wax Off complete — Mon Jan 01 2024 12:25:00 ===\n" +
        "finished: Mon Jan 01 2024 12:25:00 GMT-0500\n"
      );
      writePlan("PLAN.md", "- [x] implement feature A\n- [x] implement feature B\n");
      const s = parseRalphLog(tmpDir)!;
      expect(s.active).toBe(false);
      expect(s.completed).toBe(true);
      expect(s.cleanup).toBe(false);
      expect(s.iteration).toBe(2);
      expect(s.totalIterations).toBe(3);
      expect(s.tasksDone).toBe(2);
      expect(s.tasksTotal).toBe(2);
      expect(s.finished).toBe("Mon Jan 01 2024 12:25:00 GMT-0500");
      expect(s.agent).toBe("claude");
    });
  });
});
