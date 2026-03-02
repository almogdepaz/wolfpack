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
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { RALPH_AGENT_CONTEXT, countTasksInContent, validatePlanFormat } from "./wolfpack-context.js";
import {
  extractCurrentTask,
  markSectionDone,
  markCheckboxDone,
  appendSubtasksToPlan,
  parseSubtasks,
  runAgentIteration,
  type AgentSpawnConfig,
} from "./shared/task-iteration.js";

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    iterations: { type: "string", default: "5" },
    plan: { type: "string", default: "PLAN.md" },
    progress: { type: "string", default: "progress.txt" },
    agent: { type: "string", default: "claude" },
    format: { type: "boolean", default: false },
  },
});

const ITERATIONS = Number(args.iterations) || 5;
const PLAN_FILE = args.plan!;
const PROGRESS_FILE = args.progress!;
const AGENT = args.agent!;
const FORMAT_PLAN = args.format!;
const PROJECT_DIR = process.cwd();
const LOG_FILE = join(PROJECT_DIR, ".ralph.log");
const ITER_FILE = join(PROJECT_DIR, ".ralph_iter.tmp");

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


const AGENTS: Record<string, AgentSpawnConfig> = {
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

const PLAN_PATH = join(PROJECT_DIR, PLAN_FILE);
const PROGRESS_PATH = join(PROJECT_DIR, PROGRESS_FILE);
const LOCK_FILE = join(PROJECT_DIR, ".ralph.lock");

function removeLock(): void {
  try { unlinkSync(LOCK_FILE); } catch {}
}

function readPlan(): string {
  return readFileSync(PLAN_PATH, "utf-8");
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

  return runAgentIteration(prompt, PROJECT_DIR, agent, ITERATION_TIMEOUT_MS, LOG_FILE);
}

/** Build a recovery prompt when the plan file gets corrupted (task count shrinks). */
function buildRecoveryPrompt(originalContent: string, totalBefore: number, totalAfter: number): string {
  return `CRITICAL: The plan file ${PLAN_FILE} was corrupted during the last iteration.
The total task count shrank from ${totalBefore} to ${totalAfter}. Tasks were lost or reformatted into unparseable formats.

The plan file MUST use this format:
- Section headers: \`## N. Title\` (e.g. \`## 1. Add auth\`), subtasks: \`## Na. Title\` (e.g. \`## 1a. Tests\`)
- Completed tasks: wrap title in \`~~\` (e.g. \`## ~~1. Done~~\`)
- OR checkbox format: \`- [ ] task\` / \`- [x] done\`

Here is the ORIGINAL plan content before corruption:
\`\`\`
${originalContent}
\`\`\`

INSTRUCTIONS:
1. Read the current ${PLAN_FILE}
2. Compare it against the original content above
3. Restore ALL missing tasks — use the original as the source of truth
4. Preserve any tasks that were legitimately marked as completed (~~strikethrough~~ or [x])
5. Write the fixed plan back to ${PLAN_FILE}
6. Do NOT add, remove, or reorder tasks beyond what the original had
7. Do NOT modify any other files or make commits

BEGIN.`;
}

/** Build the per-iteration prompt. RALPH_AGENT_CONTEXT is prepended so the agent
 *  knows subtask protocol and task conventions (see wolfpack-context.ts). */
function buildPrompt(taskDesc: string): string {
  return `${RALPH_AGENT_CONTEXT}

You may ONLY create/edit/delete files under ${PROJECT_DIR}. Do NOT touch files outside this directory.

YOUR TASK:
${taskDesc}

INSTRUCTIONS:
1. If the task is concrete enough, implement it directly.
2. If it's too large or vague, break it into subtasks instead of implementing.
3. Run any relevant tests and type checks for what you built.
4. Update ${PROGRESS_FILE} with what was done (append, don't overwrite).
5. Commit your changes with a descriptive message.

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
- Do NOT remove or renumber tasks in the plan file. You may add subtasks, but do NOT delete existing headers or checkboxes — the task runner tracks completion by counting them.
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
appendFileSync(LOG_FILE, `pid: ${process.pid}\n`);
appendFileSync(LOG_FILE, `bin: ${agent.bin}\n`);
appendFileSync(LOG_FILE, `started: ${new Date().toString()}\n\n`);

// capture starting commit for summary diff
let START_COMMIT = "";
try { START_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_DIR, encoding: "utf-8" }).trim(); } catch {}


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
  } catch {}
}

const ITERATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes per iteration

function runIteration(prompt: string): Promise<{ exitCode: number; output: string }> {
  return runAgentIteration(prompt, PROJECT_DIR, agent, ITERATION_TIMEOUT_MS, LOG_FILE);
}

// last-resort lock cleanup on any exit (covers unhandled exceptions, SIGINT, etc.)
process.on("exit", removeLock);

// clean up lock on SIGTERM
process.on("SIGTERM", () => {
  appendFileSync(LOG_FILE, `\n=== 🛑 Received SIGTERM — cleaning up ===\n`);
  appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
  removeLock();
  setTimeout(() => process.exit(0), 500);
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
  try {
    const ref = START_COMMIT || "HEAD";
    const diff = execFileSync("git", ["diff", "--name-only", ref, "HEAD"], { cwd: PROJECT_DIR, encoding: "utf-8" });
    filesChanged = diff.trim().split("\n").filter(Boolean);
  } catch {}
  try {
    const wt = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: PROJECT_DIR, encoding: "utf-8" });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: PROJECT_DIR, encoding: "utf-8" });
    uncommitted = [...wt.trim().split("\n"), ...untracked.trim().split("\n")].filter(Boolean);
  } catch {}

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

async function main() {
  let maxIterations = ITERATIONS;

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

  let subtaskExpansions = 0;
  let tasksCompleted = 0;
  let subtasksAdded = 0;
  const MAX_SUBTASK_EXPANSIONS = 5;
  let lastTask: string | null = null;
  let lastWasSubtaskEmission = false;

  for (let i = 1; i <= maxIterations; i++) {
    // extract current task from plan
    const result = extractCurrentTask(PLAN_PATH);
    if (!result) {
      // Check if plan has content but nothing parseable — possible format corruption
      const planContent = readPlan().trim();
      const hasSubstantiveContent = planContent.split("\n").some(l => /^#{2,3} /.test(l) || /^- /.test(l));
      const msg = hasSubstantiveContent
        ? "Plan has content but no parseable tasks — format may be corrupted"
        : "No unchecked tasks remain";
      appendFileSync(LOG_FILE, `\n=== ${hasSubstantiveContent ? "⚠️" : "🥋"} ${msg} — ${new Date().toString()} ===\n`);
      if (i > 1) await runCleanup();
      logSummary(tasksCompleted, subtasksAdded);
      appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
      process.exit(0);
    }

    const { task, checkbox } = result;

    // same-task-twice guard: if we picked the same task after a subtask emission,
    // the parent wasn't marked done — force it now
    if (task === lastTask && lastWasSubtaskEmission) {
      appendFileSync(LOG_FILE, `\n=== ⚠️ Same task picked twice after subtask emission — force-marking parent done ===\n`);
      if (checkbox) markCheckboxDone(PLAN_PATH, task);
      else markSectionDone(PLAN_PATH, task);
      lastTask = null;
      lastWasSubtaskEmission = false;
      continue;
    }

    // snapshot plan state before iteration for corruption detection
    const planSnapshot = readPlan();
    const { total: totalBefore, done: doneBefore } = countTasksInContent(planSnapshot);

    const prompt = buildPrompt(task);
    appendFileSync(LOG_FILE, `\n=== 🥋 Wax On ${i}/${maxIterations} — ${new Date().toString()} ===\n`);
    appendFileSync(LOG_FILE, `task: ${task}\n\n`);

    const { exitCode, output } = await runIteration(prompt);

    // write iter file for inspection
    writeFileSync(ITER_FILE, output);

    // plan corruption detection: runs BEFORE exit code check because
    // the typical corruption case is the agent dying mid-write to the plan file
    const afterCounts = countTasksInContent(readPlan());
    if (afterCounts.total < totalBefore || afterCounts.done < doneBefore) {
      const reason = afterCounts.total < totalBefore
        ? `task count shrank from ${totalBefore} to ${afterCounts.total}`
        : `completed count shrank from ${doneBefore} to ${afterCounts.done}`;
      appendFileSync(LOG_FILE, `\n=== ⚠️ Plan corruption detected: ${reason} — attempting recovery ===\n`);
      const recoveryPrompt = buildRecoveryPrompt(planSnapshot, totalBefore, afterCounts.total);
      const { exitCode: recoveryExit } = await runIteration(recoveryPrompt);
      appendFileSync(LOG_FILE, `\n=== Recovery agent exited (code ${recoveryExit}) ===\n`);
      const recoveredCounts = countTasksInContent(readPlan());
      if (recoveredCounts.total < totalBefore || recoveredCounts.done < doneBefore) {
        appendFileSync(LOG_FILE, `\n=== ⚠️ Recovery failed (${recoveredCounts.total} tasks, ${recoveredCounts.done} done) — restoring from backup ===\n`);
        writeFileSync(PLAN_PATH, planSnapshot);
      } else {
        appendFileSync(LOG_FILE, `\n=== ✅ Plan recovered (${recoveredCounts.total} tasks, ${recoveredCounts.done} done) ===\n`);
      }
      try { unlinkSync(ITER_FILE); } catch {}
      continue;
    }

    if (exitCode !== 0) {
      appendFileSync(LOG_FILE, `\n=== ⚠️  Iteration ${i} FAILED (exit code ${exitCode}) — ${new Date().toString()} ===\n\n`);
      try { unlinkSync(ITER_FILE); } catch {}
      continue;
    }

    // check for subtask breakdown (capped to prevent unbounded expansion)
    const subtasks = parseSubtasks(output) ?? [];
    const MAX_CEILING = Math.max(ITERATIONS * 2, 100);
    if (subtasks.length > 0 && subtaskExpansions < MAX_SUBTASK_EXPANSIONS) {
      subtaskExpansions++;
      subtasksAdded += subtasks.length;
      appendSubtasksToPlan(PLAN_PATH, subtasks);
      // mark parent done so it's never re-picked
      if (checkbox) {
        markCheckboxDone(PLAN_PATH, task);
      } else {
        markSectionDone(PLAN_PATH, task);
      }
      if (maxIterations < MAX_CEILING) maxIterations++;
      appendFileSync(LOG_FILE, `\n=== 🧩 Subtasks detected (${subtasks.length}) — extended to ${maxIterations} iterations (ceiling ${MAX_CEILING}, expansions ${subtaskExpansions}/${MAX_SUBTASK_EXPANSIONS}) ===\n`);
      for (const st of subtasks) appendFileSync(LOG_FILE, `  + ${st}\n`);
      lastTask = task;
      lastWasSubtaskEmission = true;
      try { unlinkSync(ITER_FILE); } catch {}
      continue;
    }

    lastTask = task;
    lastWasSubtaskEmission = false;

    appendFileSync(LOG_FILE, `\n=== ✅ Iteration ${i} complete — ${new Date().toString()} ===\n`);
    tasksCompleted++;

    // mark task done in plan file
    if (checkbox) {
      markCheckboxDone(PLAN_PATH, task);
    } else {
      markSectionDone(PLAN_PATH, task);
    }

    try { unlinkSync(ITER_FILE); } catch {}
  }

  appendFileSync(LOG_FILE, `=== Completed ${maxIterations} iterations ===\n`);
  const remaining = extractCurrentTask(PLAN_PATH);
  if (!remaining) {
    await runCleanup();
  } else {
    appendFileSync(LOG_FILE, `=== ⏭️  Skipping cleanup — tasks still remain ===\n`);
  }
  logSummary(tasksCompleted, subtasksAdded);
  appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
}

const CLEANUP_PROMPT = `You may ONLY create/edit/delete files under ${PROJECT_DIR}. Do NOT touch files outside this directory.

@${PLAN_FILE} @${PROGRESS_FILE}

You are running a CLEANUP pass after all tasks have been implemented.

INSTRUCTIONS:
1. Run \`git diff --name-only HEAD~10 HEAD 2>/dev/null || git diff --name-only HEAD\` to find all files changed during this session.
2. For each changed file, review for:
   - Dead code: unreachable functions, unused imports, orphaned variables
   - Old code paths that were replaced but not removed
   - Commented-out code that is no longer relevant
   - Stale TODO/FIXME comments referencing completed work
3. Also check files that IMPORT FROM or are closely coupled to the changed files — look for:
   - Exports that are no longer imported anywhere
   - Interfaces/types that lost all consumers
   - Test helpers that test removed functionality
4. Remove all identified dead code. Do NOT remove code that is still reachable or may be used.
5. Run any relevant tests to confirm nothing breaks.
6. Commit with message "chore: cleanup dead code after ralph session".
7. Update ${PROGRESS_FILE} with what was cleaned up.

RULES:
- Do NOT add new features or refactor working code.
- Do NOT remove comments that explain non-obvious logic.
- Only remove code you can confirm is unreachable or unused.
- If unsure, leave it.

BEGIN.`;

async function runCleanup(): Promise<void> {
  appendFileSync(LOG_FILE, `\n=== 🥋 Wax Off — starting cleanup — ${new Date().toString()} ===\n\n`);
  const { exitCode, output } = await runIteration(CLEANUP_PROMPT);
  writeFileSync(ITER_FILE, output);

  if (exitCode !== 0) {
    appendFileSync(LOG_FILE, `\n=== ⚠️  Wax Off FAILED (exit code ${exitCode}) — ${new Date().toString()} ===\n\n`);
  } else {
    appendFileSync(LOG_FILE, `\n=== ✅ Wax Off complete — ${new Date().toString()} ===\n`);
  }
  try { unlinkSync(ITER_FILE); } catch {}
}

main().then(() => {
  removeLock();
}).catch((err) => {
  appendFileSync(LOG_FILE, `\nFATAL: ${err.message}\n`);
  appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
  removeLock();
  process.exit(1);
});
