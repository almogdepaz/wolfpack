import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TaskDAG, TaskNode, Wave } from "../../../src/kobra-kai/types.ts";
import {
  cleanupWaveWorktrees,
  createTaskWorktree,
  createWaveWorktrees,
  listProjectWorktrees,
  removeTaskWorktree,
} from "../../../src/kobra-kai/worktree.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "wt-test-"));
  const spawn = (args: string[]) =>
    Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" }).exited;

  await spawn(["init", "-b", "main"]);
  await spawn(["config", "user.email", "test@test.com"]);
  await spawn(["config", "user.name", "Test"]);
  await writeFile(join(dir, "README.md"), "# test\n");
  await spawn(["add", "."]);
  await spawn(["commit", "-m", "initial"]);

  return dir;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let projectDir: string;

beforeEach(async () => {
  projectDir = await makeTempRepo();
});

afterEach(async () => {
  // Clean up any leftover worktrees before removing the dir
  try {
    const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const paths = output
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length))
      .filter((p) => p !== projectDir);

    for (const p of paths) {
      await Bun.spawn(["git", "worktree", "remove", "--force", p], {
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
    }
  } catch {
    // best-effort cleanup
  }

  await rm(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// createTaskWorktree
// ---------------------------------------------------------------------------

describe("createTaskWorktree", () => {
  test("creates worktree dir and branch", async () => {
    const projectName = basename(projectDir);
    const wtPath = await createTaskWorktree(projectDir, "t1", "main");

    expect(wtPath).toContain(`${projectName}-wt-t1`);
    expect(existsSync(wtPath)).toBe(true);
    // README should be checked out in the worktree
    expect(existsSync(join(wtPath, "README.md"))).toBe(true);
  });

  test("branch is based on the specified base branch", async () => {
    const projectName = basename(projectDir);
    const wtPath = await createTaskWorktree(projectDir, "t2", "main");

    // The new branch should point to the same commit as main
    const mainSha = await gitSha(projectDir, "main");
    const branchSha = await gitSha(projectDir, `wt/${projectName}/t2`);
    expect(branchSha).toBe(mainSha);

    // cleanup for afterEach
    await rm(wtPath, { recursive: true, force: true });
  });

  test("branch name follows convention wt/{project}/{taskId}", async () => {
    const projectName = basename(projectDir);
    await createTaskWorktree(projectDir, "abc", "main");

    const branches = await gitBranches(projectDir);
    expect(branches).toContain(`wt/${projectName}/abc`);
  });
});

// ---------------------------------------------------------------------------
// removeTaskWorktree
// ---------------------------------------------------------------------------

describe("removeTaskWorktree", () => {
  test("removes worktree dir and branch", async () => {
    const projectName = basename(projectDir);
    const branch = `wt/${projectName}/rm1`;
    const wtPath = await createTaskWorktree(projectDir, "rm1", "main");

    expect(existsSync(wtPath)).toBe(true);

    await removeTaskWorktree(projectDir, wtPath, branch);

    expect(existsSync(wtPath)).toBe(false);
    const branches = await gitBranches(projectDir);
    expect(branches).not.toContain(branch);
  });

  test("does not throw if already removed", async () => {
    const projectName = basename(projectDir);
    const branch = `wt/${projectName}/gone`;
    const wtPath = join(projectDir, "..", `${projectName}-wt-gone`);

    // never created — should not throw
    await removeTaskWorktree(projectDir, wtPath, branch);
  });
});

// ---------------------------------------------------------------------------
// createWaveWorktrees
// ---------------------------------------------------------------------------

describe("createWaveWorktrees", () => {
  test("creates worktrees for all tasks in wave and sets task fields", async () => {
    const projectName = basename(projectDir);
    const dag = makeDAG([makeTask("a"), makeTask("b")]);
    dag.tasks[0].wave = 0;
    dag.tasks[1].wave = 0;

    const wave: Wave = { wave: 0, task_ids: ["a", "b"], status: "pending" };

    await createWaveWorktrees(projectDir, wave, dag);

    for (const task of dag.tasks) {
      expect(task.worktree_path).toBeDefined();
      expect(existsSync(task.worktree_path!)).toBe(true);
      expect(task.branch).toBe(`wt/${projectName}/${task.id}`);
    }
  });

  test("wave 0 uses main as base branch", async () => {
    const projectName = basename(projectDir);
    const dag = makeDAG([makeTask("w0")]);
    dag.tasks[0].wave = 0;

    const wave: Wave = { wave: 0, task_ids: ["w0"], status: "pending" };
    await createWaveWorktrees(projectDir, wave, dag);

    const mainSha = await gitSha(projectDir, "main");
    const branchSha = await gitSha(projectDir, `wt/${projectName}/w0`);
    expect(branchSha).toBe(mainSha);
  });

  test("wave N uses integration branch as base", async () => {
    const projectName = basename(projectDir);

    // Create the integration branch that wave 1 would base on
    const integrationBranch = `integrate/${projectName}/wave-0`;
    await Bun.spawn(["git", "branch", integrationBranch], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;

    const dag = makeDAG([makeTask("w1")]);
    dag.tasks[0].wave = 1;

    const wave: Wave = { wave: 1, task_ids: ["w1"], status: "pending" };
    await createWaveWorktrees(projectDir, wave, dag);

    const integrationSha = await gitSha(projectDir, integrationBranch);
    const branchSha = await gitSha(projectDir, `wt/${projectName}/w1`);
    expect(branchSha).toBe(integrationSha);
  });
});

// ---------------------------------------------------------------------------
// cleanupWaveWorktrees
// ---------------------------------------------------------------------------

describe("cleanupWaveWorktrees", () => {
  test("removes all worktrees and branches for a wave", async () => {
    const projectName = basename(projectDir);
    const dag = makeDAG([makeTask("c1"), makeTask("c2")]);
    dag.tasks[0].wave = 0;
    dag.tasks[1].wave = 0;

    const wave: Wave = { wave: 0, task_ids: ["c1", "c2"], status: "pending" };
    await createWaveWorktrees(projectDir, wave, dag);

    // Verify they exist
    for (const task of dag.tasks) {
      expect(existsSync(task.worktree_path!)).toBe(true);
    }

    await cleanupWaveWorktrees(projectDir, wave, dag);

    for (const task of dag.tasks) {
      expect(existsSync(task.worktree_path!)).toBe(false);
    }

    const branches = await gitBranches(projectDir);
    expect(branches).not.toContain(`wt/${projectName}/c1`);
    expect(branches).not.toContain(`wt/${projectName}/c2`);
  });

  test("skips tasks without worktree_path", async () => {
    const dag = makeDAG([makeTask("x")]);
    dag.tasks[0].wave = 0;
    // worktree_path is undefined — should not throw
    const wave: Wave = { wave: 0, task_ids: ["x"], status: "pending" };
    await cleanupWaveWorktrees(projectDir, wave, dag);
  });
});

// ---------------------------------------------------------------------------
// listProjectWorktrees
// ---------------------------------------------------------------------------

describe("listProjectWorktrees", () => {
  test("returns only worktree paths containing -wt-", async () => {
    await createTaskWorktree(projectDir, "list1", "main");
    await createTaskWorktree(projectDir, "list2", "main");

    const worktrees = await listProjectWorktrees(projectDir);

    expect(worktrees).toHaveLength(2);
    expect(worktrees.every((p) => p.includes("-wt-"))).toBe(true);
  });

  test("does not include the main worktree", async () => {
    const worktrees = await listProjectWorktrees(projectDir);
    expect(worktrees).toHaveLength(0);
  });

  test("filters out non-wt worktrees", async () => {
    // Create a normal worktree (not from our manager)
    const otherPath = join(projectDir, "..", `${basename(projectDir)}-other`);
    await Bun.spawn(["git", "worktree", "add", otherPath, "-b", "other-branch", "main"], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;

    await createTaskWorktree(projectDir, "real1", "main");

    const worktrees = await listProjectWorktrees(projectDir);
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toContain("-wt-real1");

    // cleanup the extra worktree
    await Bun.spawn(["git", "worktree", "remove", "--force", otherPath], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
  });
});

// ---------------------------------------------------------------------------
// Helpers (git queries)
// ---------------------------------------------------------------------------

async function gitSha(dir: string, ref: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", ref], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  return out.trim();
}

async function gitBranches(dir: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "branch", "--list", "--format=%(refname:short)"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  return out
    .trim()
    .split("\n")
    .filter((b) => b.length > 0);
}
