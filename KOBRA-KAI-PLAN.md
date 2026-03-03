# Kobra Kai — Implementation Plan

> Parallel agent execution via DAG, worktrees, wave merging.
> All code lives in `src/kobra-kai/`. Self-contained feature, no leader dependency.

---

## ~~1. Create types module~~

Create `src/kobra-kai/types.ts` with all Kobra Kai types. Export everything.

```typescript
export interface TaskNode {
  id: string;                // "1", "1a", "2"
  title: string;
  description: string;       // self-contained task prompt
  depends_on: string[];
  estimated_files: string[];
  requires?: TaskRequirements;
  verify?: string;            // shell command to verify completion
  wave: number;               // computed by computeWaves()
  status: "pending" | "in_progress" | "completed" | "failed";
  branch?: string;            // wt/{project}/{taskId}
  worktree_path?: string;
  pid?: number;               // agent process pid while running
}

export interface TaskRequirements {
  gpu?: boolean;
  agent?: string;
  minDisk?: number;
  os?: string;
}

export interface Wave {
  wave: number;
  task_ids: string[];
  integration_branch?: string; // integrate/{project}/wave-N
  status: "pending" | "in_progress" | "merging" | "merged" | "failed";
}

export interface TaskDAG {
  tasks: TaskNode[];
  waves: Wave[];
  metadata: {
    project: string;
    created_at: string;
    source: "decomposed" | "scheduled";
  };
}

export interface MergeResult {
  ok: boolean;
  integrationBranch: string;
  merged: string[];
  unexpectedFiles: { taskId: string; files: string[] }[];
  conflicts: { taskId: string; files: string[] }[];
  error?: string;
}

export interface OrchestrationStatus {
  project: string;
  status: "idle" | "active" | "completed" | "failed";
  currentWave: number;
  totalWaves: number;
  tasks: { id: string; title: string; status: string; wave: number }[];
  activeAgents: number;
  queuedTasks: number;
  maxConcurrent: number;
  startedAt: string | null;
}

export type AdvanceResult =
  | "waiting"       // agents still running
  | "spawned"       // spawned queued tasks from current wave
  | "advanced"      // merged wave, started next
  | "completed"     // all waves done
  | "failed"        // a task failed
  | "merge_failed"; // wave merge failed
```

No imports needed. Pure type definitions.

<!-- files: src/kobra-kai/types.ts -->

---

## ~~2. Create planner — pure functions~~

Create `src/kobra-kai/planner.ts` with the pure (non-LLM) planning functions.
These are the algorithmic core — topological sort, overlap detection, DAG I/O.

Functions to implement:

**`computeWaves(dag: TaskDAG): Wave[]`**
- Topological sort via DFS
- Tasks with no `depends_on` → wave 0
- Each task's wave = `max(wave of each dependency) + 1`
- Group task IDs by wave number, sort ascending
- Also sets `task.wave` on each TaskNode
- Returns array of Wave objects with `status: "pending"`

**`detectFileOverlaps(dag: TaskDAG): { wave: number; tasks: [string, string]; files: string[] }[]`**
- For each wave, check all task pairs
- If two tasks in the same wave share any `estimated_files` entries → overlap
- Return list of overlaps

**`resolveOverlaps(dag: TaskDAG): TaskDAG`**
- For each overlap, add a `depends_on` edge from the second task to the first (by ID order)
- Recompute waves via `computeWaves()`
- Return mutated DAG

**`loadDAG(projectDir: string): TaskDAG | null`**
- Read `task-dag.json` from projectDir, parse, return
- Return null if doesn't exist

**`saveDAG(projectDir: string, dag: TaskDAG): void`**
- Write `task-dag.json` to projectDir

Write tests in `tests/unit/kobra-kai/planner.test.ts`:
- `computeWaves`: linear chain (A→B→C), diamond (A→B,C→D), wide (A,B,C all wave 0), single task
- `detectFileOverlaps`: overlapping pair, no overlaps, multiple overlaps
- `resolveOverlaps`: verify edge added, waves recomputed correctly
- `loadDAG`/`saveDAG`: roundtrip to temp dir

<!-- depends: 1 -->
<!-- files: src/kobra-kai/planner.ts, tests/unit/kobra-kai/planner.test.ts -->

