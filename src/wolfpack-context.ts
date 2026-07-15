/**
 * Plan-format helpers shared between the ralph worker and the server.
 *
 * Note: prior versions of this module also exported `RALPH_AGENT_CONTEXT`
 * and `INTERACTIVE_CONTEXT` prompt strings that were auto-injected into
 * agent commands. That injection was removed — the content now lives at
 * `skills/wolfpack-{ralph,plan}/SKILL.md` for anyone who wants
 * to opt in by installing the skills into their own project.
 */

/** Matches plan task headers: ## 1. Title, ### 2a. Title, ## ~~3. Title~~, ## Phase 1. Title */
export const TASK_HEADER = /^#{2,3} (?:~~)?(?:\w+ )?\d+[a-z]?[\.\):]\s+/;

/** Checkbox task pattern: - [ ] or - [x] */
const CHECKBOX = /^- \[[ x]\] /;

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

export function countRalphProgressFromContent(planContent: string, progressContent: string): { done: number; total: number } {
  const keys = extractRalphTaskKeys(planContent);
  const completed = new Set<string>();
  for (const line of progressContent.split("\n")) {
    if (line.startsWith("DONE: ")) completed.add(line.slice(6));
  }
  return {
    done: keys.filter(key => completed.has(key)).length,
    total: keys.length,
  };
}

function extractRalphTaskKeys(planContent: string): string[] {
  const keys: string[] = [];
  const lines = planContent.split("\n");

  for (const line of lines) {
    const cbMatch = line.match(/^- \[[ x]\] (.+)$/);
    if (cbMatch) keys.push(`checkbox: ${cbMatch[1]}`);
  }

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
    const hasChildren = sectionLines.some(l => /^- \[[ x]\] /.test(l));
    if (!hasChildren) keys.push(`section: ${line}`);
  }

  return [...new Set(keys)];
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
