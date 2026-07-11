/**
 * Ralph loop management — log parsing, project scanning, task counting.
 */
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { createLogger, errMsg } from "../log.js";
import { isProcessAlive, isRalphProcessAlive } from "../shared/process-cleanup.js";
import { join, normalize, isAbsolute } from "node:path";
import { countTasksInContent, validatePlanFormat } from "../wolfpack-context.js";
import { DEV_DIR } from "./dev-dir.js";
import {
  detectAgentUiStatusFromManifests,
  loadAgentUiDetectionManifests,
  type LoadAgentUiDetectionManifestsOptions,
  type AgentUiDetectionDiagnostics,
} from "../agent-ui-detection-manifest.js";

const log = createLogger("ralph");

function agentUiManifestLoadOptions(): LoadAgentUiDetectionManifestsOptions {
  const userManifestPaths = process.env.WOLFPACK_AGENT_UI_MANIFEST
    ?.split(":")
    .map((p) => p.trim())
    .filter(Boolean);
  const cachedManifestPath = process.env.WOLFPACK_AGENT_UI_MANIFEST_CACHE?.trim();
  return {
    userManifestPaths,
    cachedManifestPath: cachedManifestPath || undefined,
  };
}

/** Returns true if p is a safe relative path — no absolute paths, no .. traversal. */
function isSafeRelativePath(p: string): boolean {
  if (!p || p.includes("\0")) return false;
  const n = normalize(p);
  return !isAbsolute(n) && !n.startsWith("..");
}

export interface RalphStatus {
  project: string;
  active: boolean;
  completed: boolean;
  audit: boolean;
  cleanup: boolean;
  cleanupEnabled: boolean;
  auditFixEnabled: boolean;
  iteration: number;
  totalIterations: number;
  agent: string;
  planFile: string;
  progressFile: string;
  started: string;
  finished: string;
  lastOutput: string;
  pid: number;
  tasksDone: number;
  tasksTotal: number;
  worktreeMode: string;
  worktreeBranch: string;
  sandbox: string;
  detectionManifest?: AgentUiDetectionDiagnostics;
}

export function listDevProjects(): string[] {
  try {
    return readdirSync(DEV_DIR)
      .filter((f) => {
        if (f.startsWith(".")) return false;
        try {
          return statSync(join(DEV_DIR, f)).isDirectory();
        } catch { /* race: entry removed between readdir and stat */
          return false;
        }
      })
      .sort();
  } catch { /* expected: DEV_DIR doesn't exist or isn't readable */
    return [];
  }
}

/** Count unique completed tasks from progress.txt DONE: lines */
export function countProgressDone(progressPath: string): number {
  try {
    const content = readFileSync(progressPath, "utf-8");
    const keys = new Set<string>();
    for (const line of content.split("\n")) {
      if (line.startsWith("DONE: ")) keys.add(line.slice(6));
    }
    return keys.size;
  } catch { return 0; }
}

export function countPlanTasks(planPath: string): { done: number; total: number; issues: string[] } {
  try {
    const plan = readFileSync(planPath, "utf-8");
    const { issues } = validatePlanFormat(plan);
    const { done, total } = countTasksInContent(plan);
    return { done, total, issues };
  } catch (e: unknown) {
    log.warn("failed to read plan file", { path: planPath, error: errMsg(e) });
    return { done: 0, total: 0, issues: [] };
  }
}

