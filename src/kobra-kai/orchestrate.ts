import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  AdvanceResult,
  OrchestrationStatus,
  TaskDAG,
  Wave,
} from "./types.ts";
import { loadDAG, saveDAG } from "./planner.ts";
import { createWaveWorktrees, cleanupWaveWorktrees } from "./worktree.ts";
import { mergeWave } from "./merge.ts";
import { TASK_HEADER } from "../wolfpack-context.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const activeOrchestrations = new Set<string>();
let pollInterval: Timer | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count total and completed tasks in a PLAN.md content string.
 * Counts checkboxes (`- [ ]`/`- [x]`) and numbered section headers
 * (with/without ~~strikethrough~~).
 */
export function countTasksInContent(content: string): {
  total: number;
  completed: number;
} {
  const lines = content.split("\n");
  let total = 0;
  let completed = 0;

  for (const line of lines) {
    if (/^- \[[ x]\] /.test(line)) {
      total++;
      if (/^- \[x\] /.test(line)) completed++;
    } else if (TASK_HEADER.test(line)) {
      total++;
      if (line.includes("~~")) completed++;
    }
  }

  return { total, completed };
}

// ---------------------------------------------------------------------------
// gatherProjectContext
// ---------------------------------------------------------------------------

export async function gatherProjectContext(
  projectDir: string,
): Promise<string> {
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

  const [fileTree, gitLog] = await Promise.all([
    run([
      "find",
      projectDir,
      "-maxdepth",
      "3",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/.git/*",
      "-not",
      "-path",
      "*-wt-*",
    ]),
    run(["git", "log", "--oneline", "-10"]),
  ]);

  const parts: string[] = [
    "File tree:",
    fileTree,
    "",
    "Recent commits:",
    gitLog,
  ];

  // Package.json (if exists)
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      const summary: Record<string, unknown> = {};
      if (pkg.name) summary.name = pkg.name;
      if (pkg.scripts) summary.scripts = pkg.scripts;
      if (pkg.dependencies) summary.dependencies = pkg.dependencies;
      parts.push("", "package.json:", JSON.stringify(summary, null, 2));
    } catch {
      // ignore parse errors
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// launchOrchestration
// ---------------------------------------------------------------------------

export async function launchOrchestration(
  projectDir: string,
  dag: TaskDAG,
  maxConcurrent: number,
): Promise<void> {
  await saveDAG(projectDir, dag);

  // Save orchestration config
  await writeFile(
    join(projectDir, "task-dag-config.json"),
    JSON.stringify(
      { maxConcurrent, startedAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
    "utf-8",
  );

  await createWaveWorktrees(projectDir, dag.waves[0], dag);
  await spawnWaveTasks(projectDir, dag.waves[0], dag, maxConcurrent);

  // Save updated DAG (worktree_path, branch, pid, status now set)
  await saveDAG(projectDir, dag);

  activeOrchestrations.add(projectDir);
}

// ---------------------------------------------------------------------------
// spawnWaveTasks
// ---------------------------------------------------------------------------

export async function spawnWaveTasks(
  projectDir: string,
  wave: Wave,
  dag: TaskDAG,
  maxConcurrent: number,
): Promise<void> {
  const projectContext = await gatherProjectContext(projectDir);

  const waveTasks = wave.task_ids
    .map((id) => dag.tasks.find((t) => t.id === id))
    .filter((t) => t != null);

  // Split into: first maxConcurrent → spawn now, rest → queued (stay pending)
  const toSpawn = waveTasks.slice(0, maxConcurrent);
  // remaining stay status "pending" (queued)

  for (const task of toSpawn) {
    if (!task.worktree_path) continue;

    // Write PLAN.md in worktree
    await writeFile(
      join(task.worktree_path, "PLAN.md"),
      `## 1. ${task.title}\n\n${task.description}\n`,
      "utf-8",
    );

    // Write project context to temp file in worktree
    const contextFilePath = join(task.worktree_path, ".project-context");
    await writeFile(contextFilePath, projectContext, "utf-8");

    // Spawn detached task runner
    const child = Bun.spawn(
      [
        "bun",
        "src/kobra-kai/task-runner.ts",
        "--worktree",
        task.worktree_path,
        "--max-iterations",
        "10",
        "--agent",
        "claude",
        "--project-context",
        contextFilePath,
      ],
      {
        cwd: task.worktree_path,
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );

    child.unref();
    task.pid = child.pid;
    task.status = "in_progress";
  }

  wave.status = "in_progress";
}

// ---------------------------------------------------------------------------
// advanceOrchestration
// ---------------------------------------------------------------------------

export async function advanceOrchestration(
  projectDir: string,
): Promise<AdvanceResult> {
  const dag = await loadDAG(projectDir);
  if (!dag) return "completed";

  // Load config for maxConcurrent
  let maxConcurrent = 2;
  try {
    const configRaw = await readFile(
      join(projectDir, "task-dag-config.json"),
      "utf-8",
    );
    const config = JSON.parse(configRaw);
    maxConcurrent = config.maxConcurrent ?? 2;
  } catch {
    // use default
  }

  // Find current wave: first wave where status !== "merged"
  const currentWave = dag.waves.find((w) => w.status !== "merged");
  if (!currentWave) {
    activeOrchestrations.delete(projectDir);
    await saveDAG(projectDir, dag);
    return "completed";
  }

  // Check each in_progress task for dead PIDs
  const waveTasks = currentWave.task_ids
    .map((id) => dag.tasks.find((t) => t.id === id))
    .filter((t) => t != null);

  for (const task of waveTasks) {
    if (task.status !== "in_progress" || !task.pid) continue;

    let alive = false;
    try {
      process.kill(task.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }

    if (!alive) {
      // PID is dead — check if task completed
      const planPath = task.worktree_path
        ? join(task.worktree_path, "PLAN.md")
        : null;

      if (planPath) {
        try {
          const content = await readFile(planPath, "utf-8");
          const { total, completed } = countTasksInContent(content);
          if (total > 0 && completed === total) {
            task.status = "completed";
          } else {
            task.status = "failed";
          }
        } catch {
          task.status = "failed";
        }
      } else {
        task.status = "failed";
      }
    }
  }

  // Count states
  let active = 0;
  let pending = 0;
  let completed = 0;
  let failed = 0;

  for (const task of waveTasks) {
    switch (task.status) {
      case "in_progress":
        active++;
        break;
      case "pending":
        pending++;
        break;
      case "completed":
        completed++;
        break;
      case "failed":
        failed++;
        break;
    }
  }

  // If any failed → save and return
  if (failed > 0) {
    currentWave.status = "failed";
    await saveDAG(projectDir, dag);
    return "failed";
  }

  // If active and pending slots available → spawn more
  if (active > 0 && pending > 0 && active < maxConcurrent) {
    const pendingTasks = waveTasks.filter((t) => t.status === "pending");
    const toSpawn = pendingTasks.slice(0, maxConcurrent - active);

    const projectContext = await gatherProjectContext(projectDir);

    for (const task of toSpawn) {
      if (!task.worktree_path) continue;

      await writeFile(
        join(task.worktree_path, "PLAN.md"),
        `## 1. ${task.title}\n\n${task.description}\n`,
        "utf-8",
      );

      const contextFilePath = join(task.worktree_path, ".project-context");
      await writeFile(contextFilePath, projectContext, "utf-8");

      const child = Bun.spawn(
        [
          "bun",
          "src/kobra-kai/task-runner.ts",
          "--worktree",
          task.worktree_path,
          "--max-iterations",
          "10",
          "--agent",
          "claude",
          "--project-context",
          contextFilePath,
        ],
        {
          cwd: task.worktree_path,
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
        },
      );

      child.unref();
      task.pid = child.pid;
      task.status = "in_progress";
    }

    await saveDAG(projectDir, dag);
    return "spawned";
  }

  // If agents still running → wait
  if (active > 0) {
    await saveDAG(projectDir, dag);
    return "waiting";
  }

  // All completed (no active, no pending) → merge wave
  const mergeResult = await mergeWave(projectDir, currentWave, dag);
  if (!mergeResult.ok) {
    currentWave.status = "failed";
    await saveDAG(projectDir, dag);
    return "merge_failed";
  }

  // Find next wave
  const nextWave = dag.waves.find((w) => w.status === "pending");
  if (!nextWave) {
    activeOrchestrations.delete(projectDir);
    await saveDAG(projectDir, dag);
    return "completed";
  }

  // Start next wave
  await createWaveWorktrees(projectDir, nextWave, dag);
  await spawnWaveTasks(projectDir, nextWave, dag, maxConcurrent);
  await saveDAG(projectDir, dag);
  return "advanced";
}

// ---------------------------------------------------------------------------
// getOrchestrationStatus
// ---------------------------------------------------------------------------

export async function getOrchestrationStatus(
  projectDir: string,
): Promise<OrchestrationStatus> {
  const dag = await loadDAG(projectDir);
  const project = projectDir.split("/").pop() ?? "unknown";

  if (!dag) {
    return {
      project,
      status: "idle",
      currentWave: 0,
      totalWaves: 0,
      tasks: [],
      activeAgents: 0,
      queuedTasks: 0,
      maxConcurrent: 0,
      startedAt: null,
    };
  }

  // Load config
  let maxConcurrent = 2;
  let startedAt: string | null = null;
  try {
    const configRaw = await readFile(
      join(projectDir, "task-dag-config.json"),
      "utf-8",
    );
    const config = JSON.parse(configRaw);
    maxConcurrent = config.maxConcurrent ?? 2;
    startedAt = config.startedAt ?? null;
  } catch {
    // defaults
  }

  const currentWave = dag.waves.find((w) => w.status !== "merged");
  const activeAgents = dag.tasks.filter(
    (t) => t.status === "in_progress",
  ).length;
  const queuedTasks = currentWave
    ? currentWave.task_ids.filter((id) => {
        const task = dag.tasks.find((t) => t.id === id);
        return task?.status === "pending";
      }).length
    : 0;

  const allMerged = dag.waves.every((w) => w.status === "merged");
  const anyFailed = dag.tasks.some((t) => t.status === "failed");

  let status: OrchestrationStatus["status"];
  if (allMerged) {
    status = "completed";
  } else if (anyFailed) {
    status = "failed";
  } else if (activeAgents > 0 || currentWave) {
    status = "active";
  } else {
    status = "idle";
  }

  return {
    project: dag.metadata.project,
    status,
    currentWave: currentWave?.wave ?? dag.waves.length,
    totalWaves: dag.waves.length,
    tasks: dag.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      wave: t.wave,
    })),
    activeAgents,
    queuedTasks,
    maxConcurrent,
    startedAt,
  };
}

// ---------------------------------------------------------------------------
// cancelOrchestration
// ---------------------------------------------------------------------------

export async function cancelOrchestration(
  projectDir: string,
): Promise<void> {
  const dag = await loadDAG(projectDir);
  if (!dag) return;

  // Kill all in-progress tasks
  for (const task of dag.tasks) {
    if (task.status === "in_progress" && task.pid) {
      try {
        process.kill(task.pid, "SIGTERM");
      } catch {
        // already dead
      }
      task.status = "failed";
    }
  }

  // Clean up worktrees for non-merged waves
  for (const wave of dag.waves) {
    if (wave.status !== "merged") {
      await cleanupWaveWorktrees(projectDir, wave, dag);
      wave.status = "failed";
    }
  }

  activeOrchestrations.delete(projectDir);
  await saveDAG(projectDir, dag);
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export function startOrchestrationPoller(intervalMs = 30_000): void {
  if (pollInterval) return;
  pollInterval = setInterval(async () => {
    for (const projectDir of activeOrchestrations) {
      try {
        await advanceOrchestration(projectDir);
      } catch {
        // swallow — advance will be retried next tick
      }
    }
  }, intervalMs);
}

export function stopOrchestrationPoller(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// Expose for testing
export function _getActiveOrchestrations(): Set<string> {
  return activeOrchestrations;
}
