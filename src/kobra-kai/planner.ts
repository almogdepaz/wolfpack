import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskDAG, TaskNode, Wave } from "./types.ts";

const DAG_FILE = "task-dag.json";

/**
 * Topological sort via DFS — assigns wave numbers and returns Wave[].
 * Wave 0 = tasks with no dependencies.
 * Each task's wave = max(wave of each dependency) + 1.
 * Mutates task.wave on each TaskNode in the DAG.
 */
export function computeWaves(dag: TaskDAG): Wave[] {
  const taskMap = new Map<string, TaskNode>();
  for (const task of dag.tasks) {
    taskMap.set(task.id, task);
  }

  const resolved = new Map<string, number>();
  const visiting = new Set<string>();

  function dfs(id: string): number {
    if (resolved.has(id)) return resolved.get(id)!;
    if (visiting.has(id)) {
      throw new Error(`Cycle detected involving task "${id}"`);
    }

    visiting.add(id);
    const task = taskMap.get(id);
    if (!task) throw new Error(`Unknown task "${id}"`);

    let wave = 0;
    for (const depId of task.depends_on) {
      wave = Math.max(wave, dfs(depId) + 1);
    }

    visiting.delete(id);
    resolved.set(id, wave);
    task.wave = wave;
    return wave;
  }

  for (const task of dag.tasks) {
    dfs(task.id);
  }

  // Group by wave number
  const waveGroups = new Map<number, string[]>();
  for (const task of dag.tasks) {
    const ids = waveGroups.get(task.wave) ?? [];
    ids.push(task.id);
    waveGroups.set(task.wave, ids);
  }

  // Sort ascending by wave number, build Wave objects
  const waves: Wave[] = [...waveGroups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([wave, task_ids]) => ({
      wave,
      task_ids,
      status: "pending" as const,
    }));

  dag.waves = waves;
  return waves;
}

/**
 * For each wave, find pairs of tasks that share estimated_files entries.
 */
export function detectFileOverlaps(
  dag: TaskDAG,
): { wave: number; tasks: [string, string]; files: string[] }[] {
  const taskMap = new Map<string, TaskNode>();
  for (const task of dag.tasks) {
    taskMap.set(task.id, task);
  }

  const overlaps: { wave: number; tasks: [string, string]; files: string[] }[] =
    [];

  for (const wave of dag.waves) {
    const ids = wave.task_ids;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = taskMap.get(ids[i])!;
        const b = taskMap.get(ids[j])!;
        const filesA = new Set(a.estimated_files);
        const shared = b.estimated_files.filter((f) => filesA.has(f));
        if (shared.length > 0) {
          overlaps.push({
            wave: wave.wave,
            tasks: [ids[i], ids[j]],
            files: shared,
          });
        }
      }
    }
  }

  return overlaps;
}

/**
 * For each overlap, add a depends_on edge from the second task to the first
 * (by ID sort order), then recompute waves.
 * Returns the mutated DAG.
 */
export function resolveOverlaps(dag: TaskDAG): TaskDAG {
  const taskMap = new Map<string, TaskNode>();
  for (const task of dag.tasks) {
    taskMap.set(task.id, task);
  }

  const overlaps = detectFileOverlaps(dag);
  for (const overlap of overlaps) {
    const [idA, idB] = [...overlap.tasks].sort();
    const taskB = taskMap.get(idB)!;
    if (!taskB.depends_on.includes(idA)) {
      taskB.depends_on.push(idA);
    }
  }

  computeWaves(dag);
  return dag;
}

/**
 * Read task-dag.json from projectDir. Returns null if file doesn't exist.
 */
export async function loadDAG(projectDir: string): Promise<TaskDAG | null> {
  try {
    const raw = await readFile(join(projectDir, DAG_FILE), "utf-8");
    return JSON.parse(raw) as TaskDAG;
  } catch {
    return null;
  }
}

/**
 * Write task-dag.json to projectDir.
 */
export async function saveDAG(projectDir: string, dag: TaskDAG): Promise<void> {
  await writeFile(
    join(projectDir, DAG_FILE),
    JSON.stringify(dag, null, 2) + "\n",
    "utf-8",
  );
}