---

## ~~3. Add LLM-powered planning (decompose + schedule)~~

Add to `src/kobra-kai/planner.ts`:

**`decompose(goal: string, projectDir: string): Promise<TaskDAG>`**
- Gather project context: `git log --oneline -10`, `git branch --show-current`, file tree (2 levels deep via `find . -maxdepth 2 -not -path '*/node_modules/*' -not -path '*/.git/*'`)
- Build prompt asking LLM to produce a JSON array of tasks:
  ```
  You are a technical project planner. Given a goal and project context,
  decompose it into 3-8 parallel-safe tasks.

  Output ONLY valid JSON matching this schema:
  { "tasks": [{ "id": "1", "title": "...", "description": "...",
    "depends_on": [], "estimated_files": ["..."] }, ...] }

  Rules:
  - Each task description must be self-contained (an agent will implement it with no other context beyond the project itself)
  - estimated_files should list files the task will create or modify
  - Use depends_on to express ordering constraints
  - Tasks that can run in parallel should have no dependency between them
  - IDs are simple strings: "1", "2", "3" etc.
  ```
- Spawn: `Bun.spawn(["claude", "--print", "-p", prompt])`, collect stdout
- Parse JSON from response (handle markdown fences: strip ```json and ``` if present)
- Build TaskDAG from parsed tasks, call `resolveOverlaps()`, call `computeWaves()`
- `saveDAG(projectDir, dag)`
- Return dag

**`schedule(planContent: string, projectDir: string): Promise<TaskDAG>`**
- Same context gathering as decompose
- Prompt: given this existing plan, infer dependency edges and produce same JSON format
- Same spawn/parse/resolve/save flow

**Helper: `spawnLLM(prompt: string, timeoutMs?: number): Promise<string>`**
- `Bun.spawn(["claude", "--print", "-p", prompt])`
- Collect stdout chunks into string
- Timeout default 120_000 (2 min)
- Throw on non-zero exit or timeout
- Used by both decompose and schedule

**Helper: `parseJSONResponse(raw: string): any`**
- Strip markdown fences if present (```json ... ```)
- `JSON.parse()` the result
- Throw with descriptive error on failure

Add tests in `tests/unit/kobra-kai/planner.test.ts` (append to existing):
- `spawnLLM`: mock Bun.spawn, verify args, test timeout
- `parseJSONResponse`: valid JSON, fenced JSON, invalid JSON
- `decompose`/`schedule`: mock spawnLLM, verify prompt includes project context, verify DAG structure

<!-- depends: 2 -->
<!-- files: src/kobra-kai/planner.ts, tests/unit/kobra-kai/planner.test.ts -->

---

## ~~4. Create worktree manager~~

Create `src/kobra-kai/worktree.ts`.

All git commands run via `Bun.spawn` with `cwd: projectDir`. Use a helper:
```typescript
async function git(projectDir: string, ...args: string[]): Promise<string>
```
That spawns `git` with args in projectDir, collects stdout, throws on non-zero exit.

**`createTaskWorktree(projectDir: string, taskId: string, baseBranch: string): Promise<string>`**
- Extract project name from projectDir (`path.basename(projectDir)`)
- Worktree path: `path.resolve(projectDir, '..', \`${projectName}-wt-${taskId}\`)`
- Branch name: `wt/${projectName}/${taskId}`
- Run: `git worktree add {worktreePath} -b {branchName} {baseBranch}`
- Return worktree path

**`removeTaskWorktree(projectDir: string, worktreePath: string, branch: string): Promise<void>`**
- Run: `git worktree remove --force {worktreePath}` (from projectDir)
- Run: `git branch -D {branch}` (from projectDir)
- Ignore errors if already removed

**`createWaveWorktrees(projectDir: string, wave: Wave, dag: TaskDAG): Promise<void>`**
- Determine base branch:
  - wave.wave === 0 → `"main"`
  - wave.wave > 0 → `integrate/${projectName}/wave-${wave.wave - 1}`
- For each taskId in wave.task_ids:
  - Find task in dag.tasks
  - `createTaskWorktree(projectDir, taskId, baseBranch)`
  - Set `task.worktree_path` and `task.branch` on the TaskNode

