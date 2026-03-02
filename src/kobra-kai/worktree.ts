import { basename, resolve } from "node:path";
import type { TaskDAG, Wave } from "./types.ts";
import { git } from "./git.ts";

export async function createTaskWorktree(
  projectDir: string,
  taskId: string,
  baseBranch: string,
): Promise<string> {
  const projectName = basename(projectDir);
  const worktreePath = resolve(projectDir, "..", `${projectName}-wt-${taskId}`);
  const branchName = `wt/${projectName}/${taskId}`;

  await git(projectDir, "worktree", "add", worktreePath, "-b", branchName, baseBranch);

  return worktreePath;
}

export async function removeTaskWorktree(
  projectDir: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  try {
    await git(projectDir, "worktree", "remove", "--force", worktreePath);
  } catch {
    // ignore if already removed
  }

  try {
    await git(projectDir, "branch", "-D", branch);
  } catch {
    // ignore if already removed
  }
}

export async function createWaveWorktrees(
  projectDir: string,
  wave: Wave,
  dag: TaskDAG,
): Promise<void> {
  const projectName = basename(projectDir);
  const baseBranch =
    wave.wave === 0
      ? "main"
      : `integrate/${projectName}/wave-${wave.wave - 1}`;

  for (const taskId of wave.task_ids) {
    const task = dag.tasks.find((t) => t.id === taskId);
    if (!task) continue;

    const worktreePath = await createTaskWorktree(projectDir, taskId, baseBranch);
    task.worktree_path = worktreePath;
    task.branch = `wt/${projectName}/${taskId}`;
  }
}

export async function cleanupWaveWorktrees(
  projectDir: string,
  wave: Wave,
  dag: TaskDAG,
): Promise<void> {
  for (const taskId of wave.task_ids) {
    const task = dag.tasks.find((t) => t.id === taskId);
    if (!task?.worktree_path) continue;

    await removeTaskWorktree(projectDir, task.worktree_path, task.branch!);
  }
}

export async function listProjectWorktrees(
  projectDir: string,
): Promise<string[]> {
  const output = await git(projectDir, "worktree", "list", "--porcelain");

  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((path) => path.includes("-wt-"));
}
