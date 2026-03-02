#!/usr/bin/env bun
/**
 * Kobra-kai task runner — per-worktree iteration loop.
 * Runs as a detached subprocess, one per task worktree.
 * Uses shared iteration logic from src/shared/task-iteration.ts.
 *
 * Usage: bun task-runner.ts --worktree PATH --project-context PATH [--max-iterations N] [--agent NAME]
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { RALPH_AGENT_CONTEXT } from "../wolfpack-context.js";
import {
  extractCurrentTask,
  markSectionDone,
  markCheckboxDone,
  appendSubtasksToPlan,
  parseSubtasks,
  runAgentIteration,
  type AgentSpawnConfig,
} from "../shared/task-iteration.js";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    worktree: { type: "string" },
    "max-iterations": { type: "string", default: "10" },
    agent: { type: "string", default: "claude" },
    "project-context": { type: "string" },
  },
});

const worktreePath = args.worktree;
const maxIterations = parseInt(args["max-iterations"] || "10");
const agentName = args.agent || "claude";
const projectContextPath = args["project-context"];

// ---------------------------------------------------------------------------
// PATH augmentation (detached subprocesses may lack common bin dirs)
// ---------------------------------------------------------------------------

const HOME = process.env.HOME || "";
const EXTRA_PATHS = [
  join(HOME, ".local", "bin"),
  join(HOME, ".cargo", "bin"),
  join(HOME, "bin"),
  join(HOME, ".npm-global", "bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
];
const currentPath = process.env.PATH || "";
const pathSegments = new Set(currentPath.split(":"));
const missingPaths = EXTRA_PATHS.filter(p => !pathSegments.has(p) && existsSync(p));
if (missingPaths.length > 0) {
  process.env.PATH = [...missingPaths, currentPath].join(":");
}

function resolveBin(name: string): string {
  try {
    return execFileSync("which", [name], { encoding: "utf-8" }).trim();
  } catch { return name; }
}

// ---------------------------------------------------------------------------
// Allowed tools & agent configs
// ---------------------------------------------------------------------------

const ALLOWED_TOOLS = [
  "Edit", "Write", "Read", "Glob", "Grep",
  "Bash(git *)", "Bash(npm *)", "Bash(npx *)", "Bash(pnpm *)",
  "Bash(yarn *)", "Bash(bun *)", "Bash(cargo *)", "Bash(go *)",
  "Bash(python *)", "Bash(pip *)", "Bash(pytest *)", "Bash(make *)",
  "Bash(ls *)", "Bash(mkdir *)", "Bash(rm *)", "Bash(mv *)",
  "Bash(cp *)", "Bash(cat *)", "Bash(echo *)", "Bash(touch *)",
].join(",");

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

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export function buildPrompt(
  projectContext: string,
  taskDesc: string,
  wtPath: string,
): string {
  return `${RALPH_AGENT_CONTEXT}

## Project Context
${projectContext}

You may ONLY create/edit/delete files under ${wtPath}. Do NOT touch files outside this directory.

YOUR TASK:
${taskDesc}

INSTRUCTIONS:
1. If the task is concrete enough, implement it directly.
2. If it's too large or vague, break it into subtasks instead of implementing.
3. Run any relevant tests and type checks for what you built.
4. Commit your changes with a descriptive message.

RULES:
- ONLY work on ONE task per iteration.
- If you decide the task needs breakdown, output a <subtasks> block and do NOT modify any files.
- Do NOT remove or renumber tasks in the plan file.
- Be thorough but focused.

BEGIN.`;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(logFile: string, msg: string): void {
  const ts = new Date().toISOString();
  appendFileSync(logFile, `[${ts}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const ITERATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min per iteration

export async function runTaskLoop(
  wtPath: string,
  maxIter: number,
  agent: AgentSpawnConfig,
  projectContext: string,
): Promise<void> {
  const planPath = join(wtPath, "PLAN.md");
  const logFile = join(wtPath, ".kobra-kai.log");

  writeFileSync(logFile, `kobra-kai task runner started\n`);
  log(logFile, `worktree: ${wtPath}`);
  log(logFile, `max iterations: ${maxIter}`);
  log(logFile, `pid: ${process.pid}`);

  for (let i = 1; i <= maxIter; i++) {
    log(logFile, `--- iteration ${i}/${maxIter} ---`);

    const task = extractCurrentTask(planPath);
    if (!task) {
      log(logFile, "no remaining tasks — done");
      return;
    }

    log(logFile, `task: ${task.task.split("\n")[0]}`);

    const prompt = buildPrompt(projectContext, task.task, wtPath);
    const { exitCode, output } = await runAgentIteration(
      prompt,
      wtPath,
      agent,
      ITERATION_TIMEOUT_MS,
      logFile,
    );

    if (exitCode !== 0) {
      log(logFile, `agent exited with code ${exitCode} — continuing`);
      continue;
    }

    const subtasks = parseSubtasks(output);
    if (subtasks) {
      log(logFile, `subtasks detected (${subtasks.length}) — appending to plan`);
      appendSubtasksToPlan(planPath, subtasks);
      continue;
    }

    if (task.checkbox) {
      markCheckboxDone(planPath, task.task);
    } else {
      markSectionDone(planPath, task.task);
    }

    log(logFile, `marked done: ${task.task.split("\n")[0]}`);
  }

  log(logFile, `max iterations (${maxIter}) reached — exiting`);
}

// ---------------------------------------------------------------------------
// Entry point (when run as subprocess)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  if (!worktreePath) {
    console.error("--worktree is required");
    process.exit(1);
  }
  if (!projectContextPath) {
    console.error("--project-context is required");
    process.exit(1);
  }

  const agent = AGENTS[agentName];
  if (!agent) {
    console.error(`unknown agent: ${agentName}. available: ${Object.keys(AGENTS).join(", ")}`);
    process.exit(1);
  }

  let projectContext: string;
  try {
    projectContext = readFileSync(projectContextPath, "utf-8");
  } catch (e) {
    console.error(`failed to read project context: ${projectContextPath}`);
    process.exit(1);
  }

  runTaskLoop(worktreePath, maxIterations, agent, projectContext)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("task runner failed:", err);
      process.exit(1);
    });
}
