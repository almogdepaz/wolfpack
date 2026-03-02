import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskDAG, TaskNode } from "../../../src/kobra-kai/types.ts";
import {
  computeWaves,
  detectFileOverlaps,
  loadDAG,
  resolveOverlaps,
  saveDAG,
} from "../../../src/kobra-kai/planner.ts";

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

// ---------------------------------------------------------------------------
// computeWaves
// ---------------------------------------------------------------------------

describe("computeWaves", () => {
  test("linear chain A→B→C", () => {
    const dag = makeDAG([
      makeTask("A"),
      makeTask("B", ["A"]),
      makeTask("C", ["B"]),
    ]);

    const waves = computeWaves(dag);

    expect(waves).toHaveLength(3);
    expect(waves[0]).toEqual({ wave: 0, task_ids: ["A"], status: "pending" });
    expect(waves[1]).toEqual({ wave: 1, task_ids: ["B"], status: "pending" });
    expect(waves[2]).toEqual({ wave: 2, task_ids: ["C"], status: "pending" });

    // task.wave mutated
    expect(dag.tasks[0].wave).toBe(0);
    expect(dag.tasks[1].wave).toBe(1);
    expect(dag.tasks[2].wave).toBe(2);
  });

  test("diamond A→B,C→D", () => {
    const dag = makeDAG([
      makeTask("A"),
      makeTask("B", ["A"]),
      makeTask("C", ["A"]),
      makeTask("D", ["B", "C"]),
    ]);

    const waves = computeWaves(dag);

    expect(waves).toHaveLength(3);
    expect(waves[0].task_ids).toEqual(["A"]);
    expect(waves[1].task_ids.sort()).toEqual(["B", "C"]);
    expect(waves[2].task_ids).toEqual(["D"]);
  });

  test("wide — A,B,C all wave 0", () => {
    const dag = makeDAG([makeTask("A"), makeTask("B"), makeTask("C")]);

    const waves = computeWaves(dag);

    expect(waves).toHaveLength(1);
    expect(waves[0].wave).toBe(0);
    expect(waves[0].task_ids.sort()).toEqual(["A", "B", "C"]);
  });

  test("single task", () => {
    const dag = makeDAG([makeTask("X")]);

    const waves = computeWaves(dag);

    expect(waves).toHaveLength(1);
    expect(waves[0]).toEqual({ wave: 0, task_ids: ["X"], status: "pending" });
    expect(dag.tasks[0].wave).toBe(0);
  });

  test("cycle detection", () => {
    const dag = makeDAG([makeTask("A", ["B"]), makeTask("B", ["A"])]);

    expect(() => computeWaves(dag)).toThrow(/cycle detected/i);
  });

  test("sets dag.waves", () => {
    const dag = makeDAG([makeTask("A"), makeTask("B", ["A"])]);

    computeWaves(dag);

    expect(dag.waves).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// detectFileOverlaps
// ---------------------------------------------------------------------------

describe("detectFileOverlaps", () => {
  test("overlapping pair in same wave", () => {
    const dag = makeDAG([
      makeTask("A", [], ["src/foo.ts", "src/bar.ts"]),
      makeTask("B", [], ["src/bar.ts", "src/baz.ts"]),
    ]);
    computeWaves(dag);

    const overlaps = detectFileOverlaps(dag);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].wave).toBe(0);
    expect(overlaps[0].tasks).toEqual(["A", "B"]);
    expect(overlaps[0].files).toEqual(["src/bar.ts"]);
  });

  test("no overlaps", () => {
    const dag = makeDAG([
      makeTask("A", [], ["src/foo.ts"]),
      makeTask("B", [], ["src/bar.ts"]),
    ]);
    computeWaves(dag);

    const overlaps = detectFileOverlaps(dag);

    expect(overlaps).toHaveLength(0);
  });

  test("no overlap when tasks in different waves", () => {
    const dag = makeDAG([
      makeTask("A", [], ["src/shared.ts"]),
      makeTask("B", ["A"], ["src/shared.ts"]),
    ]);
    computeWaves(dag);

    const overlaps = detectFileOverlaps(dag);

    expect(overlaps).toHaveLength(0);
  });

  test("multiple overlaps in same wave", () => {
    const dag = makeDAG([
      makeTask("A", [], ["src/x.ts", "src/y.ts"]),
      makeTask("B", [], ["src/x.ts"]),
      makeTask("C", [], ["src/y.ts"]),
    ]);
    computeWaves(dag);

    const overlaps = detectFileOverlaps(dag);

    expect(overlaps).toHaveLength(2);
    const pairs = overlaps.map((o) => o.tasks);
    expect(pairs).toContainEqual(["A", "B"]);
    expect(pairs).toContainEqual(["A", "C"]);
  });

  test("multiple shared files between a pair", () => {
    const dag = makeDAG([
      makeTask("A", [], ["a.ts", "b.ts", "c.ts"]),
      makeTask("B", [], ["b.ts", "c.ts", "d.ts"]),
    ]);
    computeWaves(dag);

    const overlaps = detectFileOverlaps(dag);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].files.sort()).toEqual(["b.ts", "c.ts"]);
  });
});

