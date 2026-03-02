import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskDAG, TaskNode, Wave } from "./types.ts";

// ---------------------------------------------------------------------------
// LLM helpers
// ---------------------------------------------------------------------------

/**
 * Spawn `claude --print` with the given prompt, collect stdout.
 * Throws on non-zero exit or timeout.
 */
export async function spawnLLM(
  prompt: string,
  timeoutMs = 120_000,
): Promise<string> {
  const proc = Bun.spawn(["claude", "--print", "-p", prompt], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => {
    proc.kill();
  }, timeoutMs);

  try {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `claude exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
      );
    }

    return stdout;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Strip markdown fences if present and JSON.parse the result.
 */
export function parseJSONResponse(raw: string): any {
  let trimmed = raw.trim();

  // Strip ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    trimmed = fenceMatch[1].trim();
  }

  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new Error(
      `Failed to parse JSON from LLM response: ${(e as Error).message}\nRaw (first 300 chars): ${raw.slice(0, 300)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Project context gathering
// ---------------------------------------------------------------------------

async function gatherProjectContext(projectDir: string): Promise<string> {
  const run = async (cmd: string[]): Promise<string> => {
    const proc = Bun.spawn(cmd, {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  };

  const [gitLog, branch, fileTree] = await Promise.all([
    run(["git", "log", "--oneline", "-10"]),
    run(["git", "branch", "--show-current"]),
    run([
      "find",
      ".",
      "-maxdepth",
      "2",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/.git/*",
    ]),
  ]);

  return [
    `Branch: ${branch}`,
    "",
    "Recent commits:",
    gitLog,
    "",
    "File tree (2 levels):",
    fileTree,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Decompose & Schedule
// ---------------------------------------------------------------------------

const DECOMPOSE_PROMPT = `You are a technical project planner. Given a goal and project context,
decompose it into 3-8 parallel-safe tasks.

Output ONLY valid JSON matching this schema:
{ "tasks": [{ "id": "1", "title": "...", "description": "...",
  "depends_on": [], "estimated_files": ["..."] }, ...] }

Rules:
- Each task description must be self-contained (an agent will implement it with no other context beyond the project itself)
- estimated_files should list files the task will create or modify
- Use depends_on to express ordering constraints
- Tasks that can run in parallel should have no dependency between them
- IDs are simple strings: "1", "2", "3" etc.`;

const SCHEDULE_PROMPT = `You are a technical project planner. Given an existing plan and project context,
infer dependency edges between the tasks and produce a structured task DAG.

Output ONLY valid JSON matching this schema:
{ "tasks": [{ "id": "1", "title": "...", "description": "...",
  "depends_on": [], "estimated_files": ["..."] }, ...] }

Rules:
- Each task description must be self-contained (an agent will implement it with no other context beyond the project itself)
- estimated_files should list files the task will create or modify
- Use depends_on to express ordering constraints
- Tasks that can run in parallel should have no dependency between them
- IDs are simple strings: "1", "2", "3" etc.`;

function buildDAGFromParsed(
  parsed: { tasks: Array<{ id: string; title: string; description: string; depends_on: string[]; estimated_files: string[] }> },
  source: "decomposed" | "scheduled",
  project: string,
): TaskDAG {
  const dag: TaskDAG = {
    tasks: parsed.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      depends_on: t.depends_on ?? [],
      estimated_files: t.estimated_files ?? [],
      wave: -1,
      status: "pending" as const,
    })),
    waves: [],
    metadata: {
      project,
      created_at: new Date().toISOString(),
      source,
    },
  };

  computeWaves(dag);
  resolveOverlaps(dag);
  return dag;
}

/**
 * Use LLM to decompose a goal into a TaskDAG.
 */
export async function decompose(
  goal: string,
  projectDir: string,
): Promise<TaskDAG> {
  const context = await gatherProjectContext(projectDir);
  const prompt = `${DECOMPOSE_PROMPT}\n\nProject context:\n${context}\n\nGoal: ${goal}`;

  const raw = await spawnLLM(prompt);
  const parsed = parseJSONResponse(raw);
  const project = projectDir.split("/").pop() ?? "unknown";
  const dag = buildDAGFromParsed(parsed, "decomposed", project);

  await saveDAG(projectDir, dag);
  return dag;
}

/**
 * Use LLM to schedule an existing plan into a TaskDAG.
 */
export async function schedule(
  planContent: string,
  projectDir: string,
): Promise<TaskDAG> {
  const context = await gatherProjectContext(projectDir);
  const prompt = `${SCHEDULE_PROMPT}\n\nProject context:\n${context}\n\nExisting plan:\n${planContent}`;

  const raw = await spawnLLM(prompt);
  const parsed = parseJSONResponse(raw);
  const project = projectDir.split("/").pop() ?? "unknown";
  const dag = buildDAGFromParsed(parsed, "scheduled", project);

  await saveDAG(projectDir, dag);
  return dag;
}

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
