import type { RalphAgent } from "./ralph-agent.js";

export interface BuildIterationPromptOptions {
  readonly agent: RalphAgent;
  readonly workingDir: string;
  readonly taskDesc: string;
  readonly planFile: string;
  readonly progressFile: string;
}

export function buildIterationPrompt(options: BuildIterationPromptOptions): string {
  const subtaskInstructions = options.agent === "codex"
    ? `1. If the task is concrete enough, implement it directly.
2. If it's too large or vague, implement the smallest concrete slice that moves it forward and document assumptions in <prereqs>.
3. Run any relevant tests and type checks for what you built.
4. Commit your changes with a descriptive message.
5. Do NOT write to ${options.progressFile} — the task runner manages it automatically.`
    : `1. If the task is concrete enough, implement it directly.
2. If it's too large or vague, break it into subtasks instead of implementing.
3. Run any relevant tests and type checks for what you built.
4. Commit your changes with a descriptive message.
5. Do NOT write to ${options.progressFile} — the task runner manages it automatically.`;

  const subtaskRules = options.agent === "codex"
    ? `- ONLY work on ONE task per iteration.
- If a task has sub-tasks, complete one sub-task.
- Do NOT emit XML-ish control tags. Codex output can include echoed transcript text, so the runner ignores tag-based control messages for codex.
- Do NOT write to ${options.planFile}. The task runner handles plan mutations.
- Do NOT remove or renumber tasks in the plan file.
- Be thorough but focused.`
    : `- ONLY work on ONE task per iteration.
- If a task has sub-tasks, complete one sub-task.
- If you decide the task needs breakdown, output a <subtasks> block with one task per line, and DO NOT modify any files or make a commit in that iteration. Follow the Task Granularity rules from the context above.
- Do NOT write to ${options.planFile}. The task runner handles all plan mutations. If you need subtasks, output a <subtasks> block.
- Do NOT remove or renumber tasks in the plan file.
- Be thorough but focused.`;

  return `You may ONLY create/edit/delete files under ${options.workingDir}. Do NOT touch files outside this directory.

YOUR TASK:
${options.taskDesc}

INSTRUCTIONS:
${subtaskInstructions}

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
${subtaskRules}

BEGIN.`;
}