**`cleanupWaveWorktrees(projectDir: string, wave: Wave, dag: TaskDAG): Promise<void>`**
- For each taskId in wave.task_ids:
  - Find task in dag.tasks
  - If `task.worktree_path` exists: `removeTaskWorktree(projectDir, task.worktree_path, task.branch!)`

**`listProjectWorktrees(projectDir: string): Promise<string[]>`**
- Run: `git worktree list --porcelain`
- Parse output, filter for paths containing `-wt-`
- Return paths

Write tests in `tests/unit/kobra-kai/worktree.test.ts`:
- Setup: create temp dir with `git init`, initial commit
- `createTaskWorktree`: verify dir created, branch exists, correct base
- `removeTaskWorktree`: verify dir + branch removed
- `createWaveWorktrees`: verify batch creation, task fields updated
- `cleanupWaveWorktrees`: verify all cleaned
- `listProjectWorktrees`: verify filtering
- Base branch selection: wave 0 uses main, wave N uses integration branch
- Teardown: rm temp dir

<!-- depends: 1 -->
<!-- files: src/kobra-kai/worktree.ts, tests/unit/kobra-kai/worktree.test.ts -->

---

## ~~5. Create merge engine~~

Create `src/kobra-kai/merge.ts`.

Import `git` helper from worktree.ts (or extract to shared `src/kobra-kai/git.ts` if cleaner).
Import types from `./types.ts`.
Import `cleanupWaveWorktrees` from `./worktree.ts`.

**`mergeWave(projectDir: string, wave: Wave, dag: TaskDAG): Promise<MergeResult>`**

Steps:
1. Determine base branch (same logic as worktree: wave 0 → main, wave N → prev integration)
2. Determine integration branch name: `integrate/${projectName}/wave-${wave.wave}`
3. Create integration branch: `git checkout -b {integrationBranch} {baseBranch}`
4. For each taskId in wave.task_ids (sorted by id):
   a. Find task in dag.tasks
   b. Validate diff: `git diff --name-only {baseBranch}...{task.branch}` → compare to `estimated_files`
   c. Flag unexpected files (files changed but not in estimated_files) — non-blocking, just record
   d. Merge: `git merge --no-ff {task.branch} -m "merge task {taskId}: {task.title}"`
   e. If merge conflicts:
      - Check if conflicted files are JSON: `git diff --name-only --diff-filter=U`
      - For JSON files: attempt `jsonMerge()` → `git add` → `git commit`
      - For non-JSON: record in conflicts array, `git merge --abort`
   f. If merge clean: record in merged array
5. Set `wave.integration_branch = integrationBranch`
6. Set `wave.status = "merged"` (if no fatal conflicts)
7. `cleanupWaveWorktrees(projectDir, wave, dag)`
8. Checkout back to original branch: `git checkout {baseBranch}`
9. Return MergeResult

