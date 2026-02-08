#!/usr/bin/env bun
/**
 * Ralph worker — runs claude iteratively on a plan file.
 * Spawned as a detached subprocess by serve.ts.
 *
 * Config via env vars:
 *   RALPH_CLAUDE_BIN  — absolute path to claude binary
 *   RALPH_ITERATIONS  — number of iterations (default 5)
 *   RALPH_PLAN        — plan file name (default PLAN.md)
 *   RALPH_PROGRESS    — progress file name (default progress.txt)
 */
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const ITERATIONS = Math.max(1, Math.min(50, Number(process.env.RALPH_ITERATIONS) || 5));
const PLAN_FILE = process.env.RALPH_PLAN || "PLAN.md";
const PROGRESS_FILE = process.env.RALPH_PROGRESS || "progress.txt";
const AGENT = process.env.RALPH_AGENT || "claude";
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
};

const agent = AGENTS[AGENT];
if (!agent) {
  console.error(`unknown agent: ${AGENT}. available: ${Object.keys(AGENTS).join(", ")}`);
  process.exit(1);
}

function planUsesCheckboxes(): boolean {
  try {
    const plan = readFileSync(PLAN_FILE, "utf-8");
    return /^- \[[ x]\] /m.test(plan);
  } catch { return false; }
}

function extractCurrentTask(): string | null {
  try {
    const plan = readFileSync(PLAN_FILE, "utf-8");

    // checkbox mode: return first unchecked item
    if (planUsesCheckboxes()) {
      const match = plan.match(/^- \[ \] (.+)$/m);
      return match ? match[1] : null;
    }

    // section mode: find first ## or ### numbered header not struck through
    const lines = plan.split("\n");
    const TASK_HEADER = /^(#{2,3}) \d+[a-z]?[\.\)]\s+/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (TASK_HEADER.test(line) && !line.includes("~~")) {
        const level = line.match(/^(#{2,3})/)?.[1] || "##";
        // collect the full section until the next header at same or higher level
        const sectionLines = [line];
        for (let j = i + 1; j < lines.length; j++) {
          const nextMatch = lines[j].match(/^(#{1,3}) /);
          if (nextMatch && nextMatch[1].length <= level.length) break;
          sectionLines.push(lines[j]);
        }
        return sectionLines.join("\n").trim();
      }
    }
    return null;
  } catch { return null; }
}

function markSectionDone(taskText: string): void {
  try {
    const plan = readFileSync(PLAN_FILE, "utf-8");
    const headerLine = taskText.split("\n")[0];
    if (!headerLine || !plan.includes(headerLine)) return;
    // wrap the header content in strikethrough
    // ### 1. Title → ### ~~1. Title~~
    // ## 1. Title → ## ~~1. Title~~
    const prefix = headerLine.match(/^(#{2,3} )/)?.[1] || "### ";
    const rest = headerLine.slice(prefix.length);
    const updated = plan.replace(headerLine, `${prefix}~~${rest}~~`);
    writeFileSync(PLAN_FILE, updated);
  } catch {}
}

function buildPrompt(taskDesc: string): string {
  return `You may ONLY create/edit/delete files under ${PROJECT_DIR}. Do NOT touch files outside this directory.

@${PLAN_FILE} @${PROGRESS_FILE}

CURRENT TASK (highest priority incomplete):
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
- If you decide the task needs breakdown, output a <subtasks> block with one task per line, and DO NOT modify any files or make a commit in that iteration.
- If all tasks are complete, output exactly: <done>COMPLETE</done>
- Be thorough but focused.

BEGIN.`;
}

// create progress file if missing
if (!existsSync(PROGRESS_FILE)) {
  writeFileSync(PROGRESS_FILE, "# Progress Log\n");
}

// write log header
writeFileSync(LOG_FILE, `🥋 ralph — ${ITERATIONS} iterations\n`);
appendFileSync(LOG_FILE, `agent: ${AGENT}\n`);
appendFileSync(LOG_FILE, `plan: ${PLAN_FILE}\n`);
appendFileSync(LOG_FILE, `progress: ${PROGRESS_FILE}\n`);
appendFileSync(LOG_FILE, `pid: ${process.pid}\n`);
appendFileSync(LOG_FILE, `bin: ${agent.bin}\n`);
appendFileSync(LOG_FILE, `started: ${new Date().toString()}\n\n`);

function parseSubtasks(output: string): string[] {
  const match = output.match(/<subtasks>([\s\S]*?)<\/subtasks>/);
  if (!match) return [];
  return match[1].split("\n").map(l => l.trim()).filter(l => l.length > 0);
}

function appendSubtasksToPlan(subtasks: string[]): void {
  const lines = subtasks.map(t => `- [ ] ${t}`).join("\n");
  appendFileSync(PLAN_FILE, "\n" + lines + "\n");
}

function runIteration(prompt: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = nodeSpawn(agent.bin, agent.args(prompt), {
      cwd: PROJECT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (d: Buffer) => {
      chunks.push(d);
      appendFileSync(LOG_FILE, d.toString("utf-8"));
    });
    child.stderr?.on("data", (d: Buffer) => {
      chunks.push(d);
      appendFileSync(LOG_FILE, d.toString("utf-8"));
    });

    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, output: Buffer.concat(chunks).toString("utf-8") });
    });

    child.on("error", (err) => {
      appendFileSync(LOG_FILE, `spawn error: ${err.message}\n`);
      resolve({ exitCode: 1, output: `spawn error: ${err.message}\n` });
    });
  });
}