export function parseRalphLog(projectDir: string): RalphStatus | null {
  const logPath = join(projectDir, ".ralph.log");
  if (!existsSync(logPath)) return null;

  const project = projectDir.split("/").pop() ?? "";
  const status: RalphStatus = {
    project,
    active: false,
    completed: false,
    audit: false,
    cleanup: false,
    cleanupEnabled: true,
    auditFixEnabled: false,
    iteration: 0,
    totalIterations: 0,
    agent: "",
    planFile: "",
    progressFile: "",
    started: "",
    finished: "",
    lastOutput: "",
    pid: 0,
    tasksDone: 0,
    tasksTotal: 0,
    worktreeMode: "false",
    worktreeBranch: "",
    sandbox: "",
  };

  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n");

    // parse header
    for (const line of lines.slice(0, 16)) {
      const agentMatch = line.match(/^agent:\s*(.+)/);
      if (agentMatch) status.agent = agentMatch[1].trim();
      const planMatch = line.match(/^plan:\s*(.+)/);
      if (planMatch) {
        const v = planMatch[1].trim();
        if (isSafeRelativePath(v)) status.planFile = v;
        else log.warn("parseRalphLog: rejected unsafe planFile", { dir: projectDir, value: v });
      }
      const progMatch = line.match(/^progress:\s*(.+)/);
      if (progMatch) {
        const v = progMatch[1].trim();
        if (isSafeRelativePath(v)) status.progressFile = v;
        else log.warn("parseRalphLog: rejected unsafe progressFile", { dir: projectDir, value: v });
      }
      const cleanupMatch = line.match(/^phase_cleanup:\s*(on|off)/);
      if (cleanupMatch) status.cleanupEnabled = cleanupMatch[1] === "on";
      const auditFixMatch = line.match(/^phase_audit_fix:\s*(on|off)/);
      if (auditFixMatch) status.auditFixEnabled = auditFixMatch[1] === "on";
      const wtMatch = line.match(/^worktree:\s*(.+)/);
      if (wtMatch) status.worktreeMode = wtMatch[1].trim();
      const sandboxMatch = line.match(/^sandbox:\s*(.+)/);
      if (sandboxMatch) status.sandbox = sandboxMatch[1].trim();
      const startMatch = line.match(/^started:\s*(.+)/);
      if (startMatch) status.started = startMatch[1].trim();
      const pidMatch = line.match(/^pid:\s*(\d+)/);
      if (pidMatch) status.pid = Number(pidMatch[1]);
    }

    // parse total iterations from header line
    const totalMatch = content.match(/ralph — (\d+) iterations/);
    if (totalMatch) status.totalIterations = Number(totalMatch[1]);

    // parse worktree branch from "worktree created/reused" log line
    const wtBranchMatch = content.match(/^worktree (?:created|reused):.+\(branch ([^,)]+)/m);
    if (wtBranchMatch) status.worktreeBranch = wtBranchMatch[1].trim();

    // find iterations (supports both old "Iteration" and new "Wax On" format)
    const iterRegex = /=== (?:Iteration|🥋 Wax On) (\d+)\/(\d+)/g;
    let match;
    while ((match = iterRegex.exec(content)) !== null) {
      status.iteration = Number(match[1]);
      status.totalIterations = Number(match[2]);
    }

    // check completion
    const finishedMatch = content.match(/^finished:\s*(.+)/m);
    if (finishedMatch) {
      status.finished = finishedMatch[1].trim();
    }

    // detect active: PID-reuse-safe liveness via `ps -o command=` filter.
    // `kill(pid, 0)` alone would report "active" for any unrelated process
    // the kernel happened to assign the recycled PID to after the ralph
    // worker reaped — leaving the UI showing a dead loop as live and the
    // cancel button as a no-op (the cancel endpoint applies the same filter
    // and would refuse to kill).
    if (status.pid > 1 && isRalphProcessAlive(status.pid)) {
      status.active = true;
      status.completed = false;
      if (content.includes("=== 🥋 Wax Inspect —") && !content.includes("Wax Inspect complete") && !content.includes("Wax Inspect FAILED")) {
        status.audit = true;
      }
      if (content.includes("=== 🥋 Wax Off —") && !content.includes("Wax Off complete") && !content.includes("Wax Off FAILED")) {
        status.cleanup = true;
      }
      if (!status.audit && !status.cleanup) {
        const manifestMatch = detectAgentUiStatusFromManifests(
          loadAgentUiDetectionManifests(agentUiManifestLoadOptions()),
          "ralph",
          content,
        );
        if (manifestMatch?.status === "audit") status.audit = true;
        if (manifestMatch?.status === "cleanup") status.cleanup = true;
        if (manifestMatch) status.detectionManifest = manifestMatch.diagnostics;
      }
    }

    // last output lines (skip markers and blanks)
    const meaningful = lines.filter(
      (l) => l.trim() && !l.startsWith("===") && !l.startsWith("plan:") &&
        !l.startsWith("progress:") && !l.startsWith("started:") &&
        !l.startsWith("finished:") && !l.startsWith("pid:") &&
        !l.startsWith("agent:") && !l.startsWith("phase_cleanup:") &&
        !l.startsWith("phase_audit_fix:") && !l.startsWith("sandbox:") && !l.startsWith("🥋"),
    );
    status.lastOutput = meaningful.slice(-5).join("\n");

    // completed: strict detection via explicit worker signal
    if (!status.active && content.includes("all_tasks_done: true")) {
      status.completed = true;
    }

    // count tasks from plan file — prefer worktree copy if available (for progress bar)
    if (status.planFile) {
      const workdirMatch = content.match(/^workdir:\s*(.+)/m);
      const workdirPath = workdirMatch ? workdirMatch[1].trim() : "";
      // validate workdir is under projectDir to prevent path traversal
      const isUnderProject = workdirPath === projectDir || workdirPath.startsWith(projectDir + "/");
      const planBase = workdirPath && isUnderProject && existsSync(join(workdirPath, status.planFile))
        ? workdirPath
        : projectDir;
      const tasks = countPlanTasks(join(planBase, status.planFile));
      status.tasksTotal = tasks.total;
      // done count comes from progress.txt DONE: lines (for progress bar display)
      const progressBase = workdirPath && isUnderProject && existsSync(join(workdirPath, status.progressFile))
        ? workdirPath
        : projectDir;
      status.tasksDone = countProgressDone(join(progressBase, status.progressFile));
    }

    return status;
  } catch (e: unknown) {
    log.warn("failed to parse ralph log", { dir: projectDir, error: errMsg(e) });
    return null;
  }
}

/**
 * Write-path stale-lock cleanup.
 *
 * Intentionally NOT called from parseRalphLog/read endpoints: callers decide
 * when mutating the filesystem is appropriate.
 */
export function pruneStaleRalphLock(projectDir: string, pid: number): void {
  if (pid <= 1 || isProcessAlive(pid)) return;
  const lockPath = join(projectDir, ".ralph.lock");
  try {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch (e: unknown) {
    log.warn("pruneStaleRalphLock: failed to remove stale lock", { error: errMsg(e) });
  }
}

export function scanRalphLoops(): RalphStatus[] {
  const projects = listDevProjects();
  const results: RalphStatus[] = [];
  for (const p of projects) {
    const dir = join(DEV_DIR, p);
    const status = parseRalphLog(dir);
    if (!status) continue;
    if (status.planFile && !existsSync(join(dir, status.planFile))) continue;
    results.push(status);
  }
  return results;
}
