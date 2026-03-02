import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TaskDAG, TaskNode, Wave } from "../../../src/kobra-kai/types.ts";
import { jsonMerge, mergeWave } from "../../../src/kobra-kai/merge.ts";

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
    wave: 0,
    status: "completed",
  };
}

function makeDAG(tasks: TaskNode[], project?: string): TaskDAG {
  return {
    tasks,
    waves: [],
    metadata: {
      project: project ?? "test",
      created_at: new Date().toISOString(),
      source: "decomposed",
    },
  };
}

async function spawn(dir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "merge-test-"));
  await spawn(dir, ["init", "-b", "main"]);
  await spawn(dir, ["config", "user.email", "test@test.com"]);
  await spawn(dir, ["config", "user.name", "Test"]);
  await writeFile(join(dir, "README.md"), "# test\n");
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({ version: 1, name: "test" }, null, 2) + "\n",
  );
  await spawn(dir, ["add", "."]);
  await spawn(dir, ["commit", "-m", "initial"]);
  return dir;
}

/** Create a branch off baseBranch with file changes, then checkout back. */
async function createBranchWithChanges(
  dir: string,
  branchName: string,
  baseBranch: string,
  changes: Record<string, string>,
): Promise<void> {
  await spawn(dir, ["checkout", "-b", branchName, baseBranch]);
  for (const [file, content] of Object.entries(changes)) {
    await writeFile(join(dir, file), content);
  }
  await spawn(dir, ["add", "."]);
  await spawn(dir, ["commit", "-m", `changes on ${branchName}`]);
  await spawn(dir, ["checkout", baseBranch]);
}

async function gitBranches(dir: string): Promise<string[]> {
  const out = await spawn(dir, [
    "branch",
    "--list",
    "--format=%(refname:short)",
  ]);
  return out
    .split("\n")
    .filter((b) => b.length > 0);
}

