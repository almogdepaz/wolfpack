#!/usr/bin/env bun
/**
 * Ralph worker — runs claude iteratively on a plan file.
 * Spawned as a detached subprocess by serve.ts.
 *
 * Usage: bun ralph-macchio.ts [options]
 *   --iterations N    number of iterations (default 5)
 *   --plan FILE       plan file name (default PLAN.md)
 *   --progress FILE   progress file name (default progress.txt)
 *   --agent NAME      agent to use: claude|cursor|codex|gemini (default claude)
 *   --format          number plan tasks before starting
 *   --cleanup BOOL    run cleanup phase: true|false (default true)
 *   --audit-fix BOOL  run audit+fix phase: true|false (default false)
 *   --worktree MODE   worktree isolation: false|plan|task (default false)
 */
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, existsSync, unlinkSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { RALPH_AGENT_CONTEXT, TASK_HEADER, countTasksInContent, validatePlanFormat } from "./wolfpack-context.js";
import { expandBudget, resolveCleanupDiffBase, buildSrtSettings, shellEscape } from "./validation.js";
import { buildAuditFixPrompt } from "./ralph-skill-audit.js";
import { buildCleanupPrompt } from "./ralph-skill-cleanup.js";
import { createWorktree, cleanupAllExceptFinal, removeWorktree, listWorktrees, slugifyTaskName } from "./worktree.js";
import { errMsg, killProcessTree, killProcessTreeSync } from "./shared/process-cleanup.js";

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    iterations: { type: "string", default: "5" },
    plan: { type: "string", default: "PLAN.md" },
    progress: { type: "string", default: "progress.txt" },
    agent: { type: "string", default: "claude" },
    format: { type: "boolean", default: false },
    cleanup: { type: "string", default: "true" },
    "audit-fix": { type: "string", default: "false" },
    worktree: { type: "string", default: "false" },
    "worktree-branch": { type: "string" },
    "worktree-base": { type: "string" },
    sandbox: { type: "string", default: "true" },
  },
});

const ITERATIONS = Number(args.iterations) || 5;
const PLAN_FILE = args.plan!;
const PROGRESS_FILE = args.progress!;
const AGENT = args.agent!;
const FORMAT_PLAN = args.format!;
const CLEANUP_ENABLED = args.cleanup !== "false";
const AUDIT_FIX_ENABLED = args["audit-fix"] === "true";
const WORKTREE_MODE = (args.worktree === "plan" || args.worktree === "task") ? args.worktree : "false" as const;
const WORKTREE_BRANCH = args["worktree-branch"] || undefined;
const WORKTREE_BASE = args["worktree-base"] || undefined;
const SANDBOX_ENABLED = args.sandbox !== "false";
const PROJECT_DIR = process.cwd();

/**
 * mainWorkDir — the accumulator worktree where plan+progress live.
 * In normal mode: same as PROJECT_DIR.
 * In plan/task mode: a worktree created at startup.
 */
let mainWorkDir = PROJECT_DIR;

/**
 * workingDir — where the agent actually runs.
 * In normal/plan mode: same as mainWorkDir.
 * In task mode: per-task sub-worktree branching off mainWorkDir.
 */
let workingDir = PROJECT_DIR;

const LOG_FILE = join(PROJECT_DIR, ".ralph.log");
const ITER_FILE = join(PROJECT_DIR, ".ralph_iter.tmp");

/** PLAN_PATH and PROGRESS_PATH point to mainWorkDir — the single source of truth. */
let PLAN_PATH = join(PROJECT_DIR, PLAN_FILE);
let PROGRESS_PATH = join(PROJECT_DIR, PROGRESS_FILE);

const ALLOWED_TOOLS = [
  "Edit", "Write", "Read", "Glob", "Grep",
  "Bash(git *)", "Bash(npm *)", "Bash(npx *)", "Bash(pnpm *)",
  "Bash(yarn *)", "Bash(bun *)", "Bash(cargo *)", "Bash(go *)",
  "Bash(python *)", "Bash(pip *)", "Bash(pytest *)", "Bash(make *)",
  "Bash(ls *)", "Bash(mkdir *)", "Bash(rm *)", "Bash(mv *)",
  "Bash(cp *)", "Bash(cat *)", "Bash(echo *)", "Bash(touch *)",
].join(",");

// augment PATH with common bin dirs that may be missing in detached/non-interactive shells
const IS_WIN = process.platform === "win32";
const PATH_SEP = IS_WIN ? ";" : ":";
const HOME = process.env.HOME || process.env.USERPROFILE || "";
const EXTRA_PATHS: string[] = IS_WIN
  ? [
      join(HOME, "AppData", "Roaming", "npm"),
      join(HOME, "AppData", "Local", "Programs", "claude"),
      join(HOME, ".cargo", "bin"),
    ]
  : [
      join(HOME, ".local", "bin"),
      join(HOME, ".cargo", "bin"),
      join(HOME, "bin"),
      join(HOME, ".npm-global", "bin"),
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
    ];
const currentPath = process.env.PATH || "";
const pathSegments = new Set(currentPath.split(PATH_SEP));
const missingPaths = EXTRA_PATHS.filter(p => !pathSegments.has(p) && existsSync(p));
if (missingPaths.length > 0) {
  process.env.PATH = [...missingPaths, currentPath].join(PATH_SEP);
}

function resolveBin(name: string): string {
  const cmd = IS_WIN ? "where" : "which";
  try {
    const result = execFileSync(cmd, [name], { encoding: "utf-8" }).trim();
    // `where` on windows can return multiple lines, take the first
    return result.split("\n")[0].trim();
  } catch { return name; }
}

// ── Sandbox (srt) support ──

const SRT_BIN = SANDBOX_ENABLED ? resolveBin("srt") : "";
const SRT_AVAILABLE = SANDBOX_ENABLED && SRT_BIN !== "srt"; // resolveBin returns the bare name if not found

/** Path to the per-run srt settings file (cleaned up on exit). */
const SRT_SETTINGS_PATH = join(PROJECT_DIR, ".ralph-srt-settings.json");

