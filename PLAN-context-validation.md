# Plan: Tighten Context Injection + Plan Validation + Multi-Agent Support

## Status: AWAITING APPROVAL

## Context
Three problems with the current wolfpack context/plan system:
1. **Bloated context**: `WOLFPACK_CONTEXT` (~240 tokens) is injected everywhere, mostly redundant — ralph already handles plan format, task marking, progress files itself
2. **No plan format validation**: `extractCurrentTask()` returns null for both "all done" and "malformatted plan" — ralph exits silently on bad format. Frontend only checks for zero tasks, not malformatted ones.
3. **Claude-only injection**: interactive sessions only inject context for claude (`/^claude\b/` gate). Gemini and codex get nothing despite wolfpack being "agent-agnostic"

---

## ~~1. wolfpack-context.ts — split context + add plan validator~~

**Delete** `WOLFPACK_CONTEXT`. Replace with two focused exports:

**`RALPH_AGENT_CONTEXT`** (~80 tokens) — only what ralph iterations need:
- `<subtasks>` output protocol (ralph parses this at line 252)
- task granularity guidance (so breakdowns are reasonable)
- that's it. no plan format, no progress file, no loop mechanics.

**`INTERACTIVE_CONTEXT`** (~80 tokens) — only what interactive sessions need:
- plan format conventions (`## N. Title`)
- task granularity guidance

**`validatePlanFormat(planContent: string)`** — new pure function:
- returns `{ valid: boolean; issues: string[] }`
- checks: has any parseable tasks (TASK_HEADER or checkbox), no ambiguous headers
- reuse `TASK_HEADER` regex and checkbox pattern from `countPlanTasks`

## ~~2. ralph-macchio.ts — swap context + add validation~~

**Context swaps:**
- `buildPrompt()` (line 199): `WOLFPACK_CONTEXT` → `RALPH_AGENT_CONTEXT`
- `numberPlanTasks()` (line 175): remove context prefix entirely (prompt is self-contained)
- `CLEANUP_PROMPT` (line 462): remove context prefix entirely

**Plan validation before loop starts** (in `main()`, after FORMAT_PLAN but before iteration loop):
- call `validatePlanFormat(readPlan())`
- if invalid: log the issues, exit with non-zero code + structured error message
- serve.ts can surface this to the frontend via the ralph status/log

**Mid-loop resilience:**
- after `extractCurrentTask()` returns null (line 399): check if plan still has unparseable content (not just empty). if so, log warning "plan has content but no parseable tasks — format may be corrupted" instead of silent "no unchecked tasks remain"

## 3. serve.ts — multi-agent injection + validation endpoint

**Multi-agent interactive injection:**
- claude: keep `--append-system-prompt` (cleanest, goes into system prompt)
- gemini: use `--prompt-interactive` / `-i` flag (stays interactive, injects as first message)
- codex: no flag available today — skip, document as known limitation
- extract agent detection into a helper instead of raw regex

**Plan validation endpoint** — enhance existing `/api/ralph/task-count`:
- add `issues: string[]` to the response from `countPlanTasks`
- frontend can show specific format issues before starting ralph

## 4. public/index.html — better format warnings

- when task-count returns issues, show them in the confirm dialog (not just "no numbered tasks")
- e.g. "Plan has 3 headers but none match the expected format. Found: '## Phase 1:', '## Step 2 -'. Ralph can auto-number them. Continue?"

---

## NOT doing
- codex interactive injection — no CLI flag exists, open feature request
- auto-running numberPlanTasks every iteration — too expensive (full agent call)
- new files — all changes in existing files
- changing ralph's core loop logic or subtask handling

## Verification
1. `npx tsc --noEmit` — compile check, no dangling WOLFPACK_CONTEXT refs
2. `bun test` — existing tests pass
3. add tests for `validatePlanFormat()` in plan-parsing.test.ts
4. manual: start ralph with a malformatted plan → verify error message instead of silent exit
5. manual: start gemini interactive session → verify context injection via `-i`
