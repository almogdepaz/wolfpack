/**
 * Shared context injected into AI agent sessions spawned by wolfpack.
 *
 * Two focused contexts replace the old monolithic WOLFPACK_CONTEXT:
 *  - RALPH_AGENT_CONTEXT:  ralph-macchio.ts prepends to the `-p` prompt
 *  - INTERACTIVE_CONTEXT:  serve.ts appends via `claude --append-system-prompt`
 *
 * Plus a validatePlanFormat() helper for checking plan file structure.
 */

/** Matches plan task headers: ## 1. Title, ### 2a. Title, ## ~~3. Title~~, ## Phase 1. Title */
export const TASK_HEADER = /^#{2,3} (?:~~)?(?:\w+ )?\d+[a-z]?[\.\):]\s+/;

/** Checkbox task pattern: - [ ] or - [x] */
const CHECKBOX = /^- \[[ x]\] /;

/** Context for ralph iterations — subtask output protocol + granularity only. */
export const RALPH_AGENT_CONTEXT = `## Ralph Agent Context

When a task is too large to implement directly, output a <subtasks> block instead of making changes:
\`\`\`
<subtasks>
Implement auth middleware with JWT validation
Add integration tests for auth endpoints
</subtasks>
\`\`\`
Each subtask = a meaningful deliverable (3-5 per breakdown). NOT single lines of code or imports — a unit of work a senior dev would recognize as coherent.`;

/** Context for interactive claude sessions — plan format + granularity. */
export const INTERACTIVE_CONTEXT = `## Wolfpack Plan Conventions

Plan task headers MUST use: \`## N. Title\` (e.g. \`## 1. Add auth\`), subtasks: \`## Na. Title\` (e.g. \`## 1a. Tests\`). Completed: wrap in \`~~\` (e.g. \`## ~~1. Done~~\`). No other header styles — the task extractor only recognizes this pattern.

Each task = a meaningful deliverable (3-5 per feature). NOT individual lines of code — a unit of work a senior dev would recognize. Subtask breakdowns follow the same rule: 3-5 max, each coherent.`;

/** Ambiguous header patterns that look like tasks but don't match TASK_HEADER */
const AMBIGUOUS_HEADERS = [
  /^#{2,3} (?:Phase|Step|Task|Stage|Part)\s+\d/i,
  /^#{2,3} \d+[\s]*[-–—]/,
];

/**
 * Validate plan file structure — checks for parseable tasks and ambiguous headers.
 * Reuses TASK_HEADER regex and checkbox pattern from countPlanTasks logic.
 */
export function validatePlanFormat(planContent: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  const lines = planContent.split("\n");

  let hasTaskHeaders = false;
  let hasCheckboxes = false;

  for (const line of lines) {
    if (TASK_HEADER.test(line)) hasTaskHeaders = true;
    if (CHECKBOX.test(line)) hasCheckboxes = true;

    for (const pattern of AMBIGUOUS_HEADERS) {
      if (pattern.test(line) && !TASK_HEADER.test(line)) {
        issues.push(`Ambiguous header: "${line.trim()}" — use \`## N. Title\` format`);
      }
    }
  }

  if (!hasTaskHeaders && !hasCheckboxes) {
    issues.push("No parseable tasks found — need `## N. Title` headers or `- [ ] task` checkboxes");
  }

  return { valid: issues.length === 0, issues };
}
