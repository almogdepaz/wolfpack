export interface TaskNode {
  id: string; // "1", "1a", "2"
  title: string;
  description: string; // self-contained task prompt
  depends_on: string[];
  estimated_files: string[];
  requires?: TaskRequirements;
  verify?: string; // shell command to verify completion
  wave: number; // computed by computeWaves()
  status: "pending" | "in_progress" | "completed" | "failed";
  branch?: string; // wt/{project}/{taskId}
  worktree_path?: string;
  pid?: number; // agent process pid while running
}

export interface TaskRequirements {
  gpu?: boolean;
  agent?: string;
  minDisk?: number;
  os?: string;
}

export interface Wave {
  wave: number;
  task_ids: string[];
  integration_branch?: string; // integrate/{project}/wave-N
  status: "pending" | "in_progress" | "merging" | "merged" | "failed";
}

export interface TaskDAG {
  tasks: TaskNode[];
  waves: Wave[];
  metadata: {
    project: string;
    created_at: string;
    source: "decomposed" | "scheduled";
  };
}

export interface MergeResult {
  ok: boolean;
  integrationBranch: string;
  merged: string[];
  unexpectedFiles: { taskId: string; files: string[] }[];
  conflicts: { taskId: string; files: string[] }[];
  error?: string;
}

export interface OrchestrationStatus {
  project: string;
  status: "idle" | "active" | "completed" | "failed";
  currentWave: number;
  totalWaves: number;
  tasks: { id: string; title: string; status: string; wave: number }[];
  activeAgents: number;
  queuedTasks: number;
  maxConcurrent: number;
  startedAt: string | null;
}

export type AdvanceResult =
  | "waiting" // agents still running
  | "spawned" // spawned queued tasks from current wave
  | "advanced" // merged wave, started next
  | "completed" // all waves done
  | "failed" // a task failed
  | "merge_failed"; // wave merge failed
