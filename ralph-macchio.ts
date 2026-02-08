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

function resolveBin(name: string): string {
  try { return execFileSync("which", [name], { encoding: "utf-8" }).trim(); }
  catch { return name; }
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

function extractCurrentTask(): string | null {
  try {
    const plan = readFileSync(PLAN_FILE, "utf-8");
    const match = plan.match(/^- \[ \] (.+)$/m);
    return match ? match[1] : null;
  } catch { return null; }
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

    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.stderr?.on("data", (d: Buffer) => chunks.push(d));

    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, output: Buffer.concat(chunks).toString("utf-8") });
    });

    child.on("error", (err) => {
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
      appendFileSync(LOG_FILE, `\n=== 🥋 No unchecked tasks remain — ${new Date().toString()} ===\n`);
      appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
      process.exit(0);
    }

    const prompt = buildPrompt(task);
    appendFileSync(LOG_FILE, `\n=== Iteration ${i}/${maxIterations} — ${new Date().toString()} ===\n`);
    appendFileSync(LOG_FILE, `task: ${task}\n\n`);

    const { exitCode, output } = await runIteration(prompt);
    appendFileSync(LOG_FILE, output);

    // write iter file for inspection
    writeFileSync(ITER_FILE, output);

    if (exitCode !== 0) {
      appendFileSync(LOG_FILE, `\n=== ⚠️  Iteration ${i} FAILED (exit code ${exitCode}) — ${new Date().toString()} ===\n\n`);
      try { unlinkSync(ITER_FILE); } catch {}
      continue;
    }

    // check for subtask breakdown
    const subtasks = parseSubtasks(output);
    if (subtasks.length > 0) {
      appendSubtasksToPlan(subtasks);
      maxIterations++;
      appendFileSync(LOG_FILE, `\n=== 🧩 Subtasks detected (${subtasks.length}) — extended to ${maxIterations} iterations ===\n`);
      for (const st of subtasks) appendFileSync(LOG_FILE, `  + ${st}\n`);
      try { unlinkSync(ITER_FILE); } catch {}
      continue;
    }

    appendFileSync(LOG_FILE, `\n=== ✅ Iteration ${i} complete — ${new Date().toString()} ===\n`);

    if (output.includes("<done>COMPLETE</done>")) {
      appendFileSync(LOG_FILE, `=== 🥋 All tasks complete after ${i} iterations ===\n`);
      appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
      try { unlinkSync(ITER_FILE); } catch {}
      process.exit(0);
    }

    try { unlinkSync(ITER_FILE); } catch {}
  }

  appendFileSync(LOG_FILE, `=== Completed ${maxIterations} iterations ===\n`);
  appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
}

main().catch((err) => {
  appendFileSync(LOG_FILE, `\nFATAL: ${err.message}\n`);
  appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
  process.exit(1);
});
