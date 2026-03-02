/**
 * Shared task-iteration utilities extracted from ralph-macchio.ts.
 *
 * All functions are parameterized (no module globals) so both ralph
 * and kobra-kai's task runner can reuse them.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { TASK_HEADER } from "../wolfpack-context.js";

/**
 * Read a plan file and return the next uncompleted task.
 * Checks unchecked checkboxes first, then numbered section headers.
 */
export function extractCurrentTask(planPath: string): { task: string; checkbox: boolean } | null {
  try {
    const plan = readFileSync(planPath, "utf-8");

    // try checkboxes first (subtasks appended at bottom)
    const cbMatch = plan.match(/^- \[ \] (.+)$/m);
    if (cbMatch) return { task: cbMatch[1], checkbox: true };

    // then section headers: find first ## or ### numbered header not struck through
    const lines = plan.split("\n");
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
        return { task: sectionLines.join("\n").trim(), checkbox: false };
      }
    }
    return null;
  } catch { return null; }
}

/**
 * Mark a section-header task as done by wrapping its header in ~~strikethrough~~.
 */
export function markSectionDone(planPath: string, taskText: string): void {
  try {
    const plan = readFileSync(planPath, "utf-8");
    const headerLine = taskText.split("\n")[0];
    if (!headerLine || !plan.includes(headerLine)) return;
    const prefix = headerLine.match(/^(#{2,3} )/)?.[1] || "### ";
    const rest = headerLine.slice(prefix.length);
    // use line-start anchor to avoid replacing text that appears elsewhere
    const escaped = headerLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lineRegex = new RegExp("^" + escaped + "$", "m");
    const updated = plan.replace(lineRegex, `${prefix}~~${rest}~~`);
    writeFileSync(planPath, updated);
  } catch {}
}

/**
 * Mark a checkbox task as done by replacing `- [ ]` with `- [x]`.
 */
export function markCheckboxDone(planPath: string, taskText: string): void {
  try {
    const plan = readFileSync(planPath, "utf-8");
    const escaped = taskText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("^- \\[ \\] " + escaped + "$", "m");
    const updated = plan.replace(re, `- [x] ${taskText}`);
    writeFileSync(planPath, updated);
  } catch {}
}

/**
 * Append subtasks as unchecked checkboxes to the end of a plan file.
 * Strips markdown headers and strikethrough markers from subtask text.
 */
export function appendSubtasksToPlan(planPath: string, subtasks: string[]): void {
  // sanitize: strip markdown headers and strikethrough markers
  const safe = subtasks.map(t => t.replace(/^#+\s*/, "").replace(/~~/g, "").trim()).filter(Boolean);
  const lines = safe.map(t => `- [ ] ${t}`).join("\n");
  appendFileSync(planPath, "\n" + lines + "\n");
}

/**
 * Parse a `<subtasks>` block from agent output.
 * Returns the subtask lines, or null if no block is found.
 */
export function parseSubtasks(output: string): string[] | null {
  const match = output.match(/<subtasks>([\s\S]*?)<\/subtasks>/);
  if (!match) return null;
  return match[1].split("\n").map(l => l.trim()).filter(l => l.length > 0);
}

/** Config for spawning an agent process. */
export interface AgentSpawnConfig {
  bin: string;
  args: (prompt: string) => string[];
}

/**
 * Spawn an agent process and capture its output.
 * Returns exit code and combined stdout+stderr.
 */
export function runAgentIteration(
  prompt: string,
  cwd: string,
  agent: AgentSpawnConfig,
  timeoutMs: number = 30 * 60 * 1000,
  logFile?: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = nodeSpawn(agent.bin, agent.args(prompt), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      if (logFile) {
        appendFileSync(logFile, `\n=== ⚠️  Iteration timed out after ${timeoutMs / 60000}min — killing agent ===\n`);
      }
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      chunks.push(d);
      if (logFile) appendFileSync(logFile, d.toString("utf-8"));
    });
    child.stderr?.on("data", (d: Buffer) => {
      chunks.push(d);
      if (logFile) appendFileSync(logFile, d.toString("utf-8"));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, output: Buffer.concat(chunks).toString("utf-8") });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      if (logFile) appendFileSync(logFile, `spawn error: ${err.message}\n`);
      resolve({ exitCode: 1, output: `spawn error: ${err.message}\n` });
    });
  });
}
