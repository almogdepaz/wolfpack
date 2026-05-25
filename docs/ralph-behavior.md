# Ralph — Behavioral Specification

## Overview

Ralph is an iterative AI agent loop. It reads a plan file (PLAN.md), extracts tasks one at a time, runs an agent (claude/codex/gemini/cursor) on each, and tracks completion in a separate progress file. Supports worktree isolation, cleanup/audit phases, and multi-machine deployment.

Ralph is opt-in in the UI: users must enable **Settings → Ralph Loop → Enable Ralph Loop** before Ralph controls appear. API routes still exist server-side; the setting gates UI visibility/discoverability.

---

## Files & State

| File | Purpose | Lifecycle |
|------|---------|-----------|
| `PLAN.md` | Task definitions (headers + checkboxes). Only mutated to append subtasks. | Persists across runs |
| `progress.txt` | Completion log. `DONE: checkbox: <text>` or `DONE: section: <header>` lines. Only written by the worker — agent must NOT write to it. | Deleted on cancel/dismiss |
| `.ralph.log` | Iteration output, status detection, summary. Contains `all_tasks_done: true` when worker confirms completion. Overwritten each run. | Deleted on dismiss |
| `.ralph.lock` | Empty file, presence = lock held. Prevents concurrent runs. | Deleted on cancel/dismiss/exit |
| `.ralph_iter.tmp` | Last iteration's raw agent output. Cleaned up per iteration. | Transient |
| `.ralph-response.json` | Structured per-iteration agent response. The runner reads this for completion/subtask decisions instead of parsing stdout. All agents use this same file/schema contract. | Transient |

---

## Plan Format

Two supported formats (can coexist):

**Section headers:**
```
## 1. Task title
Body text describing the task

## 2. Another task
More details
```

**Checkboxes:**
```
- [ ] Uncompleted task
- [ ] Another task
```

Header regex: `^#{2,3} (?:~~)?(?:\w+ )?\d+[a-z]?[\.\):]\s+`

Matches: `## 1. Title`, `### 2a. Subtitle`, `## Phase 1. Title`, `## 1) Title`

---

## Task Extraction

`extractCurrentTask()` determines what to work on next:

1. Read plan file and progress file
2. **Checkboxes first**: scan for `- [ ] <text>` not in progress
3. **Then section headers**: scan for `TASK_HEADER` not in progress, skip sections where all child checkboxes are completed
4. Return first uncompleted task, or null if all done

Completion is tracked **only** in progress.txt. The plan file is never modified for completion — no strikethrough, no `[x]` marking.

---

## Execution Flow

### Startup

1. Parse CLI args (iterations, plan, agent, worktree mode, etc.)
2. Create progress file if missing
3. Write log header (agent, plan, progress, phases, pid)
4. If `--format`: run numbering agent to canonicalize headers
5. Dedup checkboxes (clean up from crashed runs)
6. Validate plan format (reject if no parseable tasks)
7. If worktree mode: create/reuse main worktree, clean orphan sub-worktrees

### Iteration Loop

For each iteration `i` from 1 to `maxIterations`:

1. **Extract task** — if null:
   - Distinguish "all done" from "corrupted plan"
   - Merge outstanding task worktree
   - Run final phases (if any tasks completed)
   - Exit

2. **Same-task guard** — if same section task picked twice in a row:
   - Force-mark done in progress
   - Continue to next iteration

3. **Task-mode worktree management** (task mode only):
   - New section → merge+cleanup previous sub-worktree
   - Create new sub-worktree for section
   - Reuse sub-worktree for checkboxes in same section

4. **Snapshot plan** for corruption detection

5. **Build prompt & run agent** (30min timeout)

6. **Corruption check** — if task count shrank:
   - Run recovery agent with original snapshot
   - If recovery fails, restore from snapshot
   - Continue

7. **Check exit code** — if non-zero, log failure, continue

8. **Structured response detection** — read `.ralph-response.json`:
   - Require valid JSON with `version: 1` and `status: "done" | "needs_subtasks"`
   - Missing/invalid response means the task is not complete
   - For `needs_subtasks`, append `subtasks` strings to plan as `- [ ]` checkboxes, mark parent done, expand iteration budget, and continue

9. **Mark task complete** — only after an explicit `status: "done"`, append to progress.txt

10. **Sync** progress back from sub-worktree, sync plan to project dir

### Post-Loop

1. Merge any outstanding task sub-worktree
2. If tasks remain: skip final phases
3. If all done: run audit phase (if enabled), then cleanup phase (if enabled)
4. Log summary (duration, tasks completed, files changed)
5. Exit

