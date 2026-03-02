import { join } from "node:path";
import { git } from "./git.ts";
import type { MergeResult, TaskDAG, Wave } from "./types.ts";
import { cleanupWaveWorktrees } from "./worktree.ts";

export function jsonMerge(base: any, ours: any, theirs: any): any {
  // Type mismatch between ours and theirs → take theirs
  if (typeof ours !== typeof theirs) return theirs;

  // Array vs non-array mismatch → take theirs
  if (Array.isArray(ours) !== Array.isArray(theirs)) return theirs;

  // Both arrays → concatenate and deduplicate primitives
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    const combined = [...ours, ...theirs];
    const seen = new Set();
    return combined.filter((item) => {
      if (typeof item === "object" && item !== null) return true;
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  }

  // Both objects → recurse per key (union of keys)
  if (
    typeof ours === "object" &&
    ours !== null &&
    typeof theirs === "object" &&
    theirs !== null
  ) {
    const result: Record<string, any> = {};
    const allKeys = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
    for (const key of allKeys) {
      if (key in ours && key in theirs) {
        const baseVal =
          base && typeof base === "object" && !Array.isArray(base)
            ? base[key]
            : undefined;
        result[key] = jsonMerge(baseVal, ours[key], theirs[key]);
      } else if (key in ours) {
        result[key] = ours[key];
      } else {
        result[key] = theirs[key];
      }
    }
    return result;
  }

  // Scalars → take theirs
  return theirs;
}

export async function mergeWave(
  projectDir: string,
  wave: Wave,
  dag: TaskDAG,
): Promise<MergeResult> {
  const projectName = dag.metadata.project;
  const baseBranch =
    wave.wave === 0
      ? "main"
      : `integrate/${projectName}/wave-${wave.wave - 1}`;
  const integrationBranch = `integrate/${projectName}/wave-${wave.wave}`;

  const merged: string[] = [];
  const conflicts: { taskId: string; files: string[] }[] = [];
  const unexpectedFiles: { taskId: string; files: string[] }[] = [];

  const originalBranch = await git(
    projectDir,
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  );

  try {
    // Create integration branch from base
    await git(projectDir, "checkout", "-b", integrationBranch, baseBranch);

    // Sort task_ids for deterministic merge order
    const sortedTaskIds = [...wave.task_ids].sort();

    for (const taskId of sortedTaskIds) {
      const task = dag.tasks.find((t) => t.id === taskId);
      if (!task?.branch) continue;

      // Validate diff: check for unexpected files
      try {
        const diffOutput = await git(
          projectDir,
          "diff",
          "--name-only",
          `${baseBranch}...${task.branch}`,
        );
        const changedFiles = diffOutput
          .split("\n")
          .filter((f) => f.length > 0);
        const unexpected = changedFiles.filter(
          (f) => !task.estimated_files.includes(f),
        );
        if (unexpected.length > 0) {
          unexpectedFiles.push({ taskId, files: unexpected });
        }
      } catch {
        // diff may fail if no changes — continue
      }

      // Attempt merge
      try {
        await git(
          projectDir,
          "merge",
          "--no-ff",
          task.branch,
          "-m",
          `merge task ${taskId}: ${task.title}`,
        );
        merged.push(taskId);
      } catch {
        // Merge conflict — inspect conflicted files
        try {
          const conflictedOutput = await git(
            projectDir,
            "diff",
            "--name-only",
            "--diff-filter=U",
          );
          const conflictedFiles = conflictedOutput
            .split("\n")
            .filter((f) => f.length > 0);
          const nonJsonFiles = conflictedFiles.filter(
            (f) => !f.endsWith(".json"),
          );

          if (nonJsonFiles.length > 0) {
            // Non-JSON conflicts → abort
            conflicts.push({ taskId, files: conflictedFiles });
            await git(projectDir, "merge", "--abort");
          } else if (conflictedFiles.length > 0) {
            // All conflicts are JSON → attempt resolution
            let resolved = true;
            for (const file of conflictedFiles) {
              try {
                const baseContent = JSON.parse(
                  await git(projectDir, "show", `:1:${file}`),
                );
                const oursContent = JSON.parse(
                  await git(projectDir, "show", `:2:${file}`),
                );
                const theirsContent = JSON.parse(
                  await git(projectDir, "show", `:3:${file}`),
                );
                const mergedContent = jsonMerge(
                  baseContent,
                  oursContent,
                  theirsContent,
                );
                await Bun.write(
                  join(projectDir, file),
                  JSON.stringify(mergedContent, null, 2) + "\n",
                );
                await git(projectDir, "add", file);
              } catch {
                resolved = false;
                break;
              }
            }

            if (resolved) {
              await git(projectDir, "commit", "--no-edit");
              merged.push(taskId);
            } else {
              conflicts.push({ taskId, files: conflictedFiles });
              await git(projectDir, "merge", "--abort");
            }
          } else {
            // No conflicted files found — abort anyway
            conflicts.push({ taskId, files: [] });
            await git(projectDir, "merge", "--abort");
          }
        } catch {
          // Inspecting conflicts failed — best-effort abort
          try {
            await git(projectDir, "merge", "--abort");
          } catch {
            // ignore
          }
          conflicts.push({ taskId, files: [] });
        }
      }
    }

    // Update wave state
    wave.integration_branch = integrationBranch;
    if (conflicts.length === 0) {
      wave.status = "merged";
    }

    // Cleanup worktrees
    await cleanupWaveWorktrees(projectDir, wave, dag);

    // Return to base branch
    await git(projectDir, "checkout", baseBranch);

    return {
      ok: conflicts.length === 0,
      integrationBranch,
      merged,
      unexpectedFiles,
      conflicts,
    };
  } catch (err) {
    // Attempt recovery
    try {
      await git(projectDir, "checkout", originalBranch);
    } catch {
      // best effort
    }

    return {
      ok: false,
      integrationBranch,
      merged,
      unexpectedFiles,
      conflicts,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
