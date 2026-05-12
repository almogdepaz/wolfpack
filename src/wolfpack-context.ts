/**
 * Shared context injected into AI agent sessions spawned by wolfpack.
 *
 * Two focused contexts replace the old monolithic WOLFPACK_CONTEXT:
 *  - RALPH_AGENT_CONTEXT:  ralph-macchio.ts prepends to the `-p` prompt
 *  - INTERACTIVE_CONTEXT:  serve.ts appends via `claude --append-system-prompt`
 *
 * The two context strings are sourced from skill files under
 * `.claude/skills/{wolfpack-ralph,wolfpack-plan}/SKILL.md`, embedded at
 * build time via bun's text imports so the prompt content survives
 * `bun build --compile`. YAML frontmatter is stripped at module load.
 *
 * Plus a validatePlanFormat() helper for checking plan file structure.
 */
import ralphSkill from "../.claude/skills/wolfpack-ralph/SKILL.md" with { type: "text" };
import planSkill from "../.claude/skills/wolfpack-plan/SKILL.md" with { type: "text" };

/** Strip YAML frontmatter (--- ... ---) from a skill markdown file. */
function stripFrontmatter(md: string): string {
  const m = md.match(/^---\n[\s\S]*?\n---\n+/);
  return m ? md.slice(m[0].length) : md;
}

/** Matches plan task headers: ## 1. Title, ### 2a. Title, ## ~~3. Title~~, ## Phase 1. Title */
export const TASK_HEADER = /^#{2,3} (?:~~)?(?:\w+ )?\d+[a-z]?[\.\):]\s+/;

/** Checkbox task pattern: - [ ] or - [x] */
const CHECKBOX = /^- \[[ x]\] /;

/** Context for ralph iterations — subtask output protocol + granularity only.
 *  Source: .claude/skills/wolfpack-ralph/SKILL.md */
export const RALPH_AGENT_CONTEXT = stripFrontmatter(ralphSkill).trimEnd();

/** Context for interactive claude sessions — plan format + granularity.
 *  Source: .claude/skills/wolfpack-plan/SKILL.md */
export const INTERACTIVE_CONTEXT = stripFrontmatter(planSkill).trimEnd();

/** Ambiguous header patterns that look like tasks but don't match TASK_HEADER */
const AMBIGUOUS_HEADERS = [
  /^#{2,3} (?:Phase|Step|Task|Stage|Part)\s+\d/i,
  /^#{2,3} \d+[\s]*[-–—]/,
];

/**
 * Old plan format: lines like "Task 1: Title", "Task 2: Title", optionally
 * preceded by markdown header markers (## Task 1: ...) or with sub-letters
 * (Task 1a: ...). Does NOT match the new `## N. Title` format.
 */
const OLD_TASK_PATTERN = /^(?:#{1,4}\s+)?Task\s+(\d+[a-z]?)\s*[:\.]\s*(.+)/i;

/**
 * Detect whether plan content uses the old `Task N: Title` format.
 * Returns true if at least one old-style task header is found and
 * no new-style TASK_HEADER is present.
 */
export function detectOldPlanFormat(content: string): boolean {
  const lines = content.split("\n");
  let hasOld = false;
  let hasNew = false;
  for (const line of lines) {
    if (OLD_TASK_PATTERN.test(line)) hasOld = true;
    if (TASK_HEADER.test(line)) hasNew = true;
  }
  return hasOld && !hasNew;
}

/**
 * Migrate plan content from old `Task N: Title` format to `## N. Title`.
 * Returns { content, count } where count is the number of migrated headers.
 */
export function migratePlanFormat(content: string): { content: string; count: number } {
  let count = 0;
  const migrated = content.replace(
    new RegExp(OLD_TASK_PATTERN.source, "gim"),
    (_match, num: string, title: string) => {
      count++;
      return `## ${num}. ${title.trim()}`;
    },
  );
  return { content: migrated, count };
}

/**
 * Count tasks in plan content — supports both section headers and checkboxes.
 * Pure function (no file I/O) for use in ralph-macchio.ts and ralph.ts.
 */
export function countTasksInContent(content: string): { done: number; total: number } {
  let total = 0;
  let done = 0;

  // Detect which format is present — headers take priority
  const lines = content.split("\n");
  let hasHeaders = false;
  for (const line of lines) {
    if (TASK_HEADER.test(line)) { hasHeaders = true; break; }
  }

  if (hasHeaders) {
    for (const line of lines) {
      if (TASK_HEADER.test(line)) {
        total++;
        if (line.includes("~~")) done++;
      }
    }
  } else {
    // Fallback: count checkboxes only when no headers present
    const cbDone = (content.match(/^- \[x\] /gm) || []).length;
    const cbOpen = (content.match(/^- \[ \] /gm) || []).length;
    done = cbDone;
    total = cbDone + cbOpen;
  }

  return { done, total };
}

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
