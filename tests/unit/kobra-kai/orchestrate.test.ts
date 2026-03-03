import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  TaskDAG,
  TaskNode,
} from "../../../src/kobra-kai/types.ts";
import {
  countTasksInContent,
  gatherProjectContext,
  launchOrchestration,
  advanceOrchestration,
  getOrchestrationStatus,
  cancelOrchestration,
  spawnWaveTasks,
  _getActiveOrchestrations,
} from "../../../src/kobra-kai/orchestrate.ts";
import { saveDAG } from "../../../src/kobra-kai/planner.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(
  id: string,
  deps: string[] = [],
  files: string[] = [],
): TaskNode {
  return {
    id,
    title: `Task ${id}`,
    description: `Do task ${id}`,
    depends_on: deps,
    estimated_files: files,
    wave: -1,
    status: "pending",
  };
}

function makeDAG(tasks: TaskNode[], project = "test"): TaskDAG {
  return {
    tasks,
    waves: [],
    metadata: {
      project,
      created_at: new Date().toISOString(),
      source: "decomposed",
    },
  };
}

/** Create a temp git repo with an initial commit on `main`. */
async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orch-test-"));
  const spawn = (args: string[]) =>
    Bun.spawn(["git", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;

  await spawn(["init", "-b", "main"]);
  await spawn(["config", "user.email", "test@test.com"]);
  await spawn(["config", "user.name", "Test"]);
  await writeFile(join(dir, "README.md"), "# test\n");
  await spawn(["add", "."]);
  await spawn(["commit", "-m", "initial"]);

  return dir;
}

async function cleanupWorktrees(dir: string): Promise<void> {
  try {
    const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const paths = output
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length))
      .filter((p) => p !== dir);

    for (const p of paths) {
      await Bun.spawn(["git", "worktree", "remove", "--force", p], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
    }
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// countTasksInContent
// ---------------------------------------------------------------------------

describe("countTasksInContent", () => {
  test("counts unchecked checkboxes", () => {
    const content = "# Plan\n- [ ] Task A\n- [ ] Task B\n";
    const { total, completed } = countTasksInContent(content);
    expect(total).toBe(2);
    expect(completed).toBe(0);
  });

  test("counts checked checkboxes", () => {
    const content = "# Plan\n- [x] Task A\n- [x] Task B\n";
    const { total, completed } = countTasksInContent(content);
    expect(total).toBe(2);
    expect(completed).toBe(2);
  });

  test("counts mixed checkboxes", () => {
    const content = "# Plan\n- [x] Task A\n- [ ] Task B\n- [x] Task C\n";
    const { total, completed } = countTasksInContent(content);
    expect(total).toBe(3);
    expect(completed).toBe(2);
  });

  test("counts section headers as tasks", () => {
    const content =
      "## 1. First task\ndetails\n\n## ~~2. Second task~~\ndetails\n";
    const { total, completed } = countTasksInContent(content);
    expect(total).toBe(2);
    expect(completed).toBe(1);
  });

  test("returns zero for empty content", () => {
    const { total, completed } = countTasksInContent("");
    expect(total).toBe(0);
    expect(completed).toBe(0);
  });

  test("all done when every task is checked/struck", () => {
    const content = "- [x] A\n- [x] B\n## ~~1. Done~~\n";
    const { total, completed } = countTasksInContent(content);
    expect(total).toBe(3);
    expect(completed).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// gatherProjectContext
// ---------------------------------------------------------------------------

describe("gatherProjectContext", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTempRepo();
  });

  afterEach(async () => {
    await cleanupWorktrees(projectDir);
    await rm(projectDir, { recursive: true, force: true });
  });

  test("returns file tree and git log", async () => {
    const ctx = await gatherProjectContext(projectDir);
    expect(ctx).toContain("File tree:");
    expect(ctx).toContain("Recent commits:");
    expect(ctx).toContain("initial");
    expect(ctx).toContain("README.md");
  });

  test("includes package.json summary when present", async () => {
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({
        name: "test-project",
        scripts: { test: "bun test" },
        dependencies: { foo: "1.0.0" },
        devDependencies: { bar: "2.0.0" },
      }),
    );
    await Bun.spawn(["git", "add", "."], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    await Bun.spawn(["git", "commit", "-m", "add pkg"], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;

    const ctx = await gatherProjectContext(projectDir);
    expect(ctx).toContain("package.json:");
    expect(ctx).toContain("test-project");
    expect(ctx).toContain("bun test");
    // devDependencies should NOT be included (only name, scripts, dependencies)
    expect(ctx).not.toContain("devDependencies");
    expect(ctx).not.toContain("bar");
  });

  test("excludes -wt- paths from file tree", async () => {
    // gatherProjectContext uses find with -not -path '*-wt-*'
    // The actual filtering happens at the find command level
    const ctx = await gatherProjectContext(projectDir);
    expect(ctx).not.toMatch(/-wt-/);
  });
});

// ---------------------------------------------------------------------------
// launchOrchestration
// ---------------------------------------------------------------------------

describe("launchOrchestration", () => {
  let projectDir: string;
  let originalSpawn: typeof Bun.spawn;

  beforeEach(async () => {
    projectDir = await makeTempRepo();
    originalSpawn = Bun.spawn;
  });

  afterEach(async () => {
    (Bun as any).spawn = originalSpawn;
    _getActiveOrchestrations().delete(projectDir);
    await cleanupWorktrees(projectDir);
    await rm(projectDir, { recursive: true, force: true });
  });

  test("saves DAG and config, creates worktrees, spawns runners", async () => {
    const task1 = makeTask("1", [], ["a.ts"]);
    task1.wave = 0;
    const task2 = makeTask("2", [], ["b.ts"]);
    task2.wave = 0;

    const dag = makeDAG([task1, task2]);
    dag.waves = [
      { wave: 0, task_ids: ["1", "2"], status: "pending" },
    ];

    // Mock Bun.spawn to track calls and avoid real spawns for task runners
    const spawnCalls: any[] = [];
    (Bun as any).spawn = (...args: any[]) => {
      const cmd = args[0];
      // Let git commands through
      if (Array.isArray(cmd) && cmd[0] === "git") {
        return originalSpawn(...(args as Parameters<typeof Bun.spawn>));
      }
      // Let find commands through
      if (Array.isArray(cmd) && cmd[0] === "find") {
        return originalSpawn(...(args as Parameters<typeof Bun.spawn>));
      }
      // Track task runner spawns
      spawnCalls.push(cmd);
      return {
        pid: 99990 + spawnCalls.length,
        unref: () => {},
        exited: Promise.resolve(0),
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
      };
    };

    await launchOrchestration(projectDir, dag, 2);

    // DAG saved
    const dagFile = JSON.parse(
      await readFile(join(projectDir, "task-dag.json"), "utf-8"),
    );
    expect(dagFile.tasks).toHaveLength(2);

    // Config saved
    const config = JSON.parse(
      await readFile(join(projectDir, "task-dag-config.json"), "utf-8"),
    );
    expect(config.maxConcurrent).toBe(2);
    expect(config.startedAt).toBeDefined();

    // Worktrees created (task fields updated)
    expect(dag.tasks[0].worktree_path).toBeDefined();
    expect(dag.tasks[1].worktree_path).toBeDefined();

    // Task runners spawned
    expect(spawnCalls.length).toBe(2);
    expect(spawnCalls[0]).toContain("bun");

    // Tasks marked in_progress with PIDs
    expect(dag.tasks[0].status).toBe("in_progress");
    expect(dag.tasks[1].status).toBe("in_progress");
    expect(dag.tasks[0].pid).toBeDefined();
    expect(dag.tasks[1].pid).toBeDefined();

    // Wave status updated
    expect(dag.waves[0].status).toBe("in_progress");

    // Registered in active set
    expect(_getActiveOrchestrations().has(projectDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// advanceOrchestration
// ---------------------------------------------------------------------------

describe("advanceOrchestration", () => {
  let projectDir: string;
  let originalSpawn: typeof Bun.spawn;
  let originalKill: typeof process.kill;

  beforeEach(async () => {
    projectDir = await makeTempRepo();
    originalSpawn = Bun.spawn;
    originalKill = process.kill;
  });

  afterEach(async () => {
    (Bun as any).spawn = originalSpawn;
    (process as any).kill = originalKill;
    _getActiveOrchestrations().delete(projectDir);
    await cleanupWorktrees(projectDir);
    await rm(projectDir, { recursive: true, force: true });
  });

  function setupMocks(opts: {
    alivePids?: Set<number>;
    spawnPid?: number;
  } = {}) {
    const { alivePids = new Set(), spawnPid = 88888 } = opts;
    let spawnCount = 0;

    // Mock process.kill for PID checking
    (process as any).kill = (pid: number, signal: any) => {
      if (signal === 0) {
        if (alivePids.has(pid)) return true;
        throw new Error("ESRCH");
      }
      // For actual SIGTERM etc.
      return originalKill.call(process, pid, signal);
    };

    // Mock Bun.spawn to pass through git/find and mock task runners
    const spawnCalls: any[] = [];
    (Bun as any).spawn = (...args: any[]) => {
      const cmd = args[0];
      if (Array.isArray(cmd) && (cmd[0] === "git" || cmd[0] === "find")) {
        return originalSpawn(...(args as Parameters<typeof Bun.spawn>));
      }
      spawnCount++;
      spawnCalls.push(cmd);
      return {
        pid: spawnPid + spawnCount,
        unref: () => {},
        exited: Promise.resolve(0),
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
      };
    };

    return { spawnCalls };
  }

  test("detects dead PIDs and marks completed when all plan tasks done", async () => {
    const task = makeTask("1", [], ["a.ts"]);
    task.wave = 0;
    task.status = "in_progress";
    task.pid = 12345;
    task.branch = `wt/${basename(projectDir)}/1`;

    const dag = makeDAG([task]);
    dag.waves = [{ wave: 0, task_ids: ["1"], status: "in_progress" }];

    // Create worktree for the task
    const projectName = basename(projectDir);
    const wtPath = join(projectDir, "..", `${projectName}-wt-1`);
    await Bun.spawn(
      ["git", "worktree", "add", wtPath, "-b", `wt/${projectName}/1`, "main"],
      { cwd: projectDir, stdout: "pipe", stderr: "pipe" },
    ).exited;
    task.worktree_path = wtPath;

    // Write completed PLAN.md
    await writeFile(join(wtPath, "PLAN.md"), "- [x] Task 1\n");

    await saveDAG(projectDir, dag);
    await writeFile(
      join(projectDir, "task-dag-config.json"),
      JSON.stringify({ maxConcurrent: 2 }),
    );

    // PID 12345 is dead
    setupMocks({ alivePids: new Set() });

    const result = await advanceOrchestration(projectDir);

    // Task completed → merge → all done
    const updatedDag = JSON.parse(
      await readFile(join(projectDir, "task-dag.json"), "utf-8"),
    );
    expect(updatedDag.tasks[0].status).toBe("completed");
  });

  test("detects dead PIDs and marks failed when plan incomplete", async () => {
    const task = makeTask("1", [], ["a.ts"]);
    task.wave = 0;
    task.status = "in_progress";
    task.pid = 12345;
    task.branch = `wt/${basename(projectDir)}/1`;

    const dag = makeDAG([task]);
    dag.waves = [{ wave: 0, task_ids: ["1"], status: "in_progress" }];

    const projectName = basename(projectDir);
    const wtPath = join(projectDir, "..", `${projectName}-wt-1`);
    await Bun.spawn(
      ["git", "worktree", "add", wtPath, "-b", `wt/${projectName}/1`, "main"],
      { cwd: projectDir, stdout: "pipe", stderr: "pipe" },
    ).exited;
    task.worktree_path = wtPath;

    // Write incomplete PLAN.md
    await writeFile(join(wtPath, "PLAN.md"), "- [x] Done task\n- [ ] Undone task\n");

    await saveDAG(projectDir, dag);
    await writeFile(
      join(projectDir, "task-dag-config.json"),
      JSON.stringify({ maxConcurrent: 2 }),
    );

    setupMocks({ alivePids: new Set() });

    const result = await advanceOrchestration(projectDir);
    expect(result).toBe("failed");

    const updatedDag = JSON.parse(
      await readFile(join(projectDir, "task-dag.json"), "utf-8"),
    );
    expect(updatedDag.tasks[0].status).toBe("failed");
  });

  test("spawns queued tasks when slots open", async () => {
    const task1 = makeTask("1", [], ["a.ts"]);
    task1.wave = 0;
    task1.status = "in_progress";
    task1.pid = 11111;
    const task2 = makeTask("2", [], ["b.ts"]);
    task2.wave = 0;
    task2.status = "pending"; // queued

    const dag = makeDAG([task1, task2]);
    dag.waves = [{ wave: 0, task_ids: ["1", "2"], status: "in_progress" }];

    const projectName = basename(projectDir);
    // Create worktrees for both
    for (const t of dag.tasks) {
      const wtPath = join(projectDir, "..", `${projectName}-wt-${t.id}`);
      await Bun.spawn(
        ["git", "worktree", "add", wtPath, "-b", `wt/${projectName}/${t.id}`, "main"],
        { cwd: projectDir, stdout: "pipe", stderr: "pipe" },
      ).exited;
      t.worktree_path = wtPath;
      t.branch = `wt/${projectName}/${t.id}`;
    }

    await saveDAG(projectDir, dag);
    await writeFile(
      join(projectDir, "task-dag-config.json"),
      JSON.stringify({ maxConcurrent: 2 }),
    );

    // PID 11111 is alive, task2 is pending, and maxConcurrent=2 (slot available)
    const { spawnCalls } = setupMocks({ alivePids: new Set([11111]) });

    const result = await advanceOrchestration(projectDir);
    expect(result).toBe("spawned");
    expect(spawnCalls.length).toBe(1); // spawned 1 queued task
  });

  test("returns waiting when agents still running", async () => {
    const task = makeTask("1", [], ["a.ts"]);
    task.wave = 0;
    task.status = "in_progress";
    task.pid = 11111;

    const dag = makeDAG([task]);
    dag.waves = [{ wave: 0, task_ids: ["1"], status: "in_progress" }];

    const projectName = basename(projectDir);
    const wtPath = join(projectDir, "..", `${projectName}-wt-1`);
    await Bun.spawn(
      ["git", "worktree", "add", wtPath, "-b", `wt/${projectName}/1`, "main"],
      { cwd: projectDir, stdout: "pipe", stderr: "pipe" },
    ).exited;
    task.worktree_path = wtPath;
    task.branch = `wt/${projectName}/1`;

    await saveDAG(projectDir, dag);
    await writeFile(
      join(projectDir, "task-dag-config.json"),
      JSON.stringify({ maxConcurrent: 2 }),
    );

    // PID alive
    setupMocks({ alivePids: new Set([11111]) });

    const result = await advanceOrchestration(projectDir);
    expect(result).toBe("waiting");
  });

  test("triggers merge when wave done (single wave → completed)", async () => {
    const projectName = basename(projectDir);
    const task1 = makeTask("1", [], ["a.ts"]);
    task1.wave = 0;
    task1.status = "in_progress";
    task1.pid = 12345;

    const dag = makeDAG([task1], projectName);
    dag.waves = [
      { wave: 0, task_ids: ["1"], status: "in_progress" },
    ];

    const wtPath = join(projectDir, "..", `${projectName}-wt-1`);
    await Bun.spawn(
      ["git", "worktree", "add", wtPath, "-b", `wt/${projectName}/1`, "main"],
      { cwd: projectDir, stdout: "pipe", stderr: "pipe" },
    ).exited;
    task1.worktree_path = wtPath;
    task1.branch = `wt/${projectName}/1`;

    // Make a commit in the worktree so merge has something
    await writeFile(join(wtPath, "a.ts"), "export const a = 1;\n");
    await Bun.spawn(["git", "add", "."], {
      cwd: wtPath,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    await Bun.spawn(["git", "commit", "-m", "task 1"], {
      cwd: wtPath,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;

    // Write completed PLAN.md
    await writeFile(join(wtPath, "PLAN.md"), "- [x] Task 1\n");

    await saveDAG(projectDir, dag);
    await writeFile(
      join(projectDir, "task-dag-config.json"),
      JSON.stringify({ maxConcurrent: 2 }),
    );

    // PID dead → task completed → merge → no next wave → completed
    setupMocks({ alivePids: new Set() });

    const result = await advanceOrchestration(projectDir);
    expect(result).toBe("completed");

    // Verify integration branch was created (merge happened)
    // Need to use originalSpawn since Bun.spawn is mocked
    const proc = originalSpawn(
      ["git", "branch", "--list", `integrate/${projectName}/wave-0`],
      { cwd: projectDir, stdout: "pipe", stderr: "pipe" },
    );
    const branches = await new Response(proc.stdout).text();
    expect(branches.trim()).toContain("wave-0");
  });

  test("advances to next wave after merge", async () => {
    const projectName = basename(projectDir);
    const task1 = makeTask("1", [], ["a.ts"]);
    task1.wave = 0;
    task1.status = "in_progress";
    task1.pid = 12345;
    const task2 = makeTask("2", ["1"], ["b.ts"]);
    task2.wave = 1;
    task2.status = "pending";

    const dag = makeDAG([task1, task2], projectName);
    dag.waves = [
      { wave: 0, task_ids: ["1"], status: "in_progress" },
      { wave: 1, task_ids: ["2"], status: "pending" },
    ];

    const wtPath = join(projectDir, "..", `${projectName}-wt-1`);
    await Bun.spawn(
      ["git", "worktree", "add", wtPath, "-b", `wt/${projectName}/1`, "main"],
      { cwd: projectDir, stdout: "pipe", stderr: "pipe" },
    ).exited;
    task1.worktree_path = wtPath;
    task1.branch = `wt/${projectName}/1`;

    // Commit in task 1 worktree
    await writeFile(join(wtPath, "a.ts"), "export const a = 1;\n");
    await Bun.spawn(["git", "add", "."], {
      cwd: wtPath,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    await Bun.spawn(["git", "commit", "-m", "task 1"], {
      cwd: wtPath,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;

    // Write completed PLAN.md
    await writeFile(join(wtPath, "PLAN.md"), "- [x] Task 1\n");

    await saveDAG(projectDir, dag);
    await writeFile(
      join(projectDir, "task-dag-config.json"),
      JSON.stringify({ maxConcurrent: 2 }),
    );

    // PID dead → completed → merge wave 0 → advance to wave 1
    const { spawnCalls } = setupMocks({ alivePids: new Set() });

    const result = await advanceOrchestration(projectDir);
    expect(result).toBe("advanced");

    // Task runner was spawned for wave 1
    expect(spawnCalls.length).toBeGreaterThan(0);
  });

  test("returns completed when all waves done", async () => {
    const task = makeTask("1", [], ["a.ts"]);
    task.wave = 0;
    task.status = "completed";

    const dag = makeDAG([task]);
    dag.waves = [{ wave: 0, task_ids: ["1"], status: "merged" }];

    await saveDAG(projectDir, dag);
    await writeFile(
      join(projectDir, "task-dag-config.json"),
      JSON.stringify({ maxConcurrent: 2 }),
    );

    setupMocks();

    const result = await advanceOrchestration(projectDir);
    expect(result).toBe("completed");
  });

  test("concurrency: 5 tasks, maxConcurrent=2 → only 2 spawn initially", async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => {
      const t = makeTask(String(i + 1), [], [`file${i + 1}.ts`]);
      t.wave = 0;
      return t;
    });

    const dag = makeDAG(tasks);
    dag.waves = [
      {
        wave: 0,
        task_ids: tasks.map((t) => t.id),
        status: "pending",
      },
    ];

    const projectName = basename(projectDir);
    // Create worktrees for all 5
    for (const t of dag.tasks) {
      const wtPath = join(projectDir, "..", `${projectName}-wt-${t.id}`);
      await Bun.spawn(
        ["git", "worktree", "add", wtPath, "-b", `wt/${projectName}/${t.id}`, "main"],
        { cwd: projectDir, stdout: "pipe", stderr: "pipe" },
      ).exited;
      t.worktree_path = wtPath;
      t.branch = `wt/${projectName}/${t.id}`;
    }

    const { spawnCalls } = setupMocks();

    // spawnWaveTasks with maxConcurrent=2
    await spawnWaveTasks(projectDir, dag.waves[0], dag, 2);

    // Only 2 spawned
    expect(spawnCalls.length).toBe(2);

    // First 2 tasks are in_progress with PIDs
    expect(dag.tasks[0].status).toBe("in_progress");
    expect(dag.tasks[0].pid).toBeDefined();
    expect(dag.tasks[1].status).toBe("in_progress");
    expect(dag.tasks[1].pid).toBeDefined();

    // Remaining 3 are still pending
    expect(dag.tasks[2].status).toBe("pending");
    expect(dag.tasks[3].status).toBe("pending");
    expect(dag.tasks[4].status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// cancelOrchestration
// ---------------------------------------------------------------------------

describe("cancelOrchestration", () => {
  let projectDir: string;
  let originalKill: typeof process.kill;

  beforeEach(async () => {
    projectDir = await makeTempRepo();
    originalKill = process.kill;
  });

  afterEach(async () => {
    (process as any).kill = originalKill;
    _getActiveOrchestrations().delete(projectDir);
    await cleanupWorktrees(projectDir);
    await rm(projectDir, { recursive: true, force: true });
  });

  test("kills PIDs, cleans worktrees, saves DAG", async () => {
    const killedPids: number[] = [];
    (process as any).kill = (pid: number, signal: any) => {
      killedPids.push(pid);
    };

    const task = makeTask("1", [], ["a.ts"]);
    task.wave = 0;
    task.status = "in_progress";
    task.pid = 55555;

    const dag = makeDAG([task]);
    dag.waves = [{ wave: 0, task_ids: ["1"], status: "in_progress" }];

    const projectName = basename(projectDir);
    const wtPath = join(projectDir, "..", `${projectName}-wt-1`);
    await Bun.spawn(
      ["git", "worktree", "add", wtPath, "-b", `wt/${projectName}/1`, "main"],
      { cwd: projectDir, stdout: "pipe", stderr: "pipe" },
    ).exited;
    task.worktree_path = wtPath;
    task.branch = `wt/${projectName}/1`;

    await saveDAG(projectDir, dag);
    _getActiveOrchestrations().add(projectDir);

    await cancelOrchestration(projectDir);

    // PID was killed
    expect(killedPids).toContain(55555);

    // Task marked failed
    const updatedDag = JSON.parse(
      await readFile(join(projectDir, "task-dag.json"), "utf-8"),
    );
    expect(updatedDag.tasks[0].status).toBe("failed");

    // Worktree cleaned up
    expect(existsSync(wtPath)).toBe(false);

    // Removed from active set
    expect(_getActiveOrchestrations().has(projectDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getOrchestrationStatus
// ---------------------------------------------------------------------------

describe("getOrchestrationStatus", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTempRepo();
  });

  afterEach(async () => {
    await cleanupWorktrees(projectDir);
    await rm(projectDir, { recursive: true, force: true });
  });

  test("returns idle when no DAG exists", async () => {
    const status = await getOrchestrationStatus(projectDir);
    expect(status.status).toBe("idle");
    expect(status.totalWaves).toBe(0);
    expect(status.tasks).toHaveLength(0);
  });

  test("returns active status with correct counts", async () => {
    const task1 = makeTask("1");
    task1.wave = 0;
    task1.status = "in_progress";
    const task2 = makeTask("2");
    task2.wave = 0;
    task2.status = "pending";

    const dag = makeDAG([task1, task2]);
    dag.waves = [{ wave: 0, task_ids: ["1", "2"], status: "in_progress" }];

    await saveDAG(projectDir, dag);
    await writeFile(
      join(projectDir, "task-dag-config.json"),
      JSON.stringify({ maxConcurrent: 3, startedAt: "2026-01-01T00:00:00Z" }),
    );

    const status = await getOrchestrationStatus(projectDir);
    expect(status.status).toBe("active");
    expect(status.activeAgents).toBe(1);
    expect(status.queuedTasks).toBe(1);
    expect(status.maxConcurrent).toBe(3);
    expect(status.startedAt).toBe("2026-01-01T00:00:00Z");
    expect(status.totalWaves).toBe(1);
  });

  test("returns completed when all waves merged", async () => {
    const task = makeTask("1");
    task.wave = 0;
    task.status = "completed";

    const dag = makeDAG([task]);
    dag.waves = [{ wave: 0, task_ids: ["1"], status: "merged" }];

    await saveDAG(projectDir, dag);

    const status = await getOrchestrationStatus(projectDir);
    expect(status.status).toBe("completed");
  });
});