**`jsonMerge(base: any, ours: any, theirs: any): any`**
- If both are objects: recurse per key (union of keys). For shared keys, recurse. For unique keys, keep.
- If both are arrays: concatenate and deduplicate primitives
- Scalars: take `theirs` (the merging task's value wins)
- Type mismatch: take `theirs`

Write tests in `tests/unit/kobra-kai/merge.test.ts`:
- Setup: temp git repo with initial commit, create fake task branches with changes
- Clean merge: two branches modifying different files
- JSON conflict resolution: two branches modifying same JSON file
- Non-JSON conflict: two branches modifying same line in same file → reported
- Unexpected files: task modifies file not in estimated_files → flagged
- Integration branch naming
- `jsonMerge` unit tests: objects, arrays, scalars, nested, type mismatch
- Teardown: rm temp dir

<!-- depends: 1, 4 -->
<!-- files: src/kobra-kai/merge.ts, tests/unit/kobra-kai/merge.test.ts -->

---

## ~~6. Extract shared iteration logic from ralph-macchio~~

Currently `src/ralph-macchio.ts` has private functions for task extraction, marking done,
subtask appending, and agent spawning. Extract these into a shared module so both ralph
and kobra kai's task runner can use them.

Create `src/shared/task-iteration.ts` with functions extracted from `src/ralph-macchio.ts`:

**Extract these functions (keep signatures, make them accept params instead of using module globals):**

- `extractCurrentTask(planPath: string): { task: string; checkbox: boolean } | null`
  - Currently reads from module-scoped `PLAN_PATH` — change to accept path as param

- `markSectionDone(planPath: string, taskText: string): void`
  - Currently reads/writes module-scoped `PLAN_PATH` — parameterize

- `markCheckboxDone(planPath: string, taskText: string): void`
  - Same — parameterize

- `appendSubtasksToPlan(planPath: string, subtasks: string[]): void`
  - Same — parameterize

- `runAgentIteration(prompt: string, cwd: string, agent: string, allowedTools: string, timeoutMs?: number): Promise<{ exitCode: number; output: string }>`
  - Currently uses module-scoped `PROJECT_DIR`, agent config — parameterize

- `parseSubtasks(output: string): string[] | null`
  - Extract the `<subtasks>` parsing logic into its own function

Then update `src/ralph-macchio.ts` to import from `src/shared/task-iteration.ts` instead of
using its own private copies. Ralph should work exactly as before — this is a pure refactor.

Write tests in `tests/unit/shared/task-iteration.test.ts`:
- `extractCurrentTask`: checkbox tasks, header tasks, all done, mixed formats
- `markSectionDone`: header gets strikethrough
- `markCheckboxDone`: checkbox gets checked
- `appendSubtasksToPlan`: appends correctly, preserves existing content
- `parseSubtasks`: valid block, no block, malformed block

**Verify: `bun test` — all existing tests must still pass after refactor.**

<!-- depends: 1 -->
<!-- files: src/shared/task-iteration.ts, src/ralph-macchio.ts, tests/unit/shared/task-iteration.test.ts -->

---

## ~~7. Create task runner (mini-ralph per worktree)~~

Create `src/kobra-kai/task-runner.ts`.

This is the per-worktree iteration loop. Runs as a detached subprocess.
Uses shared iteration logic from `src/shared/task-iteration.ts`.

**Entry point** (when spawned as subprocess):
```typescript
// Parse args: --worktree, --max-iterations, --agent, --project-context
const worktreePath = args["--worktree"];
const maxIterations = parseInt(args["--max-iterations"] || "10");
const agent = args["--agent"] || "claude";
const projectContextPath = args["--project-context"]; // path to .project-context file
```

**`buildPrompt(projectContext: string, taskDesc: string, worktreePath: string): string`**
- Combine:
  ```
  {RALPH_AGENT_CONTEXT}

  ## Project Context
  {projectContext}

  You may ONLY create/edit/delete files under {worktreePath}. Do NOT touch files outside this directory.

  YOUR TASK:
  {taskDesc}

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

  BEGIN.
  ```

**Main loop** (uses imported shared functions):
```
read projectContext from file at projectContextPath
planPath = path.join(worktreePath, "PLAN.md")

for i in 1..maxIterations:
  1. task = extractCurrentTask(planPath)        // from shared
  2. if no task → all done, exit 0
  3. prompt = buildPrompt(projectContext, task.task, worktreePath)
  4. { exitCode, output } = runAgentIteration(prompt, worktreePath, agent, ALLOWED_TOOLS, timeout)  // from shared
  5. if exitCode !== 0 → log error, continue
  6. subtasks = parseSubtasks(output)            // from shared
  7. if subtasks → appendSubtasksToPlan(planPath, subtasks), continue  // from shared
  8. if task.checkbox: markCheckboxDone(planPath, task.task)  // from shared
     else: markSectionDone(planPath, task.task)               // from shared
  9. log progress
exit
```

**Logging**: Write to `.kobra-kai.log` in worktree dir.

Write tests in `tests/unit/kobra-kai/task-runner.test.ts`:
- `buildPrompt`: includes project context + task + RALPH_AGENT_CONTEXT + rules
- Main loop integration: mock agent spawn, verify extract → run → mark flow
- Subtask expansion: agent outputs subtasks → appended → iterated

<!-- depends: 6 -->
<!-- files: src/kobra-kai/task-runner.ts, tests/unit/kobra-kai/task-runner.test.ts -->

---

## ~~8. Create orchestration loop~~

Create `src/kobra-kai/orchestrate.ts`.

Imports from: `./types.ts`, `./planner.ts`, `./worktree.ts`, `./merge.ts`.

**`gatherProjectContext(projectDir: string): Promise<string>`**
- File tree: `find {projectDir} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*-wt-*'`
- Package.json (if exists): read name, scripts, dependencies keys
- Recent git log: `git log --oneline -10`
- Return as formatted string

**`launchOrchestration(projectDir: string, dag: TaskDAG, maxConcurrent: number): Promise<void>`**
1. Save DAG: `saveDAG(projectDir, dag)`
2. Save orchestration config: write `{ maxConcurrent, startedAt: new Date().toISOString() }` to `task-dag-config.json` in projectDir
3. `createWaveWorktrees(projectDir, dag.waves[0], dag)`
4. `spawnWaveTasks(projectDir, dag.waves[0], dag, maxConcurrent)`
5. Save updated DAG (with worktree_path, branch, pid, status updates)
6. Register projectDir in active orchestrations set (module-level `Set<string>`)

**`spawnWaveTasks(projectDir: string, wave: Wave, dag: TaskDAG, maxConcurrent: number): Promise<void>`**
- Gather project context once: `gatherProjectContext(projectDir)`
- Get tasks for this wave from dag
- Split into: first `maxConcurrent` tasks → spawn now, rest → queued (status stays "pending")
- For each task to spawn:
  1. Write `PLAN.md` in worktree: `## 1. {task.title}\n\n{task.description}`
  2. Write project context to a temp file in worktree (`.project-context`)
  3. Spawn detached: `Bun.spawn(["bun", "src/kobra-kai/task-runner.ts", "--worktree", task.worktree_path, "--max-iterations", "10", "--agent", "claude", "--project-context", contextFilePath], { cwd: task.worktree_path, detached: true, stdio: "ignore" })`
  4. `child.unref()`
  5. Set `task.pid = child.pid`, `task.status = "in_progress"`
- Set `wave.status = "in_progress"`

**`advanceOrchestration(projectDir: string): Promise<AdvanceResult>`**
1. Load DAG from `task-dag.json`
2. Load config from `task-dag-config.json` (for maxConcurrent)
3. Find current wave: first wave where `status !== "merged"`
4. If no current wave → return `"completed"`
5. For each task in current wave with `status === "in_progress"`:
   - Check pid alive: `try { process.kill(task.pid!, 0); alive } catch { dead }`
   - If dead:
     - Read worktree PLAN.md, count tasks via `countTasksInContent()`
     - If all done → `task.status = "completed"`
     - Else → `task.status = "failed"`
6. Count: active (in_progress), pending (queued), completed, failed
7. If any failed → save DAG, return `"failed"`
8. If active > 0 and pending > 0 and active < maxConcurrent:
   - Spawn more from pending (up to maxConcurrent - active)
   - Save DAG, return `"spawned"`
9. If active > 0 → save DAG, return `"waiting"`
10. If all completed (no active, no pending):
    - `mergeWave(projectDir, currentWave, dag)`
    - If merge failed → save DAG, return `"merge_failed"`
    - Find next wave
    - If no next wave → save DAG, remove from active set, return `"completed"`
    - `createWaveWorktrees(projectDir, nextWave, dag)`
    - `spawnWaveTasks(projectDir, nextWave, dag, maxConcurrent)`
    - Save DAG, return `"advanced"`

**`getOrchestrationStatus(projectDir: string): OrchestrationStatus`**
- Load DAG, compute status from task/wave states
- Return structured status object

**`cancelOrchestration(projectDir: string): Promise<void>`**
- Load DAG
- For each task with `status === "in_progress"` and pid:
  - `try { process.kill(task.pid!, 'SIGTERM') } catch {}`
  - Set `task.status = "failed"`
- Clean up all worktrees for non-merged waves
- Remove from active set
- Save DAG

**Polling (module-level):**
```typescript
const activeOrchestrations = new Set<string>();
let pollInterval: Timer | null = null;

export function startOrchestrationPoller(intervalMs = 30_000): void
export function stopOrchestrationPoller(): void
```
- `startOrchestrationPoller`: `setInterval` that calls `advanceOrchestration` for each entry in `activeOrchestrations`
- `stopOrchestrationPoller`: `clearInterval`

Write tests in `tests/unit/kobra-kai/orchestrate.test.ts`:
- `gatherProjectContext`: returns file tree + git log
- `launchOrchestration`: creates worktrees, spawns task runners, saves DAG
- `advanceOrchestration`: detects dead pids → marks complete or failed
- `advanceOrchestration`: spawns queued tasks when slots open (concurrency)
- `advanceOrchestration`: triggers merge when wave done
- `advanceOrchestration`: creates next wave after merge
- `advanceOrchestration`: returns "completed" when all waves done
- `cancelOrchestration`: kills pids, cleans worktrees
- Concurrency: 5 tasks, maxConcurrent=2 → only 2 spawn initially

<!-- depends: 2, 4, 5, 7 -->
<!-- files: src/kobra-kai/orchestrate.ts, tests/unit/kobra-kai/orchestrate.test.ts -->

---

## ~~9. Add API routes~~

Add Kobra Kai routes to `src/server/routes.ts`.

Import from `src/kobra-kai/orchestrate.ts` and `src/kobra-kai/planner.ts`.
Follow existing route pattern: add entries to the `routes` dict.

**Routes to add:**

`"POST /api/kobra-kai/plan"`:
- Body: `{ mode: "decompose" | "schedule", goal?: string, planFile?: string, project: string }`
- Validate project exists (check `~/Dev/{project}` dir)
- If mode=decompose: `decompose(goal, projectDir)` → return DAG as JSON
- If mode=schedule: read planFile, `schedule(content, projectDir)` → return DAG as JSON
- Error 400 on missing params, 404 on project not found

`"POST /api/kobra-kai/launch"`:
- Body: `{ project: string, maxConcurrent?: number }`
- Default maxConcurrent: 3
- Load DAG from `task-dag.json` in project dir (must exist, 400 if not)
- Check no active orchestration for project (409 if already running)
- `launchOrchestration(projectDir, dag, maxConcurrent)`
- Start poller if not running: `startOrchestrationPoller()`
- Return: `{ ok: true, waves: dag.waves.length, tasks: dag.tasks.length }`

`"GET /api/kobra-kai/status"`:
- Query param: `?project=name`
- `getOrchestrationStatus(projectDir)` → return as JSON
- 404 if no DAG exists

`"POST /api/kobra-kai/advance"`:
- Query param: `?project=name`
- `advanceOrchestration(projectDir)` → return `{ result: AdvanceResult }`
- For manual triggering (poller handles automatic)

`"GET /api/kobra-kai/dag"`:
- Query param: `?project=name`
- `loadDAG(projectDir)` → return raw DAG JSON
- 404 if no DAG

`"POST /api/kobra-kai/cancel"`:
- Query param: `?project=name`
- `cancelOrchestration(projectDir)`
- Return `{ ok: true }`

Add tests in `tests/integration/kobra-kai-api.test.ts`:
- Plan endpoint: valid decompose request (mock LLM), missing project → 400
- Launch endpoint: valid launch, already running → 409, no DAG → 400
- Status endpoint: returns current state
- Cancel endpoint: stops orchestration
- Use existing test patterns from `tests/integration/api.test.ts`

<!-- depends: 8 -->
<!-- files: src/server/routes.ts, tests/integration/kobra-kai-api.test.ts -->

---

## ~~10. Start poller on server boot~~

Edit `src/server/index.ts`:
- Import `startOrchestrationPoller` from `src/kobra-kai/orchestrate.ts`
- After server starts listening, call `startOrchestrationPoller()` to resume any active orchestrations
- On server shutdown/cleanup, call `stopOrchestrationPoller()`
- The poller is lightweight — if no active orchestrations, it's a no-op Set iteration

This is a small change — just 2-3 lines added to the existing server startup.

<!-- depends: 9 -->
<!-- files: src/server/index.ts -->

---

## ~~11. Run full test suite and verify no regressions~~

- Run `bun test` — all existing tests must pass
- Run new kobra-kai tests specifically: `bun test tests/unit/kobra-kai/ tests/integration/kobra-kai-api.test.ts`
- Verify server starts cleanly with `WOLFPACK_TEST=1 bun src/server/index.ts`
- Check that existing ralph functionality is unaffected
- Check that kobra-kai routes respond correctly

<!-- depends: 10 -->
