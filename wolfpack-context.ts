/**
 * Shared context string injected into agent sessions and ralph prompts.
 * Teaches agents about wolfpack conventions so they produce compatible output.
 */

/** Matches plan task headers: ## 1. Title, ### 2a. Title, ## ~~3. Title~~, ## Phase 1. Title */
export const TASK_HEADER = /^#{2,3} (?:~~)?(?:\w+ )?\d+[a-z]?[\.\):]\s+/;

export const WOLFPACK_CONTEXT = `## Wolfpack / Ralph Context

You are running inside a wolfpack-managed session. Wolfpack is a mobile & desktop command center for tmux-based AI agent sessions across multiple machines. It is agent-agnostic — supports Claude, Codex, Gemini, and custom commands. "Ralph" is the automated iteration loop that works through plan files.

### Plan File Format (CRITICAL)

Task sections MUST use this exact header format:
- Top-level tasks: \`## N. Title\` (e.g. \`## 1. Add auth middleware\`)
- Subtasks: \`## Na. Title\` (e.g. \`## 1a. Write unit tests\`)
- Completed tasks: wrap title in \`~~\` (e.g. \`## ~~1. Add auth middleware~~\`)

Do NOT use other header styles like \`## Phase 1:\`, \`## Step 1 -\`, \`### Task: Foo\`, etc. The automated task extractor only recognizes the \`## N. Title\` pattern.

### Task Granularity (CRITICAL)

Each task should be a meaningful deliverable — a unit of work a senior dev would recognize, NOT individual lines of code, imports, or type fields. Aim for 3-5 tasks per feature/phase. If a task can be described in fewer than 10 words of code, it's too granular — combine it with related work. Bad: "Add agent_pubkey field to interface". Good: "Add per-agent policy scoping to types and evaluation logic". When breaking tasks into subtasks, the same rule applies: 3-5 subtasks max, each a coherent unit touching multiple lines/files. Never produce line-by-line checkbox plans.

### Progress File

Append-only log file (default: progress.txt). Each iteration appends what was done. Never overwrite previous entries.

### Ralph Loop Mechanics

Each iteration: read plan → extract first non-done task → execute → mark done with ~~ → next iteration. A final cleanup pass removes dead code after all tasks complete.
`;