---

## Final Phases

### Audit+Fix (opt-in, `--audit-fix true`)

Security-focused differential review:
- Diff all changes since start commit
- Risk-score changed files
- Deep analysis on high-risk files
- Fix CRITICAL/HIGH issues
- Append audit report to progress

### Cleanup (default on, `--cleanup true`)

Dead code removal + simplification:
- Inventory changed files + their importers
- Identify unreachable code, unused imports
- Simplify, reduce duplication
- Apply fixes, test, commit

Both phases only run if tasks were completed in this run (`i > 1`).

---

## Worktree Modes

Ralph-managed git worktrees live under `<project>/.worktrees/` using VS Code's repo-local worktree convention. Legacy `.wolfpack/worktrees/` entries are still recognized during cleanup.

### Off (`--worktree false`)

All work in project root. No isolation.

### Plan Mode (`--worktree plan`)

Single accumulator worktree for entire plan:
- Branch: `ralph/plan-{slug}`
- Created at startup, reused on restart
- Plan + progress copied in (gitignored)
- All iterations run here

### Task Mode (`--worktree task`)

Main worktree + per-section sub-worktrees:
- Main: `ralph/plan-{slug}` (accumulator)
- Per-section: `ralph/{num}-{slug}` (branched off main)
- Section checkboxes reuse same sub-worktree
- On section change: merge sub-worktree into main, cleanup, create new
- On merge failure: preserve worktree, log paths, exit

### Restart Behavior

- Look for existing worktree on same branch
- If found: reuse it, preserve existing plan+progress
- If not found: create fresh, copy from project dir
- Orphan sub-worktrees cleaned on startup

---

## API Endpoints

### Status

| Endpoint | Method | Returns |
|----------|--------|---------|
| `/api/ralph` | GET | `{ loops: RalphStatus[] }` — all projects with ralph logs |
| `/api/ralph/log?project=X` | GET | `{ log, totalLines }` — last 128KB/500 lines |
| `/api/ralph/plans?project=X` | GET | `{ plans: string[] }` — .md files in project |
| `/api/ralph/task-count?project=X&plan=Y` | GET | `{ done, total, issues }` |
| `/api/ralph/branches?project=X` | GET | `{ branches, current }` |

### Control

| Endpoint | Method | Body | Effect |
|----------|--------|------|--------|
| `/api/ralph/start` | POST | `{ project, iterations, planFile, agent, cleanup, auditFix, worktree, ... }` | Spawn worker, acquire lock. UI access requires **Settings → Ralph Loop → Enable Ralph Loop**. |
| `/api/ralph/cancel` | POST | `{ project }` | SIGTERM process + group, delete progress.txt |
| `/api/ralph/dismiss` | POST | `{ project, deletePlan? }` | Delete log + lock + progress, optionally plan, cleanup worktrees |

---

## Status Detection

`parseRalphLog()` reads .ralph.log to determine state:

| Condition | Status |
|-----------|--------|
| PID alive + log contains `=== 🥋 Wax Inspect —` (no complete/failed) | `audit` |
| PID alive + log contains `=== 🥋 Wax Off —` (no complete/failed) | `cleanup` |
| PID alive | `running` |
| PID dead + log contains `all_tasks_done: true` | `done` |
| PID dead + finished timestamp present | `limit` (hit iteration cap) |
| Otherwise | `idle` |

Completion detection is strict: the worker writes `all_tasks_done: true` to the log only when `extractCurrentTask()` returns null and the plan has tasks. No count-based heuristics — the extractor is the single source of truth.

Task counts (for progress bar display): `tasksTotal` from plan file, `tasksDone` from progress file `DONE:` line count. These are display-only and not used for completion detection.

---

## Cancel vs Dismiss

| | Cancel | Dismiss |
|---|--------|---------|
| Requires active loop | Yes | No (must be inactive) |
| Sends SIGTERM | Yes | No |
| Deletes progress.txt | Yes | Yes |
| Deletes .ralph.log | No | Yes |
| Deletes .ralph.lock | Via SIGTERM handler | Yes |
| Deletes plan file | No | Only if `deletePlan: true` |
| Cleans worktrees | Via SIGTERM handler | Yes (`cleanupAllExceptFinal`) |
| Card visible after | Yes (stopped) | No (removed) |

---

## Continue (Restart) Flow

1. UI pre-fills form from stopped loop's config
2. All fields locked except iteration count
3. User adjusts iterations, clicks Launch
4. New worker spawned with same config
5. Worker reuses existing worktree (if worktree mode)
6. Progress file was deleted on cancel → starts fresh
7. Plan file unchanged → all tasks available