async function main() {
  let maxIterations = ITERATIONS;

  for (let i = 1; i <= maxIterations; i++) {
    // extract current task from plan
    const task = extractCurrentTask();
    if (!task) {
      const msg = i === 1 ? "No parseable tasks found in plan" : "No unchecked tasks remain";
      appendFileSync(LOG_FILE, `\n=== 🥋 ${msg} — ${new Date().toString()} ===\n`);
      if (i > 1) await runCleanup();
      appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
      process.exit(0);
    }

    const prompt = buildPrompt(task);
    appendFileSync(LOG_FILE, `\n=== 🥋 Wax On ${i}/${maxIterations} — ${new Date().toString()} ===\n`);
    appendFileSync(LOG_FILE, `task: ${task}\n\n`);

    const { exitCode, output } = await runIteration(prompt);

    // write iter file for inspection
    writeFileSync(ITER_FILE, output);

    if (exitCode !== 0) {
      appendFileSync(LOG_FILE, `\n=== ⚠️  Iteration ${i} FAILED (exit code ${exitCode}) — ${new Date().toString()} ===\n\n`);
      try { unlinkSync(ITER_FILE); } catch {}
      continue;
    }

    // check for subtask breakdown
    const subtasks = parseSubtasks(output);
    const MAX_CEILING = Math.max(ITERATIONS * 2, 100);
    if (subtasks.length > 0) {
      appendSubtasksToPlan(subtasks);
      if (maxIterations < MAX_CEILING) maxIterations++;
      appendFileSync(LOG_FILE, `\n=== 🧩 Subtasks detected (${subtasks.length}) — extended to ${maxIterations} iterations (ceiling ${MAX_CEILING}) ===\n`);
      for (const st of subtasks) appendFileSync(LOG_FILE, `  + ${st}\n`);
      try { unlinkSync(ITER_FILE); } catch {}
      continue;
    }

    appendFileSync(LOG_FILE, `\n=== ✅ Iteration ${i} complete — ${new Date().toString()} ===\n`);

    // mark section done in plan file (section mode only)
    if (!planUsesCheckboxes()) {
      markSectionDone(task);
    }

    if (output.includes("<done>COMPLETE</done>")) {
      appendFileSync(LOG_FILE, `=== 🥋 All tasks complete after ${i} iterations ===\n`);
      try { unlinkSync(ITER_FILE); } catch {}
      await runCleanup();
      appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
      process.exit(0);
    }

    try { unlinkSync(ITER_FILE); } catch {}
  }

  appendFileSync(LOG_FILE, `=== Completed ${maxIterations} iterations ===\n`);
  await runCleanup();
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
  appendFileSync(LOG_FILE, `\n=== 🥋 Wax Off — ${new Date().toString()} ===\n\n`);
  const { exitCode, output } = await runIteration(CLEANUP_PROMPT);
  writeFileSync(ITER_FILE, output);

  if (exitCode !== 0) {
    appendFileSync(LOG_FILE, `\n=== ⚠️  Wax Off FAILED (exit code ${exitCode}) — ${new Date().toString()} ===\n\n`);
  } else {
    appendFileSync(LOG_FILE, `\n=== ✅ Wax Off complete — ${new Date().toString()} ===\n`);
  }
  try { unlinkSync(ITER_FILE); } catch {}
}

main().catch((err) => {
  appendFileSync(LOG_FILE, `\nFATAL: ${err.message}\n`);
  appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
  process.exit(1);
});
