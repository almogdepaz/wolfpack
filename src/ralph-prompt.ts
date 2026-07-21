import { AGENT_KIND } from "./agent-kind.js";
import type { RalphAgent } from "./ralph-agent.js";
import { RALPH_RESPONSE_VERSION, RalphResponseStatus } from "./ralph-response.js";

export interface BuildIterationPromptOptions {
  readonly agent: RalphAgent;
  readonly workingDir: string;
  readonly taskDesc: string;
  readonly planFile: string;
  readonly progressFile: string;
  readonly responseFile: string;
}

export function buildIterationPrompt(options: BuildIterationPromptOptions): string {
  const codexRule = options.agent === AGENT_KIND.CODEX
    ? "\n- Codex output can echo transcript text; DO NOT emit XML-ish control tags."
    : "";

  return `You may ONLY create/edit/delete files under ${options.workingDir}. Do NOT touch files outside this directory.

YOUR TASK:
${options.taskDesc}

INSTRUCTIONS:
1. If the task is concrete enough, implement it directly.
2. If it's too large or vague, write a structured response with \"status\": \"${RalphResponseStatus.needsSubtasks}\" and one subtask per string; do not modify files or make a commit in that iteration.
3. Run any relevant tests and type checks for what you built.
4. Commit your code/doc/test changes with a descriptive message when you changed files.
5. Do NOT write to ${options.progressFile} — the task runner manages it automatically.
6. Do NOT commit .ralph-response.json, ${options.progressFile}, .ralph.log, .ralph_iter.tmp, .ralph-response-schema-*.json, or .ralph-srt-settings-*.json; these are runner-owned transient files.

STRUCTURED RESPONSE:
Before exiting, write valid JSON to ${options.responseFile}. Use exactly one of these valid shapes.

Done response:
{
  "version": ${RALPH_RESPONSE_VERSION},
  "status": "${RalphResponseStatus.done}",
  "prereqs": ["list any prerequisites or assumptions"],
  "tests": ["list tests you ran, or would run if not possible"],
  "done": ["explicit criteria met by this iteration"],
  "subtasks": []
}

Needs-subtasks response:
{
  "version": ${RALPH_RESPONSE_VERSION},
  "status": "${RalphResponseStatus.needsSubtasks}",
  "prereqs": ["list any prerequisites or assumptions"],
  "tests": ["tests you would run after subtasks are implemented"],
  "done": ["criteria for the subtasks to satisfy"],
  "subtasks": ["first meaningful deliverable", "second meaningful deliverable"]
}

RULES:
- ONLY work on ONE task per iteration.
- If a task has sub-tasks, complete one sub-task.
- The JSON response file is the only runner control channel.
- Do NOT emit XML-ish runner control tags.${codexRule}
- Do NOT write to ${options.planFile}. The task runner handles all plan mutations.
- Do NOT remove or renumber tasks in the plan file.
- Be thorough but focused.

BEGIN.`;
}