---

## Structured Response Protocol

Every agent uses the same runner contract: write `.ralph-response.json` before exit. Codex is invoked with native structured-output flags (`--output-last-message` + `--output-schema`); claude/gemini/cursor are prompted to write the same file and schema. The response file and other `.ralph-*`/progress/log files are runner-owned transient files and must not be committed. Ralph also adds these transient paths to the active worktree's `.git/info/exclude` so `git add -A` does not stage them.

Done response:
```json
{
  "version": 1,
  "status": "done",
  "prereqs": ["assumption or prerequisite"],
  "tests": ["test command or planned test"],
  "done": ["completion criterion met"],
  "subtasks": []
}
```

Needs-subtasks response:
```json
{
  "version": 1,
  "status": "needs_subtasks",
  "prereqs": ["assumption or prerequisite"],
  "tests": ["test command or planned test"],
  "done": ["completion criterion"],
  "subtasks": ["Subtask description A", "Subtask description B"]
}
```

For `needs_subtasks`, Ralph then:
1. Validates the JSON response schema
2. Strips markdown headers and `~~` from subtask text
3. Appends as `- [ ] <subtask>` checkboxes to plan
4. Marks parent task done in progress (never re-picked)
5. Expands iteration budget: `maxIterations += subtasks.length`
6. Cap: max 5 expansions, ceiling at `max(ITERATIONS*2, 100)`

---

## Guards & Edge Cases

| Guard | Trigger | Action |
|-------|---------|--------|
| Same-task-twice | Section task extracted consecutively | Force-mark done, skip |
| PID reuse | Lock file PID alive but not ralph | Remove stale lock |
| Stale lock | Lock PID dead, non-numeric, or ≤1 | Remove lock, allow start |
| Merge failure | Task sub-worktree won't merge | Preserve worktree, log paths, exit |
| Plan corruption | Task count shrank after iteration | Recovery agent, then snapshot restore |
| Subtask ceiling | 5 expansions reached | Stop expanding, work remaining tasks |
| Iteration timeout | No agent output in 30 minutes | Kill agent, continue |

---

## Agent Configuration

| Agent | Binary | Key flags |
|-------|--------|-----------|
| claude | `claude` | `--print --dangerously-skip-permissions --allowedTools [...]` |
| codex | `codex` | `exec --disable apps --dangerously-bypass-approvals-and-sandbox --output-last-message <response> --output-schema <schema>` |
| cursor | `cursor` | Agent-specific flags |
| gemini | `gemini` | Agent-specific flags |

Allowed tools: Edit, Write, Read, Glob, Grep, Bash (git, npm, bun, cargo, go, python, make, ls, mkdir, rm, mv, cp, cat, echo, touch)

### Srt sandbox policy

Ralph's srt settings are project-scoped by default: write access is limited to the active worktree, `/tmp`, the active repository's git metadata directories, and the agent's required home-state directory. Git metadata write access is required so sandboxed agents can create commits from normal repos and linked worktrees; it intentionally includes the common git dir for linked worktrees. For Codex, the sandbox intentionally allows writes to the full `~/.codex` directory and network access to `chatgpt.com` / `*.chatgpt.com`. This is broader persistent state access than the project worktree; it is accepted because Codex initializes mutable state under `~/.codex` before stable per-session subpaths exist. Codex is run with `--disable apps` because Ralph does not need Codex app/plugin tooling and the apps worker emits sandbox-specific `wham/apps` transport warnings. Do not widen this further without a failing Codex+srt smoke log and a regression test.

Default Ralph srt does not allow local listener creation or host broker socket access. Plans or verification steps that need Unix domain socket bind/listen (for example, starting `wolfpack-broker` inside srt), localhost TCP bind/listen, browser/dev servers, broker-backed perf/integration tests, or direct access to Wolfpack's broker socket must run that phase outside srt (`--sandbox false`) or use an explicitly requested socket-capable profile. Do not enable `allowAllUnixSockets` in default Ralph runs. If a task truly needs Unix socket access inside srt, the profile must scope `network.allowUnixSockets` to the exact socket path/dir and ensure the socket directory is writable only when bind/listen is required.

---

## Limits

| Parameter | Value |
|-----------|-------|
| Max iterations | 500 (API-enforced) |
| Min iterations | 1 |
| Iteration timeout | 30 minutes |
| Subtask expansions | 5 per run |
| Expansion ceiling | max(iterations×2, 100) |
| Log tail | 128KB / 500 lines |
| Peer timeout | 3 seconds |