/** Write srt settings file and return the path. */
function writeSrtSettings(allowedWriteDir: string): string {
  const settings = buildSrtSettings(allowedWriteDir);
  writeFileSync(SRT_SETTINGS_PATH, JSON.stringify(settings, null, 2));
  return SRT_SETTINGS_PATH;
}

/** Remove the srt settings file. */
function cleanupSrtSettings(): void {
  try { unlinkSync(SRT_SETTINGS_PATH); } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn("failed to clean up srt settings:", errMsg(e));
  }
}

interface AgentConfig {
  bin: string;
  args: (prompt: string) => string[];
}

const AGENTS: Record<string, AgentConfig> = {
  claude: {
    bin: resolveBin("claude"),
    args: (prompt) => ["--print", "--dangerously-skip-permissions", "--allowedTools", ALLOWED_TOOLS, "-p", prompt],
  },
  codex: {
    bin: resolveBin("codex"),
    args: (prompt) => ["exec", prompt, "--yolo"],
  },
  gemini: {
    bin: resolveBin("gemini"),
    args: (prompt) => ["-p", prompt, "--yolo"],
  },
  cursor: {
    bin: resolveBin("agent"),
    args: (prompt) => ["-p", prompt, "--yolo"],
  },
};

const agent = AGENTS[AGENT];
if (!agent) {
  console.error(`unknown agent: ${AGENT}. available: ${Object.keys(AGENTS).join(", ")}`);
  process.exit(1);
}

const LOCK_FILE = join(PROJECT_DIR, ".ralph.lock");

function removeLock(): void {
  try { unlinkSync(LOCK_FILE); } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn(`removeLock: failed to delete ${LOCK_FILE}:`, errMsg(e));
  }
}

function readPlan(): string {
  return readFileSync(PLAN_PATH, "utf-8");
}

/** Read completed task keys from progress.txt. Format: `DONE: checkbox: <text>` or `DONE: section: <header>` */
function readCompletedTasks(): Set<string> {
  const completed = new Set<string>();
  try {
    const content = readFileSync(PROGRESS_PATH, "utf-8");
    for (const line of content.split("\n")) {
      if (line.startsWith("DONE: ")) completed.add(line.slice(6));
    }
  } catch { /* no progress file yet */ }
  return completed;
}

/** Record a task as completed in progress.txt */
function markTaskCompleted(task: string, checkbox: boolean): void {
  const key = checkbox ? `checkbox: ${task}` : `section: ${taskSectionHeader(task) || task.split("\n")[0]}`;
  appendFileSync(PROGRESS_PATH, `DONE: ${key}\n`);
}