// ---------------------------------------------------------------------------
// resolveOverlaps
// ---------------------------------------------------------------------------

describe("resolveOverlaps", () => {
  test("adds dependency edge and recomputes waves", () => {
    const dag = makeDAG([
      makeTask("A", [], ["src/shared.ts"]),
      makeTask("B", [], ["src/shared.ts"]),
    ]);
    computeWaves(dag);

    // Both start in wave 0
    expect(dag.waves).toHaveLength(1);

    resolveOverlaps(dag);

    // B now depends on A → different waves
    const taskB = dag.tasks.find((t) => t.id === "B")!;
    expect(taskB.depends_on).toContain("A");
    expect(dag.waves).toHaveLength(2);
    expect(dag.tasks.find((t) => t.id === "A")!.wave).toBe(0);
    expect(taskB.wave).toBe(1);
  });

  test("no-op when no overlaps", () => {
    const dag = makeDAG([
      makeTask("A", [], ["src/a.ts"]),
      makeTask("B", [], ["src/b.ts"]),
    ]);
    computeWaves(dag);

    resolveOverlaps(dag);

    expect(dag.waves).toHaveLength(1);
    expect(dag.tasks.find((t) => t.id === "B")!.depends_on).toEqual([]);
  });

  test("does not duplicate existing edge", () => {
    const dag = makeDAG([
      makeTask("A", [], ["src/shared.ts"]),
      makeTask("B", ["A"], ["src/shared.ts"]),
    ]);
    computeWaves(dag);

    // Already in different waves, no overlap detected
    resolveOverlaps(dag);

    const taskB = dag.tasks.find((t) => t.id === "B")!;
    expect(taskB.depends_on).toEqual(["A"]);
  });
});

// ---------------------------------------------------------------------------
// loadDAG / saveDAG roundtrip
// ---------------------------------------------------------------------------

describe("loadDAG / saveDAG", () => {
  test("roundtrip to temp dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planner-test-"));

    try {
      const dag = makeDAG([
        makeTask("A"),
        makeTask("B", ["A"]),
      ]);
      computeWaves(dag);

      await saveDAG(dir, dag);

      // Verify file exists and is valid JSON
      const raw = await readFile(join(dir, "task-dag.json"), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.metadata.project).toBe("test");

      // Load back
      const loaded = await loadDAG(dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.tasks).toHaveLength(2);
      expect(loaded!.waves).toHaveLength(2);
      expect(loaded!.metadata.project).toBe("test");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("loadDAG returns null for missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planner-test-"));

    try {
      const result = await loadDAG(dir);
      expect(result).toBeNull();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