async function currentBranch(dir: string): Promise<string> {
  return spawn(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let projectDir: string;

beforeEach(async () => {
  projectDir = await makeTempRepo();
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// jsonMerge — unit tests
// ---------------------------------------------------------------------------

describe("jsonMerge", () => {
  test("objects: union of keys, recurse shared", () => {
    const base = { a: 1, b: 2 };
    const ours = { a: 10, b: 2, c: 3 };
    const theirs = { a: 1, b: 20, d: 4 };
    const result = jsonMerge(base, ours, theirs);
    expect(result).toEqual({ a: 1, b: 20, c: 3, d: 4 });
  });

  test("arrays: concatenate and deduplicate primitives", () => {
    const result = jsonMerge([], [1, 2, 3], [3, 4, 5]);
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  test("arrays: keeps duplicate objects", () => {
    const result = jsonMerge([], [{ a: 1 }], [{ a: 1 }]);
    expect(result).toEqual([{ a: 1 }, { a: 1 }]);
  });

  test("scalars: take theirs", () => {
    expect(jsonMerge(1, 2, 3)).toBe(3);
    expect(jsonMerge("a", "b", "c")).toBe("c");
    expect(jsonMerge(true, true, false)).toBe(false);
  });

  test("nested objects", () => {
    const base = { nested: { x: 1, y: 2 } };
    const ours = { nested: { x: 10, y: 2, z: 3 } };
    const theirs = { nested: { x: 1, y: 20 } };
    const result = jsonMerge(base, ours, theirs);
    expect(result).toEqual({ nested: { x: 1, y: 20, z: 3 } });
  });

  test("type mismatch: take theirs", () => {
    expect(jsonMerge(1, "string", 42)).toBe(42);
    expect(jsonMerge(null, [1, 2], { a: 1 })).toEqual({ a: 1 });
  });

  test("array vs object mismatch: take theirs", () => {
    expect(jsonMerge([], [1, 2], { a: 1 })).toEqual({ a: 1 });
  });

  test("null values: take theirs", () => {
    expect(jsonMerge(null, null, null)).toBe(null);
    expect(jsonMerge(null, null, 42)).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// mergeWave
// ---------------------------------------------------------------------------

describe("mergeWave", () => {
  test("clean merge: two branches modifying different files", async () => {
    await createBranchWithChanges(projectDir, "task/a", "main", {
      "a.txt": "content a\n",
    });
    await createBranchWithChanges(projectDir, "task/b", "main", {
      "b.txt": "content b\n",
    });

    const dag = makeDAG([
      makeTask("a", [], ["a.txt"]),
      makeTask("b", [], ["b.txt"]),
    ]);
    dag.tasks[0].branch = "task/a";
    dag.tasks[1].branch = "task/b";

    const wave: Wave = {
      wave: 0,
      task_ids: ["a", "b"],
      status: "pending",
    };

    const result = await mergeWave(projectDir, wave, dag);

    expect(result.ok).toBe(true);
    expect(result.merged.sort()).toEqual(["a", "b"]);
    expect(result.conflicts).toHaveLength(0);
    expect(result.unexpectedFiles).toHaveLength(0);
  });

  test("JSON conflict resolution: two branches modifying same JSON", async () => {
    await createBranchWithChanges(projectDir, "task/j1", "main", {
      "config.json":
        JSON.stringify(
          { version: 2, name: "test", addedByJ1: true },
          null,
          2,
        ) + "\n",
    });
    await createBranchWithChanges(projectDir, "task/j2", "main", {
      "config.json":
        JSON.stringify(
          { version: 3, name: "test", addedByJ2: true },
          null,
          2,
        ) + "\n",
    });

    const dag = makeDAG([
      makeTask("j1", [], ["config.json"]),
      makeTask("j2", [], ["config.json"]),
    ]);
    dag.tasks[0].branch = "task/j1";
    dag.tasks[1].branch = "task/j2";

    const wave: Wave = {
      wave: 0,
      task_ids: ["j1", "j2"],
      status: "pending",
    };

    const result = await mergeWave(projectDir, wave, dag);

    expect(result.ok).toBe(true);
    expect(result.merged.sort()).toEqual(["j1", "j2"]);
    expect(result.conflicts).toHaveLength(0);

    // Verify merged content on integration branch
    await spawn(projectDir, ["checkout", result.integrationBranch]);
    const content = JSON.parse(
      await readFile(join(projectDir, "config.json"), "utf-8"),
    );
    expect(content.addedByJ1).toBe(true);
    expect(content.addedByJ2).toBe(true);
    // theirs wins for shared scalar keys
    expect(content.version).toBe(3);
    await spawn(projectDir, ["checkout", "main"]);
  });

  test("non-JSON conflict: reported and merge aborted", async () => {
    await createBranchWithChanges(projectDir, "task/c1", "main", {
      "README.md": "# changed by c1\n",
    });
    await createBranchWithChanges(projectDir, "task/c2", "main", {
      "README.md": "# changed by c2\n",
    });

    const dag = makeDAG([
      makeTask("c1", [], ["README.md"]),
      makeTask("c2", [], ["README.md"]),
    ]);
    dag.tasks[0].branch = "task/c1";
    dag.tasks[1].branch = "task/c2";

    const wave: Wave = {
      wave: 0,
      task_ids: ["c1", "c2"],
      status: "pending",
    };

    const result = await mergeWave(projectDir, wave, dag);

    // c1 merges clean, c2 conflicts
    expect(result.merged).toContain("c1");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].taskId).toBe("c2");
    expect(result.conflicts[0].files).toContain("README.md");
    expect(result.ok).toBe(false);
  });

  test("unexpected files: task modifies file not in estimated_files", async () => {
    await createBranchWithChanges(projectDir, "task/u1", "main", {
      "expected.txt": "expected\n",
      "surprise.txt": "surprise\n",
    });

    const dag = makeDAG([makeTask("u1", [], ["expected.txt"])]);
    dag.tasks[0].branch = "task/u1";

    const wave: Wave = {
      wave: 0,
      task_ids: ["u1"],
      status: "pending",
    };

    const result = await mergeWave(projectDir, wave, dag);

    expect(result.ok).toBe(true);
    expect(result.merged).toContain("u1");
    expect(result.unexpectedFiles).toHaveLength(1);
    expect(result.unexpectedFiles[0].taskId).toBe("u1");
    expect(result.unexpectedFiles[0].files).toContain("surprise.txt");
  });

  test("integration branch naming convention", async () => {
    await createBranchWithChanges(projectDir, "task/n1", "main", {
      "n.txt": "n\n",
    });

    const dag = makeDAG([makeTask("n1", [], ["n.txt"])], "myproject");
    dag.tasks[0].branch = "task/n1";

    const wave: Wave = {
      wave: 0,
      task_ids: ["n1"],
      status: "pending",
    };

    const result = await mergeWave(projectDir, wave, dag);

    expect(result.integrationBranch).toBe("integrate/myproject/wave-0");
    const branches = await gitBranches(projectDir);
    expect(branches).toContain("integrate/myproject/wave-0");
  });

  test("sets wave.integration_branch and wave.status on success", async () => {
    await createBranchWithChanges(projectDir, "task/s1", "main", {
      "s.txt": "s\n",
    });

    const dag = makeDAG([makeTask("s1", [], ["s.txt"])]);
    dag.tasks[0].branch = "task/s1";

    const wave: Wave = {
      wave: 0,
      task_ids: ["s1"],
      status: "pending",
    };

    await mergeWave(projectDir, wave, dag);

    expect(wave.integration_branch).toBe("integrate/test/wave-0");
    expect(wave.status).toBe("merged");
  });

  test("returns to base branch after merge", async () => {
    await createBranchWithChanges(projectDir, "task/r1", "main", {
      "r.txt": "r\n",
    });

    const dag = makeDAG([makeTask("r1", [], ["r.txt"])]);
    dag.tasks[0].branch = "task/r1";

    const wave: Wave = {
      wave: 0,
      task_ids: ["r1"],
      status: "pending",
    };

    await mergeWave(projectDir, wave, dag);

    const branch = await currentBranch(projectDir);
    expect(branch).toBe("main");
  });

  test("wave N uses previous integration branch as base", async () => {
    // Set up wave 0 first
    await createBranchWithChanges(projectDir, "task/w0", "main", {
      "w0.txt": "wave0\n",
    });

    const dag = makeDAG([
      makeTask("w0", [], ["w0.txt"]),
      makeTask("w1", [], ["w1.txt"]),
    ]);
    dag.tasks[0].wave = 0;
    dag.tasks[0].branch = "task/w0";
    dag.tasks[1].wave = 1;

    const wave0: Wave = {
      wave: 0,
      task_ids: ["w0"],
      status: "pending",
    };

    // Merge wave 0
    const r0 = await mergeWave(projectDir, wave0, dag);
    expect(r0.ok).toBe(true);

    // Create wave 1 branch off the integration branch
    await createBranchWithChanges(
      projectDir,
      "task/w1",
      "integrate/test/wave-0",
      { "w1.txt": "wave1\n" },
    );
    dag.tasks[1].branch = "task/w1";

    const wave1: Wave = {
      wave: 1,
      task_ids: ["w1"],
      status: "pending",
    };

    const r1 = await mergeWave(projectDir, wave1, dag);

    expect(r1.ok).toBe(true);
    expect(r1.integrationBranch).toBe("integrate/test/wave-1");
  });

  test("skips tasks without branch", async () => {
    const dag = makeDAG([makeTask("nobrach", [], [])]);
    // no branch set

    const wave: Wave = {
      wave: 0,
      task_ids: ["nobrach"],
      status: "pending",
    };

    const result = await mergeWave(projectDir, wave, dag);

    expect(result.ok).toBe(true);
    expect(result.merged).toHaveLength(0);
  });
});