function extractCurrentTask(): { task: string; checkbox: boolean } | null {
  try {
    const plan = readPlan();
    const completed = readCompletedTasks();

    // try checkboxes first (subtasks appended at bottom)
    for (const line of plan.split("\n")) {
      const cbMatch = line.match(/^- \[ \] (.+)$/);
      if (cbMatch && !completed.has(`checkbox: ${cbMatch[1]}`)) {
        return { task: cbMatch[1], checkbox: true };
      }
    }

    // then section headers: find first ## or ### numbered header not yet completed
    const lines = plan.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (TASK_HEADER.test(line)) {
        if (completed.has(`section: ${line}`)) continue;
        const level = line.match(/^(#{2,3})/)?.[1] || "##";
        // collect the full section until the next header at same or higher level
        const sectionLines = [line];
        for (let j = i + 1; j < lines.length; j++) {
          const nextMatch = lines[j].match(/^(#{1,3}) /);
          if (nextMatch && nextMatch[1].length <= level.length) break;
          sectionLines.push(lines[j]);
        }
        // skip sections where all child checkboxes are completed
        const children = sectionLines.filter(l => /^- \[ \] /.test(l));
        const allChildrenDone = children.length > 0 && children.every(l => {
          const text = l.match(/^- \[ \] (.+)$/)?.[1];
          return text && completed.has(`checkbox: ${text}`);
        });
        if (allChildrenDone) continue;
        return { task: sectionLines.join("\n").trim(), checkbox: false };
      }
    }
    return null;
  } catch { return null; }
}

/** Extract the section header from a task — first line of section tasks. */
function taskSectionHeader(task: string): string | null {
  const line = task.split("\n")[0];
  return TASK_HEADER.test(line) ? line : null;
}

/** Enumerate all task keys in the plan — the same keys that markTaskCompleted writes. */
function extractAllTaskKeys(): string[] {
  try {
    const plan = readPlan();
    const keys: string[] = [];
    const lines = plan.split("\n");

    // checkboxes
    for (const line of lines) {
      const cbMatch = line.match(/^- \[ \] (.+)$/);
      if (cbMatch) keys.push(`checkbox: ${cbMatch[1]}`);
    }

    // section headers (only those without child checkboxes — sections with
    // children are considered done when all children are done, and only the
    // children appear as keys)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!TASK_HEADER.test(line)) continue;
      const level = line.match(/^(#{2,3})/)?.[1] || "##";
      const sectionLines = [line];
      for (let j = i + 1; j < lines.length; j++) {
        const nextMatch = lines[j].match(/^(#{1,3}) /);
        if (nextMatch && nextMatch[1].length <= level.length) break;
        sectionLines.push(lines[j]);
      }
      const hasChildren = sectionLines.some(l => /^- \[ \] /.test(l));
      if (!hasChildren) {
        keys.push(`section: ${line}`);
      }
    }

    return keys;
  } catch { return []; }
}

/** Check if every task in the plan has a matching DONE entry in progress.txt. */
function areAllTasksDone(): boolean {
  const keys = extractAllTaskKeys();
  if (keys.length === 0) return false;
  const completed = readCompletedTasks();
  return keys.every(k => completed.has(k));
}


function numberPlanTasks(): Promise<{ exitCode: number; output: string }> {
  const prompt = `You are reformatting a plan file for an automated task runner.

Read @${PLAN_FILE} — convert ALL task/implementation section headers to the canonical format: \`## N. Title\`.

Current headers may use ANY format — \`## Phase 1: Title\`, \`### Step 1 - Title\`, \`## 1) Title\`, \`### Task: Title\`, unnumbered \`## Title\`, etc. Convert them ALL to \`## N. Title\` (sequential numbering starting at 1).

If a task has sub-sections, convert those to \`## Na. Title\` (e.g. \`## 1a.\`, \`## 1b.\`).

Rules:
- ONLY convert headers that represent actionable tasks/steps
- Do NOT number context/overview/architecture/verification/summary sections
- Keep ALL content exactly as-is — only modify the header lines
- Use \`##\` (h2) for all task headers, not \`###\`
- Already-completed tasks (with ~~) should keep their ~~ markers
- Write the result back to @${PLAN_FILE} using the Write tool — do not output the file content`;

  return runIteration(prompt);
}

/** Build a recovery prompt when the plan file gets corrupted (task count shrinks). */
function buildRecoveryPrompt(originalContent: string, totalBefore: number, totalAfter: number): string {
  return `CRITICAL: The plan file ${PLAN_FILE} was corrupted during the last iteration.
The total task count shrank from ${totalBefore} to ${totalAfter}. Tasks were lost or reformatted into unparseable formats.

The plan file MUST use this format:
- Section headers: \`## N. Title\` (e.g. \`## 1. Add auth\`), subtasks: \`## Na. Title\` (e.g. \`## 1a. Tests\`)
- Checkbox format: \`- [ ] task\`
- Do NOT mark tasks as done in the plan file — completion is tracked separately.

Here is the ORIGINAL plan content before corruption:
\`\`\`
${originalContent}
\`\`\`

INSTRUCTIONS:
1. Read the current ${PLAN_FILE}
2. Compare it against the original content above
3. Restore ALL missing tasks — use the original as the source of truth
4. Write the fixed plan back to ${PLAN_FILE}
5. Do NOT add, remove, or reorder tasks beyond what the original had
6. Do NOT modify any other files or make commits

BEGIN.`;
}

/** Build the per-iteration prompt. RALPH_AGENT_CONTEXT is prepended so the agent
 *  knows subtask protocol and task conventions (see wolfpack-context.ts). */
function buildPrompt(taskDesc: string): string {
  return `${RALPH_AGENT_CONTEXT}

You may ONLY create/edit/delete files under ${workingDir}. Do NOT touch files outside this directory.

YOUR TASK:
${taskDesc}

INSTRUCTIONS:
1. If the task is concrete enough, implement it directly.
2. If it's too large or vague, break it into subtasks instead of implementing.
3. Run any relevant tests and type checks for what you built.
4. Commit your changes with a descriptive message.
5. Do NOT write to ${PROGRESS_FILE} — the task runner manages it automatically.

OUTPUT (always include):
<prereqs>
- list any prerequisites or assumptions
</prereqs>
<tests>
- list the tests you ran (or would run if not possible)
</tests>
<done>
- explicit criteria to consider the task complete
</done>

RULES:
- ONLY work on ONE task per iteration.
- If a task has sub-tasks, complete one sub-task.
- If you decide the task needs breakdown, output a <subtasks> block with one task per line, and DO NOT modify any files or make a commit in that iteration. Follow the Task Granularity rules from the context above.
- Do NOT write to ${PLAN_FILE}. The task runner handles all plan mutations. If you need subtasks, output a <subtasks> block.
- Do NOT remove or renumber tasks in the plan file.
- Be thorough but focused.

BEGIN.`;
}

// create progress file if missing
if (!existsSync(PROGRESS_PATH)) {
  writeFileSync(PROGRESS_PATH, "# Progress Log\n");
}

// write log header
writeFileSync(LOG_FILE, `🥋 ralph — ${ITERATIONS} iterations\n`);
appendFileSync(LOG_FILE, `agent: ${AGENT}\n`);
appendFileSync(LOG_FILE, `plan: ${PLAN_FILE}\n`);
appendFileSync(LOG_FILE, `progress: ${PROGRESS_FILE}\n`);
appendFileSync(LOG_FILE, `phase_cleanup: ${CLEANUP_ENABLED ? "on" : "off"}\n`);
appendFileSync(LOG_FILE, `phase_audit_fix: ${AUDIT_FIX_ENABLED ? "on" : "off"}\n`);
appendFileSync(LOG_FILE, `worktree: ${WORKTREE_MODE}\n`);
appendFileSync(LOG_FILE, `sandbox: ${SRT_AVAILABLE ? "srt" : SANDBOX_ENABLED ? "srt-not-found" : "off"}\n`);
appendFileSync(LOG_FILE, `pid: ${process.pid}\n`);
appendFileSync(LOG_FILE, `bin: ${agent.bin}\n`);
appendFileSync(LOG_FILE, `started: ${new Date().toString()}\n\n`);

if (SANDBOX_ENABLED && !SRT_AVAILABLE) {
  const msg = "⚠️  sandbox requested but srt not found — install with: npm i -g @anthropic-ai/sandbox-runtime";
  appendFileSync(LOG_FILE, `${msg}\n\n`);
  console.warn(msg);
}

// capture starting commit for summary diff
let START_COMMIT = "";
try { START_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_DIR, encoding: "utf-8" }).trim(); } catch (e: unknown) {
  console.warn(`could not capture starting commit:`, errMsg(e));
}

function getCurrentBranch(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf-8" }).trim();
  } catch (e: unknown) {
    console.warn(`getCurrentBranch: git rev-parse failed, defaulting to "HEAD":`, errMsg(e));
    return "HEAD";
  }
}

/** Generate a worktree branch name from task header. */
function worktreeBranchName(taskHeader: string, iterationIndex: number): string {
  const numMatch = taskHeader.match(/^##\s*(\d+[a-z]?)\./);
  const num = numMatch ? numMatch[1] : String(iterationIndex);
  const slug = slugifyTaskName(taskHeader);
  return `ralph/${num}-${slug}`;
}

function parseSubtasks(output: string): string[] {
  const match = output.match(/<subtasks>([\s\S]*?)<\/subtasks>/);
  if (!match) return [];
  return match[1].split("\n").map(l => l.trim()).filter(l => l.length > 0);
}

function appendSubtasksToPlan(subtasks: string[]): void {
  // sanitize: strip markdown headers and strikethrough markers
  const safe = subtasks.map(t => t.replace(/^#+\s*/, "").replace(/~~/g, "").trim()).filter(Boolean);
  const lines = safe.map(t => `- [ ] ${t}`).join("\n");
  appendFileSync(PLAN_PATH, "\n" + lines + "\n");
}

function dedupCheckboxes(): void {
  try {
    const plan = readPlan();
    const lines = plan.split("\n");
    const seen = new Set<string>();
    const checkedTexts = new Set<string>();

    // first pass: collect all checked checkbox texts
    for (const line of lines) {
      const m = line.match(/^- \[x\] (.+)$/);
      if (m) checkedTexts.add(m[1]);
    }

    // second pass: filter duplicates
    const out: string[] = [];
    for (const line of lines) {
      const m = line.match(/^- \[ \] (.+)$/);
      if (m) {
        const text = m[1];
        // drop if already checked elsewhere or if duplicate unchecked
        if (checkedTexts.has(text) || seen.has(text)) continue;
        seen.add(text);
      }
      out.push(line);
    }

    if (out.length !== lines.length) {
      writeFileSync(PLAN_PATH, out.join("\n"));
    }
  } catch (e: unknown) {
    console.error(`dedupCheckboxes: failed to deduplicate plan:`, errMsg(e));
  }
}

/** Remove ITER_FILE, silencing ENOENT. */
function cleanupIterFile(): void {
  try { unlinkSync(ITER_FILE); } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn(`failed to clean up iter file:`, errMsg(e));
  }
}

const ITERATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes per iteration

// track active child for signal handling
let activeChild: ReturnType<typeof nodeSpawn> | null = null;
let stopping = false;

function runIteration(prompt: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];

    // Wrap with srt sandbox if available
    let spawnBin: string;
    let spawnArgs: string[];
    if (SRT_AVAILABLE) {
      writeSrtSettings(workingDir);
      // srt joins positional args with spaces then runs via `bash -c`, so args
      // containing shell metacharacters (e.g. parentheses in --allowedTools)
      // must be passed through `-c` with proper quoting.
      const innerCmd = [agent.bin, ...agent.args(prompt)]
        .map(a => shellEscape(a))
        .join(" ");
      spawnBin = SRT_BIN;
      spawnArgs = ["--settings", SRT_SETTINGS_PATH, "-c", innerCmd];
    } else {
      spawnBin = agent.bin;
      spawnArgs = agent.args(prompt);
    }

    const child = nodeSpawn(spawnBin, spawnArgs, {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;

    const timeout = setTimeout(() => {
      appendFileSync(LOG_FILE, `\n=== ⚠️  Iteration timed out after ${ITERATION_TIMEOUT_MS / 60000}min — killing agent ===\n`);
      if (child.pid) killProcessTree(child.pid).catch((e) => { appendFileSync(LOG_FILE, `kill error: ${errMsg(e)}\n`); });
    }, ITERATION_TIMEOUT_MS);

    child.stdout?.on("data", (d: Buffer) => {
      chunks.push(d);
      appendFileSync(LOG_FILE, d.toString("utf-8"));
    });
    child.stderr?.on("data", (d: Buffer) => {
      chunks.push(d);
      appendFileSync(LOG_FILE, d.toString("utf-8"));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      activeChild = null;
      resolve({ exitCode: code ?? 1, output: Buffer.concat(chunks).toString("utf-8") });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      activeChild = null;
      appendFileSync(LOG_FILE, `spawn error: ${err.message}\n`);
      resolve({ exitCode: 1, output: `spawn error: ${err.message}\n` });
    });
  });
}

// last-resort lock + srt settings cleanup on any exit (covers unhandled exceptions, SIGINT, etc.)
process.on("exit", () => { removeLock(); cleanupSrtSettings(); });

// clean up child process, worktrees, and lock on SIGTERM
process.on("SIGTERM", () => {
  stopping = true;
  appendFileSync(LOG_FILE, `\n=== 🛑 Received SIGTERM — cleaning up ===\n`);
  if (activeChild?.pid) {
    killProcessTreeSync(activeChild.pid);
  }
  if (WORKTREE_MODE !== "false") {
    try {
      const result = cleanupAllExceptFinal(PROJECT_DIR);
      if (result.removed.length > 0) {
        appendFileSync(LOG_FILE, `worktrees cleaned up: removed ${result.removed.join(", ")}, kept ${result.kept}\n`);
      }
    } catch (err: unknown) {
      appendFileSync(LOG_FILE, `worktree cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  // sync plan to PROJECT_DIR before exit so UI has latest state
  syncPlanToProject();
  appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
  removeLock();
  cleanupSrtSettings();
  setTimeout(() => process.exit(0), 3500);
});

function logSummary(tasksCompleted: number, subtasksAdded: number): void {
  const startMatch = readFileSync(LOG_FILE, "utf-8").match(/^started: (.+)$/m);
  const started = startMatch ? new Date(startMatch[1]) : null;
  const elapsed = started ? Math.round((Date.now() - started.getTime()) / 1000) : 0;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  // task counts from plan file
  const plan = readPlan();
  const { done, total } = countTasksInContent(plan);

  // files changed via git (committed since start + uncommitted)
  let filesChanged: string[] = [];
  let uncommitted: string[] = [];
  const diffCwd = mainWorkDir;
  try {
    const ref = START_COMMIT || "HEAD";
    const diff = execFileSync("git", ["diff", "--name-only", ref, "HEAD"], { cwd: diffCwd, encoding: "utf-8" });
    filesChanged = diff.trim().split("\n").filter(Boolean);
  } catch (e: unknown) {
    console.warn(`logSummary: git diff failed:`, errMsg(e));
  }
  try {
    const wt = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: diffCwd, encoding: "utf-8" });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: diffCwd, encoding: "utf-8" });
    uncommitted = [...wt.trim().split("\n"), ...untracked.trim().split("\n")].filter(Boolean);
  } catch (e: unknown) {
    console.warn(`logSummary: uncommitted files check failed:`, errMsg(e));
  }

  appendFileSync(LOG_FILE, `\n=== 📊 Summary ===\n`);
  appendFileSync(LOG_FILE, `duration: ${mins}m ${secs}s\n`);
  appendFileSync(LOG_FILE, `tasks completed this run: ${tasksCompleted}\n`);
  appendFileSync(LOG_FILE, `plan progress: ${done}/${total} done\n`);
  if (subtasksAdded > 0) {
    appendFileSync(LOG_FILE, `subtasks added: ${subtasksAdded}\n`);
  }
  if (filesChanged.length > 0) {
    appendFileSync(LOG_FILE, `files changed (${filesChanged.length}):\n`);
    for (const f of filesChanged) appendFileSync(LOG_FILE, `  ${f}\n`);
  } else {
    appendFileSync(LOG_FILE, `files changed: none\n`);
  }
  if (uncommitted.length > 0) {
    appendFileSync(LOG_FILE, `uncommitted (${uncommitted.length}):\n`);
    for (const f of uncommitted) appendFileSync(LOG_FILE, `  ${f}\n`);
  }
  appendFileSync(LOG_FILE, `==================\n`);
}

/** Copy plan and progress from mainWorkDir into a task sub-worktree (gitignored files). */
function syncFilesToWorktree(): void {
  if (workingDir === mainWorkDir) return;
  try { copyFileSync(PLAN_PATH, join(workingDir, PLAN_FILE)); } catch (e: unknown) {
    console.error(`syncFilesToWorktree: failed to copy plan file:`, errMsg(e));
  }
  if (existsSync(PROGRESS_PATH)) {
    try { copyFileSync(PROGRESS_PATH, join(workingDir, PROGRESS_FILE)); } catch (e: unknown) {
      console.error(`syncFilesToWorktree: failed to copy progress file:`, errMsg(e));
    }
  }
}

/** Copy progress from task sub-worktree back to mainWorkDir. */
function syncProgressBack(): void {
  if (workingDir === mainWorkDir) return;
  const wtProgress = join(workingDir, PROGRESS_FILE);
  if (existsSync(wtProgress)) {
    try { copyFileSync(wtProgress, PROGRESS_PATH); } catch (e: unknown) {
      console.error(`syncProgressBack: failed to copy progress from worktree:`, errMsg(e));
    }
  }
}

/** Copy plan from mainWorkDir → PROJECT_DIR so the UI can read it. No-op if same dir. */
function syncPlanToProject(): void {
  if (mainWorkDir === PROJECT_DIR) return;
  const mainPlan = join(PROJECT_DIR, PLAN_FILE);
  if (existsSync(PLAN_PATH)) {
    try { copyFileSync(PLAN_PATH, mainPlan); } catch (e: unknown) {
      console.error(`syncPlanToProject: failed to copy plan to project dir:`, errMsg(e));
    }
  }
}

/** Merge a task sub-worktree branch into mainWorkDir. Returns true on success. */
function mergeTaskBranch(taskBranch: string): boolean {
  try {
    execFileSync("git", ["merge", "-m", `ralph: merge ${taskBranch}`, taskBranch], {
      cwd: mainWorkDir,
      stdio: "pipe",
    });
    return true;
  } catch (e: unknown) {
    appendFileSync(LOG_FILE, `merge error: ${errMsg(e)}\n`);
    // abort the failed merge so mainWorkDir is clean
    try { execFileSync("git", ["merge", "--abort"], { cwd: mainWorkDir, stdio: "pipe" }); } catch { /* already clean */ }
    return false;
  }
}

/** Clean up a task sub-worktree after merge. */
function cleanupTaskWorktree(worktreePath: string): void {
  try {
    removeWorktree(worktreePath, PROJECT_DIR);
  } catch (e: unknown) {
    appendFileSync(LOG_FILE, `warning: failed to remove task worktree ${worktreePath}: ${errMsg(e)}\n`);
  }
}

/** Create or reuse the main accumulator worktree (shared by plan and task modes).
 *  On restart, finds the existing worktree for the branch and resumes from there. */
function createMainWorktree(): void {
  const baseBranch = WORKTREE_BASE || getCurrentBranch(PROJECT_DIR);
  const planSlug = PLAN_FILE.replace(/\.md$/i, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const branchName = WORKTREE_BRANCH || `ralph/plan-${planSlug}`;

  // check if worktree for this branch already exists (restart case)
  const existing = listWorktrees(PROJECT_DIR).find(w => w.branch === branchName);
  if (existing) {
    mainWorkDir = existing.path;
    workingDir = mainWorkDir;
    PLAN_PATH = join(mainWorkDir, PLAN_FILE);
    PROGRESS_PATH = join(mainWorkDir, PROGRESS_FILE);
    appendFileSync(LOG_FILE, `worktree reused: ${mainWorkDir} (branch ${branchName})\n`);
    appendFileSync(LOG_FILE, `workdir: ${mainWorkDir}\n\n`);
    try { START_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { cwd: mainWorkDir, encoding: "utf-8" }).trim(); } catch (e: unknown) {
      console.warn(`could not capture worktree starting commit:`, errMsg(e));
    }
    // on restart, worktree already has plan+progress from previous run — don't overwrite
    // only copy if missing (e.g. worktree was cleaned but branch survived)
    if (!existsSync(PLAN_PATH)) {
      const projectPlan = join(PROJECT_DIR, PLAN_FILE);
      if (existsSync(projectPlan)) copyFileSync(projectPlan, PLAN_PATH);
    }
    if (!existsSync(PROGRESS_PATH)) {
      const projectProgress = join(PROJECT_DIR, PROGRESS_FILE);
      if (existsSync(projectProgress)) copyFileSync(projectProgress, PROGRESS_PATH);
    }
    return;
  }

  // fresh start — create new worktree
  // Delete orphan branch from a previous run (worktree cleaned up but branch survived).
  // Start fresh to avoid inheriting dirty state.
  try {
    execFileSync("git", ["rev-parse", "--verify", branchName], { cwd: PROJECT_DIR, stdio: "pipe" });
    // Branch exists without a worktree — delete it so createWorktree can start clean
    appendFileSync(LOG_FILE, `deleting orphan branch ${branchName} from previous run\n`);
    execFileSync("git", ["branch", "-D", "--", branchName], { cwd: PROJECT_DIR, stdio: "pipe" });
  } catch { /* branch doesn't exist — good */ }

  try {
    mainWorkDir = createWorktree(PROJECT_DIR, branchName, baseBranch);
    appendFileSync(LOG_FILE, `worktree created: ${mainWorkDir} (branch ${branchName}, base ${baseBranch})\n`);
    workingDir = mainWorkDir;
    PLAN_PATH = join(mainWorkDir, PLAN_FILE);
    PROGRESS_PATH = join(mainWorkDir, PROGRESS_FILE);
    appendFileSync(LOG_FILE, `workdir: ${mainWorkDir}\n\n`);
    try { START_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { cwd: mainWorkDir, encoding: "utf-8" }).trim(); } catch (e: unknown) {
      console.warn(`could not capture worktree starting commit:`, errMsg(e));
    }
    // copy gitignored files into worktree
    const projectPlan = join(PROJECT_DIR, PLAN_FILE);
    const projectProgress = join(PROJECT_DIR, PROGRESS_FILE);
    if (existsSync(projectPlan)) copyFileSync(projectPlan, PLAN_PATH);
    if (existsSync(projectProgress)) copyFileSync(projectProgress, PROGRESS_PATH);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    appendFileSync(LOG_FILE, `\n=== ❌ Failed to create main worktree: ${msg} ===\n`);
    removeLock();
    process.exit(1);
  }
}

async function main() {
  let maxIterations = ITERATIONS;

  // Format/dedup/validate run BEFORE worktree creation — they operate on the
  // plan in PROJECT_DIR and need agent cwd to match (workingDir === PROJECT_DIR here).

  // Number plan tasks if requested by the server
  if (FORMAT_PLAN) {
    appendFileSync(LOG_FILE, `\n=== 🥋 Numbering plan tasks — ${new Date().toString()} ===\n`);
    const { exitCode } = await numberPlanTasks();
    if (exitCode !== 0) {
      appendFileSync(LOG_FILE, `=== ⚠️  Numbering failed (exit code ${exitCode}) — ${new Date().toString()} ===\n`);
    } else {
      appendFileSync(LOG_FILE, `=== ✅ Numbering complete — ${new Date().toString()} ===\n`);
    }
  }

  // Clean up duplicate checkboxes from prior crashed/interrupted runs
  dedupCheckboxes();

  // Validate plan format before entering iteration loop
  const planValidation = validatePlanFormat(readPlan());
  if (!planValidation.valid) {
    const issueList = planValidation.issues.map(i => `  - ${i}`).join("\n");
    const msg = `Plan validation failed:\n${issueList}`;
    appendFileSync(LOG_FILE, `\n=== ❌ ${msg} ===\n`);
    console.error(msg);
    removeLock();
    process.exit(1);
  }

  // --- Worktree setup (AFTER format/dedup/validate so those run in PROJECT_DIR) ---
  if (WORKTREE_MODE === "plan" || WORKTREE_MODE === "task") {
    createMainWorktree();
  }

  // In task mode, clean up orphan sub-worktrees from crashed/interrupted runs
  if (WORKTREE_MODE === "task") {
    const worktrees = listWorktrees(PROJECT_DIR);
    const mainBranch = getCurrentBranch(mainWorkDir);
    const orphans = worktrees.filter(w =>
      w.path !== mainWorkDir &&
      w.path !== PROJECT_DIR &&
      w.branch.startsWith("ralph/") &&
      w.branch !== mainBranch,
    );
    for (const orphan of orphans) {
      appendFileSync(LOG_FILE, `cleaning up orphan task worktree: ${orphan.branch} (${orphan.path})\n`);
      try { removeWorktree(orphan.path, PROJECT_DIR); } catch (e: unknown) {
        appendFileSync(LOG_FILE, `warning: failed to remove orphan worktree ${orphan.path}: ${errMsg(e)}\n`);
      }
      try { execFileSync("git", ["branch", "-D", "--", orphan.branch], { cwd: PROJECT_DIR, stdio: "pipe" }); } catch (e: unknown) {
        appendFileSync(LOG_FILE, `warning: failed to delete orphan branch ${orphan.branch}: ${errMsg(e)}\n`);
      }
    }
  }

  // In task mode, track the current section task so we reuse the same sub-worktree
  // for all iterations (checkbox subtasks) within a single section task.
  let currentTaskHeader: string | null = null;
  let currentTaskWorktree: string | null = null;
  let currentTaskBranch: string | null = null;

  let subtaskExpansions = 0;
  let tasksCompleted = 0;
  let subtasksAdded = 0;
  const MAX_SUBTASK_EXPANSIONS = 5;
  let lastTask: string | null = null;
  let lastWasSubtaskEmission = false;

  for (let i = 1; i <= maxIterations; i++) {
    if (stopping) break;
    // extract current task from plan
    const result = extractCurrentTask();
    if (!result) {
      // Strict all-done detection: every plan task has a matching DONE key in progress.txt
      const allDone = areAllTasksDone();
      const planContent = readPlan().trim();
      const hasSubstantiveContent = !allDone && planContent.split("\n").some(l => /^#{2,3} /.test(l) || /^- \[ \] /.test(l));
      const msg = allDone
        ? "All tasks completed"
        : hasSubstantiveContent
        ? "Plan has content but no parseable tasks — format may be corrupted"
        : "No unchecked tasks remain";
      appendFileSync(LOG_FILE, `\n=== ${hasSubstantiveContent ? "⚠️" : "🥋"} ${msg} — ${new Date().toString()} ===\n`);
      if (allDone) appendFileSync(LOG_FILE, `all_tasks_done: true\n`);
      // merge any outstanding task worktree before finishing
      if (currentTaskWorktree && currentTaskBranch) {
        syncProgressBack();
        if (!mergeTaskBranch(currentTaskBranch)) {
          appendFileSync(LOG_FILE, `\n=== ❌ Merge failed for ${currentTaskBranch} into main worktree — stopping ===\n`);
          syncPlanToProject();
          logSummary(tasksCompleted, subtasksAdded);
          appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
          removeLock();
          process.exit(1);
        }
        cleanupTaskWorktree(currentTaskWorktree);
        workingDir = mainWorkDir;
        currentTaskWorktree = null;
        currentTaskBranch = null;
        currentTaskHeader = null;
      }
      if (i > 1) await runFinalPhases();
      syncPlanToProject();
      logSummary(tasksCompleted, subtasksAdded);
      appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
      process.exit(0);
    }

    const { task, checkbox } = result;

    // same-task-twice guard: if we picked the same task again, force-mark done in progress
    if (task === lastTask && !lastWasSubtaskEmission) {
      appendFileSync(LOG_FILE, `\n=== ⚠️ Same task picked twice — force-marking done ===\n`);
      markTaskCompleted(task, checkbox);
      lastTask = null;
      lastWasSubtaskEmission = false;
      continue;
    }

    // --- Task mode: manage per-section sub-worktrees ---
    if (WORKTREE_MODE === "task") {
      // determine which section this iteration belongs to
      const header = checkbox ? null : taskSectionHeader(task);
      const isNewSection = header && header !== currentTaskHeader;

      // if we moved to a new section, merge+cleanup the previous sub-worktree
      if (isNewSection && currentTaskWorktree && currentTaskBranch) {
        syncProgressBack();
        if (!mergeTaskBranch(currentTaskBranch)) {
          appendFileSync(LOG_FILE, `\n=== ❌ Merge failed for ${currentTaskBranch} into main worktree — stopping ralph ===\n`);
          appendFileSync(LOG_FILE, `Task worktree preserved at: ${currentTaskWorktree}\n`);
          appendFileSync(LOG_FILE, `Main worktree: ${mainWorkDir}\n`);
          syncPlanToProject();
          logSummary(tasksCompleted, subtasksAdded);
          appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
          removeLock();
          process.exit(1);
        }
        cleanupTaskWorktree(currentTaskWorktree);
        workingDir = mainWorkDir;
        currentTaskWorktree = null;
        currentTaskBranch = null;
        currentTaskHeader = null;
      }

      // create new sub-worktree for a new section task
      if (header && !currentTaskWorktree) {
        let branchName = worktreeBranchName(header, i);
        // avoid branch collision
        try {
          execFileSync("git", ["rev-parse", "--verify", branchName], { cwd: PROJECT_DIR, stdio: "pipe" });
          branchName = `${branchName}-${Date.now() % 100000}`;
        } catch { /* branch doesn't exist — good */ }
        try {
          const mainBranch = getCurrentBranch(mainWorkDir);
          currentTaskWorktree = createWorktree(PROJECT_DIR, branchName, mainBranch);
          currentTaskBranch = branchName;
          currentTaskHeader = header;
          workingDir = currentTaskWorktree;
          appendFileSync(LOG_FILE, `task worktree created: ${currentTaskWorktree} (branch ${branchName}, base ${mainBranch})\n`);
          syncFilesToWorktree();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          appendFileSync(LOG_FILE, `\n=== ⚠️ Failed to create task worktree: ${msg} — running in main worktree ===\n`);
          workingDir = mainWorkDir;
        }
      }

      // checkbox subtask with an active task worktree — reuse it, just re-sync plan
      if (checkbox && currentTaskWorktree) {
        syncFilesToWorktree();
      }

      // checkbox subtask with no active worktree (e.g. orphan checkbox) — run in mainWorkDir
      if (checkbox && !currentTaskWorktree) {
        workingDir = mainWorkDir;
      }
    }

    // snapshot plan state before iteration for corruption detection
    const planSnapshot = readPlan();
    const { total: totalBefore } = countTasksInContent(planSnapshot);

    const prompt = buildPrompt(task);
    appendFileSync(LOG_FILE, `\n=== 🥋 Wax On ${i}/${maxIterations} — ${new Date().toString()} ===\n`);
    appendFileSync(LOG_FILE, `task: ${task}\n\n`);

    const { exitCode, output } = await runIteration(prompt);

    // write iter file for inspection
    writeFileSync(ITER_FILE, output);

    // plan corruption detection: check that task count didn't shrink
    // (completion is tracked in progress.txt, not in plan markers)
    const afterCounts = countTasksInContent(readPlan());
    if (afterCounts.total < totalBefore) {
      const reason = `task count shrank from ${totalBefore} to ${afterCounts.total}`;
      appendFileSync(LOG_FILE, `\n=== ⚠️ Plan corruption detected: ${reason} — attempting recovery ===\n`);
      const recoveryPrompt = buildRecoveryPrompt(planSnapshot, totalBefore, afterCounts.total);
      const { exitCode: recoveryExit } = await runIteration(recoveryPrompt);
      appendFileSync(LOG_FILE, `\n=== Recovery agent exited (code ${recoveryExit}) ===\n`);
      const recoveredCounts = countTasksInContent(readPlan());
      if (recoveredCounts.total < totalBefore) {
        appendFileSync(LOG_FILE, `\n=== ⚠️ Recovery failed (${recoveredCounts.total} tasks) — restoring from backup ===\n`);
        writeFileSync(PLAN_PATH, planSnapshot);
      } else {
        appendFileSync(LOG_FILE, `\n=== ✅ Plan recovered (${recoveredCounts.total} tasks) ===\n`);
      }
      cleanupIterFile();
      continue;
    }

    if (exitCode !== 0) {
      appendFileSync(LOG_FILE, `\n=== ⚠️  Iteration ${i} FAILED (exit code ${exitCode}) — ${new Date().toString()} ===\n\n`);
      cleanupIterFile();
      continue;
    }

    // check for subtask breakdown (capped to prevent unbounded expansion)
    const subtasks = parseSubtasks(output);
    const MAX_CEILING = Math.max(ITERATIONS * 2, 100);
    if (subtasks.length > 0 && subtaskExpansions < MAX_SUBTASK_EXPANSIONS) {
      subtaskExpansions++;
      subtasksAdded += subtasks.length;
      appendSubtasksToPlan(subtasks);
      // mark parent done so it's never re-picked
      markTaskCompleted(task, checkbox);
      maxIterations = expandBudget(maxIterations, subtasks.length, MAX_CEILING);
      appendFileSync(LOG_FILE, `\n=== 🧩 Subtasks detected (${subtasks.length}) — extended to ${maxIterations} iterations (ceiling ${MAX_CEILING}, expansions ${subtaskExpansions}/${MAX_SUBTASK_EXPANSIONS}) ===\n`);
      for (const st of subtasks) appendFileSync(LOG_FILE, `  + ${st}\n`);
      lastTask = task;
      lastWasSubtaskEmission = true;
      cleanupIterFile();
      continue;
    }

    lastTask = task;
    lastWasSubtaskEmission = false;

    appendFileSync(LOG_FILE, `\n=== ✅ Iteration ${i} complete — ${new Date().toString()} ===\n`);
    tasksCompleted++;

    // sync progress back from task sub-worktree to mainWorkDir
    syncProgressBack();

    // record task completion in progress file
    markTaskCompleted(task, checkbox);

    // sync plan to PROJECT_DIR for UI
    syncPlanToProject();

    cleanupIterFile();
  }

  // merge any outstanding task worktree at end of iterations
  if (currentTaskWorktree && currentTaskBranch) {
    syncProgressBack();
    if (!mergeTaskBranch(currentTaskBranch)) {
      appendFileSync(LOG_FILE, `\n=== ❌ Merge failed for ${currentTaskBranch} into main worktree — stopping ===\n`);
      appendFileSync(LOG_FILE, `Task worktree preserved at: ${currentTaskWorktree}\n`);
      appendFileSync(LOG_FILE, `Main worktree: ${mainWorkDir}\n`);
      syncPlanToProject();
      logSummary(tasksCompleted, subtasksAdded);
      appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
      removeLock();
      process.exit(1);
    } else {
      cleanupTaskWorktree(currentTaskWorktree);
    }
    workingDir = mainWorkDir;
  }

  appendFileSync(LOG_FILE, `=== Completed ${maxIterations} iterations ===\n`);
  const remaining = extractCurrentTask();
  if (!remaining) {
    if (areAllTasksDone()) appendFileSync(LOG_FILE, `all_tasks_done: true\n`);
    await runFinalPhases();
  } else {
    appendFileSync(LOG_FILE, `=== ⏭️  Skipping final phases — tasks still remain ===\n`);
  }
  syncPlanToProject();
  logSummary(tasksCompleted, subtasksAdded);
  appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
}

function getAuditFixPrompt(): string {
  return buildAuditFixPrompt({
    projectDir: mainWorkDir,
    planFile: PLAN_FILE,
    progressFile: PROGRESS_FILE,
    diffBase: resolveCleanupDiffBase(START_COMMIT),
  });
}

function getCleanupPrompt(): string {
  return buildCleanupPrompt({
    projectDir: mainWorkDir,
    planFile: PLAN_FILE,
    progressFile: PROGRESS_FILE,
    diffBase: resolveCleanupDiffBase(START_COMMIT),
  });
}

async function runAuditFix(): Promise<void> {
  appendFileSync(LOG_FILE, `\n=== 🥋 Wax Inspect — starting audit+fix — ${new Date().toString()} ===\n\n`);
  // final phases run in mainWorkDir
  workingDir = mainWorkDir;
  const { exitCode, output } = await runIteration(getAuditFixPrompt());
  writeFileSync(ITER_FILE, output);

  if (exitCode !== 0) {
    appendFileSync(LOG_FILE, `\n=== ⚠️  Wax Inspect FAILED (exit code ${exitCode}) — ${new Date().toString()} ===\n\n`);
  } else {
    appendFileSync(LOG_FILE, `\n=== ✅ Wax Inspect complete — ${new Date().toString()} ===\n`);
  }
  cleanupIterFile();
}

async function runCleanup(): Promise<void> {
  appendFileSync(LOG_FILE, `\n=== 🥋 Wax Off — starting cleanup — ${new Date().toString()} ===\n\n`);
  workingDir = mainWorkDir;
  const { exitCode, output } = await runIteration(getCleanupPrompt());
  writeFileSync(ITER_FILE, output);

  if (exitCode !== 0) {
    appendFileSync(LOG_FILE, `\n=== ⚠️  Wax Off FAILED (exit code ${exitCode}) — ${new Date().toString()} ===\n\n`);
  } else {
    appendFileSync(LOG_FILE, `\n=== ✅ Wax Off complete — ${new Date().toString()} ===\n`);
  }
  cleanupIterFile();
}

async function runFinalPhases(): Promise<void> {
  if (AUDIT_FIX_ENABLED) {
    await runAuditFix();
  } else {
    appendFileSync(LOG_FILE, `=== ⏭️  Skipping audit+fix — phase disabled ===\n`);
  }

  if (CLEANUP_ENABLED) {
    await runCleanup();
  } else {
    appendFileSync(LOG_FILE, `=== ⏭️  Skipping cleanup — phase disabled ===\n`);
  }
}

main().then(() => {
  removeLock();
}).catch((err) => {
  appendFileSync(LOG_FILE, `\nFATAL: ${errMsg(err)}\n`);
  appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
  removeLock();
  process.exit(1);
});
