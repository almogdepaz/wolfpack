import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskDAG, TaskNode } from "../../../src/kobra-kai/types.ts";
import {
  computeWaves,
  decompose,
  detectFileOverlaps,
  loadDAG,
  parseJSONResponse,
  resolveOverlaps,
  saveDAG,
  schedule,
  spawnLLM,
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

// ---------------------------------------------------------------------------
// parseJSONResponse
// ---------------------------------------------------------------------------

describe("parseJSONResponse", () => {
  test("parses plain JSON", () => {
    const result = parseJSONResponse('{"tasks": []}');
    expect(result).toEqual({ tasks: [] });
  });

  test("parses JSON wrapped in ```json fences", () => {
    const raw = '```json\n{"tasks": [{"id": "1"}]}\n```';
    const result = parseJSONResponse(raw);
    expect(result).toEqual({ tasks: [{ id: "1" }] });
  });

  test("parses JSON wrapped in plain ``` fences", () => {
    const raw = '```\n{"key": "value"}\n```';
    const result = parseJSONResponse(raw);
    expect(result).toEqual({ key: "value" });
  });

  test("handles whitespace around fences", () => {
    const raw = '  ```json\n  {"ok": true}  \n```  ';
    const result = parseJSONResponse(raw);
    expect(result).toEqual({ ok: true });
  });

  test("throws on invalid JSON", () => {
    expect(() => parseJSONResponse("not json at all")).toThrow(
      /Failed to parse JSON/,
    );
  });

  test("throws with descriptive error including raw preview", () => {
    try {
      parseJSONResponse("{broken");
      expect(true).toBe(false); // should not reach
    } catch (e: any) {
      expect(e.message).toContain("Failed to parse JSON");
      expect(e.message).toContain("{broken");
    }
  });
});

// ---------------------------------------------------------------------------
// spawnLLM
// ---------------------------------------------------------------------------

describe("spawnLLM", () => {
  test("calls Bun.spawn with correct args", async () => {
    const originalSpawn = Bun.spawn;
    let capturedArgs: any[] = [];

    // Mock Bun.spawn
    (Bun as any).spawn = (...args: any[]) => {
      capturedArgs = args;
      // Return a mock process
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"tasks": []}'));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };

    try {
      const result = await spawnLLM("test prompt");
      expect(result).toBe('{"tasks": []}');
      expect(capturedArgs[0]).toEqual(["claude", "--print", "-p", "test prompt"]);
      expect(capturedArgs[1]).toHaveProperty("stdout", "pipe");
      expect(capturedArgs[1]).toHaveProperty("stderr", "pipe");
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });

  test("throws on non-zero exit code", async () => {
    const originalSpawn = Bun.spawn;

    (Bun as any).spawn = () => {
      const stdout = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("something went wrong"));
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(1),
        kill: () => {},
      };
    };

    try {
      await expect(spawnLLM("bad prompt")).rejects.toThrow(
        /claude exited with code 1/,
      );
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });

  test("kills process on timeout", async () => {
    const originalSpawn = Bun.spawn;
    let killed = false;

    (Bun as any).spawn = () => {
      const stdout = new ReadableStream({
        start() {
          // Never close — simulates a hanging process
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: new Promise(() => {}), // never resolves
        kill: () => {
          killed = true;
        },
      };
    };

    try {
      // Very short timeout to trigger quickly
      const promise = spawnLLM("slow prompt", 50);
      // The ReadableStream will hang, but timeout fires kill()
      // This should eventually reject or hang — we just verify kill was called
      await new Promise((r) => setTimeout(r, 100));
      expect(killed).toBe(true);
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });
});

// ---------------------------------------------------------------------------
// decompose
// ---------------------------------------------------------------------------

describe("decompose", () => {
  test("builds DAG from LLM response", async () => {
    const originalSpawn = Bun.spawn;
    let capturedPrompt = "";

    const mockResponse = JSON.stringify({
      tasks: [
        {
          id: "1",
          title: "Add auth module",
          description: "Create authentication middleware",
          depends_on: [],
          estimated_files: ["src/auth.ts"],
        },
        {
          id: "2",
          title: "Add tests",
          description: "Create test suite for auth",
          depends_on: ["1"],
          estimated_files: ["tests/auth.test.ts"],
        },
      ],
    });

    (Bun as any).spawn = (cmd: string[], opts: any) => {
      // Capture the prompt from the command args
      if (cmd[0] === "claude") {
        capturedPrompt = cmd[3]; // -p <prompt>
      }
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(mockResponse));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };

    const dir = await mkdtemp(join(tmpdir(), "decompose-test-"));

    try {
      // Initialize a git repo so context gathering works
      await Bun.spawn(["git", "init"], { cwd: dir }).exited;
      await Bun.spawn(["git", "checkout", "-b", "main"], { cwd: dir }).exited;

      // Restore real spawn for git commands, mock only for claude
      (Bun as any).spawn = (cmd: string[], opts: any) => {
        if (cmd[0] === "claude") {
          capturedPrompt = cmd[3];
          const stdout = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(mockResponse));
              controller.close();
            },
          });
          const stderr = new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
          return {
            stdout,
            stderr,
            exited: Promise.resolve(0),
            kill: () => {},
          };
        }
        return originalSpawn(cmd, opts);
      };

      const dag = await decompose("Add user authentication", dir);

      // Verify DAG structure
      expect(dag.tasks).toHaveLength(2);
      expect(dag.tasks[0].id).toBe("1");
      expect(dag.tasks[1].id).toBe("2");
      expect(dag.tasks[1].depends_on).toContain("1");
      expect(dag.metadata.source).toBe("decomposed");
      expect(dag.waves.length).toBeGreaterThan(0);

      // Verify prompt includes project context markers
      expect(capturedPrompt).toContain("Add user authentication");
      expect(capturedPrompt).toContain("Branch:");

      // Verify DAG was saved
      const saved = await loadDAG(dir);
      expect(saved).not.toBeNull();
      expect(saved!.tasks).toHaveLength(2);
    } finally {
      (Bun as any).spawn = originalSpawn;
      await rm(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// schedule
// ---------------------------------------------------------------------------

describe("schedule", () => {
  test("builds DAG from existing plan content", async () => {
    const originalSpawn = Bun.spawn;
    let capturedPrompt = "";

    const mockResponse = JSON.stringify({
      tasks: [
        {
          id: "1",
          title: "Setup database",
          description: "Initialize DB schema",
          depends_on: [],
          estimated_files: ["src/db.ts"],
        },
        {
          id: "2",
          title: "Create API routes",
          description: "Add REST endpoints",
          depends_on: ["1"],
          estimated_files: ["src/routes.ts"],
        },
        {
          id: "3",
          title: "Add frontend",
          description: "Build UI components",
          depends_on: [],
          estimated_files: ["src/ui.tsx"],
        },
      ],
    });

    const dir = await mkdtemp(join(tmpdir(), "schedule-test-"));

    try {
      // Init git repo with real spawn
      await Bun.spawn(["git", "init"], { cwd: dir }).exited;
      await Bun.spawn(["git", "checkout", "-b", "main"], { cwd: dir }).exited;

      // Now mock spawn for claude calls only
      (Bun as any).spawn = (cmd: string[], opts: any) => {
        if (cmd[0] === "claude") {
          capturedPrompt = cmd[3];
          const stdout = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(mockResponse));
              controller.close();
            },
          });
          const stderr = new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
          return {
            stdout,
            stderr,
            exited: Promise.resolve(0),
            kill: () => {},
          };
        }
        return originalSpawn(cmd, opts);
      };

      const planContent = "1. Setup database\n2. Create API routes\n3. Add frontend";
      const dag = await schedule(planContent, dir);

      // Verify DAG structure
      expect(dag.tasks).toHaveLength(3);
      expect(dag.metadata.source).toBe("scheduled");
      expect(dag.waves.length).toBeGreaterThan(0);

      // Tasks 1 and 3 should be in wave 0 (parallel), task 2 in wave 1
      const task1 = dag.tasks.find((t) => t.id === "1")!;
      const task2 = dag.tasks.find((t) => t.id === "2")!;
      const task3 = dag.tasks.find((t) => t.id === "3")!;
      expect(task1.wave).toBe(0);
      expect(task3.wave).toBe(0);
      expect(task2.wave).toBe(1);

      // Verify prompt includes plan content and context
      expect(capturedPrompt).toContain("Setup database");
      expect(capturedPrompt).toContain("Branch:");

      // Verify DAG was saved
      const saved = await loadDAG(dir);
      expect(saved).not.toBeNull();
    } finally {
      (Bun as any).spawn = originalSpawn;
      await rm(dir, { recursive: true });
    }
  });
});
