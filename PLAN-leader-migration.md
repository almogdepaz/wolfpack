# Fenris → Main Migration Plan

> Feature-by-feature migration. Each feature is self-contained, brings its own
> types/config/tests, and can land in main independently.

## Features (priority order)

| # | Feature | What it does | Effort |
|---|---------|-------------|--------|
| 1 | **Kobra Kai** | Parallel agent execution via DAG, worktrees, wave merging | large |
| 2 | **Approval System** | Human-in-the-loop gates for destructive actions | small |
| 3 | **Scanner** | Periodic project scanning, flags, snapshots | medium |
| 4 | **Leader Lifecycle** | Toggle, scan loop, route mounting | medium |
| 5 | **Memory System** | LLM extraction, synthesis, SQLite FTS5 retrieval | medium |
| 6 | **Chat** | Project chat with LLM context | medium |
| 7 | **Peer Discovery** | Tailscale multi-machine awareness | medium |
| 8 | **Remote Ralph** | Cross-machine task routing | medium |
| 9 | **Auth/RBAC** | API keys, roles | small |
| 10 | **Audit Trail** | JSONL event logging | small |
| 11 | **PR Service** | GitHub PR tracking, auto-merge | medium |
| 12 | **Auto-scaling** | Capacity monitoring | small |
| 13 | **Container Runner** | Docker agent isolation | medium |
| 14 | **Daily Summaries** | Scheduled digests | small |

Each feature gets a sub-plan before implementation starts.

---

# Feature 1: Kobra Kai (Parallel Agent Execution)

## Concept

Decompose a goal into a DAG of tasks → group into waves (parallelizable sets) →
execute each wave by spawning one agent per task in its own git worktree →
merge all worktree branches when wave completes → advance to next wave → repeat.

**Key distinction from ralph:** Ralph is a sequential loop (one agent, many tasks).
Kobra Kai is parallel execution (many agents, one task each, coordinated in waves).

```
Goal: "add auth + tests + docs"
        ↓ planner
┌─────────────────────────────┐
│ DAG:                        │
│   Task 1: add auth module   │  ← wave 0 (parallel)
│   Task 2: add middleware    │  ← wave 0 (parallel)
│   Task 3: write tests       │  ← wave 1 (depends on 1,2)
│   Task 4: write docs        │  ← wave 1 (depends on 1,2)
└─────────────────────────────┘
        ↓ wave 0
┌──────────────┐  ┌──────────────┐
│ worktree-t1  │  │ worktree-t2  │   ← 2 agents run simultaneously
│ agent → auth │  │ agent → mw   │
└──────┬───────┘  └──────┬───────┘
       └────────┬────────┘
        ↓ merge wave 0
        ↓ wave 1
┌──────────────┐  ┌──────────────┐
│ worktree-t3  │  │ worktree-t4  │   ← 2 agents run simultaneously
│ agent → test │  │ agent → docs │
└──────┬───────┘  └──────┬───────┘
       └────────┬────────┘
        ↓ merge wave 1
        ✓ done
```

## What we're porting from Fenris

| Fenris source | Destination | What |
|--------------|-------------|------|
| `planner.ts` | `src/kobra-kai/planner.ts` | DAG generation, wave computation |
| `leader/git-worktree.ts` | `src/kobra-kai/worktree.ts` | Worktree create/remove |
| `leader/merge-engine.ts` | `src/kobra-kai/merge.ts` | Wave merging, JSON conflict resolution |
| subset of `leader/orchestration.ts` | `src/kobra-kai/orchestrate.ts` | Wave advancement loop |
| types from various | `src/kobra-kai/types.ts` | TaskNode, TaskDAG, Wave, etc. |

## What we're NOT porting

- Leader toggle / lifecycle / scanner
- Approval system (everything auto-executes)
- Memory enrichment
- Remote/multi-machine routing
- LLM code review gate (auto-approve)
- LLM task reranking (static priority)
- Container runner

## Execution model

### Per task (in a worktree)

1. Create worktree: `git worktree add ~/Dev/{project}-wt-{taskId} -b wt/{project}/{taskId} {baseBranch}`
2. Create a local `PLAN.md` in the worktree with the single task as `## 1. {title}`
3. Build prompt: project context (gathered at spawn time) + task description + subtask protocol
4. Spawn agent in worktree → agent implements or outputs `<subtasks>`
5. If subtasks generated → append as checkboxes to worktree `PLAN.md` → iterate sequentially
   (reuse ralph's `extractCurrentTask` / `runIteration` / `markDone` / corruption detection)
6. If task is direct → agent implements, done
7. Max iterations per task: configurable (default 10) to prevent runaway
8. When all subtasks done (or direct task done) → task complete

**Within a task: sequential** (ralph-style iteration if subtasks appear).

### Per wave

1. Create all worktrees for wave tasks
2. Spawn all task loops in parallel (one per worktree)
3. Poll: check each task loop's process (pid alive check)
4. All tasks done → `mergeWave()` (sequential merge of task branches into integration branch)
5. Cleanup worktrees
6. If more waves → create next wave worktrees (based off integration branch) → spawn → repeat
7. If no more waves → done

**Between tasks: parallel** (worktrees, waves).

### Prompt strategy

Each agent receives:
1. **Project context** (shared, gathered at spawn time) — file tree, conventions, existing structure
2. **Task description** (from `TaskNode.description`) — what to build, interfaces, file boundaries
3. **Subtask protocol** (reuse `RALPH_AGENT_CONTEXT`) — how to output `<subtasks>` if task is too big
4. **Rules** — stay in worktree dir, run tests, commit

The planner produces clear task descriptions. The orchestrator gathers project context
at spawn time and combines them. No DAG awareness injected into agents.

### Concurrency control

Per-wave cap, specified at launch time (`maxConcurrent` param).

- Wave has 5 tasks, `maxConcurrent: 3` → spawn 3, queue 2
- As each agent finishes → poll picks up the exit → spawns next queued task from same wave
- All wave tasks done → merge → next wave (same cap applies)
- Default: 3 (if not specified)
- No global cap across orchestrations — each launch manages its own

### Advancement trigger

`setInterval` in serve.ts — polls active orchestrations every 30s.
Checks if task loops in current wave have exited. If any exited + queued tasks remain,
spawns next. If all wave tasks done, merges + advances.
Simple, no scanner or leader needed.

---

## Sub-plan

### Step 1: Types
**Status: pending**

Create `src/kobra-kai/types.ts` — all types Kobra Kai needs, self-contained.

```typescript
interface TaskNode {
  id: string;              // "1", "1a", "2"
  title: string;
  description: string;     // full task prompt content
  depends_on: string[];
  estimated_files: string[];
  requires?: TaskRequirements;
  verify?: string;         // shell command to verify completion
  wave: number;            // computed by topological sort
  status: "pending" | "in_progress" | "completed" | "failed";
  branch?: string;         // wt/{project}/{taskId}
  worktree_path?: string;
  pid?: number;            // agent process pid (while running)
}

interface TaskRequirements {
  gpu?: boolean;
  agent?: string;          // specific agent binary required
  minDisk?: number;
  os?: string;
}

interface Wave {
  wave: number;
  task_ids: string[];
  integration_branch?: string;  // integrate/{project}/wave-N
  status: "pending" | "in_progress" | "merging" | "merged" | "failed";
}

interface TaskDAG {
  tasks: TaskNode[];
  waves: Wave[];
  metadata: {
    project: string;
    created_at: string;
    source: "decomposed" | "scheduled";
  };
}

interface MergeResult {
  ok: boolean;
  integrationBranch: string;
  merged: string[];
  unexpectedFiles: { taskId: string; files: string[] }[];
  conflicts: { taskId: string; files: string[] }[];
  error?: string;
}
```

No dependencies. No config. Just types.

---

### Step 2: Planner
**Status: pending**

Create `src/kobra-kai/planner.ts` — turn a goal or plan into a DAG.

**Pure functions (no LLM, highly testable):**
- `computeWaves(dag: TaskDAG): Wave[]` — topological sort, assign wave numbers
- `detectFileOverlaps(dag: TaskDAG): { wave: number; tasks: [string, string]; files: string[] }[]`
- `resolveOverlaps(dag: TaskDAG): TaskDAG` — add edges to serialize overlapping tasks, recompute waves

**LLM-powered (spawn `claude --print`):**
- `decompose(goal: string, projectDir: string): Promise<TaskDAG>` — goal → DAG
  - Gathers context: git branch, last 10 commits, file tree
  - Prompts LLM to produce 3-8 tasks with deps + file estimates
  - Calls `resolveOverlaps()` on output
  - Writes `task-dag.json`
- `schedule(planContent: string, projectDir: string): Promise<TaskDAG>` — existing PLAN.md → DAG
  - Prompts LLM to infer dependency edges from flat task list
  - Calls `resolveOverlaps()` on output
  - Writes `task-dag.json`

**LLM spawn:** inline helper, just `Bun.spawn(["claude", "--print", "-p", prompt])` + collect stdout. no abstraction layer needed yet.

**Tests:**
- `computeWaves` — various DAG shapes (linear, diamond, wide, single task)
- `detectFileOverlaps` — overlapping and non-overlapping cases
- `resolveOverlaps` — verify edges added correctly, waves recomputed
- `decompose` / `schedule` — mock spawn, verify prompt construction + JSON parsing
- DAG write/read roundtrip to `task-dag.json`

---

### Step 3: Worktree Manager
**Status: pending**

Create `src/kobra-kai/worktree.ts` — git worktree lifecycle for tasks.

**Functions:**
- `createTaskWorktree(projectDir: string, taskId: string, baseBranch: string): Promise<string>`
  - Runs: `git worktree add ~/Dev/{project}-wt-{taskId} -b wt/{project}/{taskId} {baseBranch}`
  - Returns worktree path
- `removeTaskWorktree(projectDir: string, worktreePath: string, branch: string): Promise<void>`
  - Runs: `git worktree remove --force {path}` + `git branch -D {branch}`
- `createWaveWorktrees(projectDir: string, wave: Wave, dag: TaskDAG): Promise<void>`
  - Batch create for all tasks in wave
  - Base branch: wave 0 → `main`, wave N → `integrate/{project}/wave-{N-1}`
  - Updates `task.worktree_path` and `task.branch` in DAG
- `listProjectWorktrees(projectDir: string): Promise<string[]>`
  - Runs: `git worktree list --porcelain`, filters for project worktrees
- `cleanupWaveWorktrees(projectDir: string, wave: Wave, dag: TaskDAG): Promise<void>`
  - Remove all worktrees + branches for a completed wave

**Naming conventions:**
- Worktree dir: `~/Dev/{project}-wt-{taskId}` (sibling to project)
- Branch: `wt/{project}/{taskId}`
- Integration branch: `integrate/{project}/wave-{N}`

**Tests:**
- Create/remove in temp git repo
- Batch create for wave
- Branch naming correctness
- Base branch selection (wave 0 vs wave N)
- Cleanup removes both worktree dir and branch
- `listProjectWorktrees` filters correctly

---

### Step 4: Merge Engine
**Status: pending**

Create `src/kobra-kai/merge.ts` — merge task branches after wave completion.

**Functions:**
- `mergeWave(projectDir: string, wave: Wave, dag: TaskDAG): Promise<MergeResult>`
  1. Validate diffs: compare actual changed files to `estimated_files` per task
  2. Create integration branch: `git checkout -b integrate/{project}/wave-{N} {baseBranch}`
  3. Sequential merge: `git merge --no-ff wt/{project}/{taskId}` per task
  4. On conflict: attempt `jsonMerge()` for JSON files, report others
  5. Cleanup: `cleanupWaveWorktrees()`
  6. Return `MergeResult`
- `jsonMerge(base: any, ours: any, theirs: any): any` — 3-way JSON merge
  - Objects: recurse per key
  - Arrays: deduplicate primitives
  - Scalars: take "theirs" (later task wins)

**Base branch for integration:**
- Wave 0: `main`
- Wave N: `integrate/{project}/wave-{N-1}`

**Tests:**
- Clean merge (no conflicts)
- JSON conflict auto-resolution (verify 3-way logic)
- Non-JSON conflict reported in result
- Unexpected files flagged but not blocking
- Integration branch created with correct name and base
- Multiple tasks merged sequentially

---

### Step 5: Orchestration Loop
**Status: pending**

Create `src/kobra-kai/orchestrate.ts` — the coordinator.

**State:** Persisted in `task-dag.json` (task statuses, wave statuses, pids).

**Functions:**

- `launchOrchestration(projectDir: string, dag: TaskDAG): Promise<void>`
  1. Write `task-dag.json`
  2. `createWaveWorktrees()` for wave 0
  3. `spawnWaveTasks()` for wave 0
  4. Save state (pids, statuses)

- `spawnWaveTasks(projectDir: string, wave: Wave, dag: TaskDAG): Promise<void>`
  - For each task in wave:
    1. Write local `PLAN.md` in worktree with single task as `## 1. {title}\n{description}`
    2. Gather project context (file tree, conventions — same as ralph's approach)
    3. Build prompt: project context + task description + subtask protocol
    4. Spawn task runner as detached process in worktree (ralph-style iteration loop)
    5. Record pid, set `task.status = "in_progress"`, `wave.status = "in_progress"`
  - All tasks spawn concurrently

- `runTaskLoop(worktreePath: string, maxIterations: number): Promise<void>`
  - Reuses ralph's core logic: `extractCurrentTask` → `buildPrompt` → `runIteration` → `markDone`
  - Handles subtask expansion (same `<subtasks>` protocol)
  - Runs in worktree dir, commits to worktree branch
  - Exits when: all tasks done OR max iterations hit
  - This is effectively a mini-ralph scoped to one worktree

- `gatherProjectContext(projectDir: string): string`
  - File tree (top 2-3 levels)
  - Key config files (package.json, tsconfig, etc.)
  - Recent git log
  - Returned as string for prompt injection

- `buildTaskPrompt(projectContext: string, task: TaskNode): string`
  - project context (shared)
  - task description (specific)
  - subtask protocol (from `RALPH_AGENT_CONTEXT`)
  - rules: stay in worktree, run tests, commit
  - NO DAG awareness — task description is self-contained

- `advanceOrchestration(projectDir: string): Promise<AdvanceResult>`
  1. Load `task-dag.json`
  2. Find current wave (first non-merged wave)
  3. For each in_progress task: check if pid still alive (`process.kill(pid, 0)`)
  4. Dead pid → check worktree plan (all tasks done?) → mark completed or failed
  5. If any task failed → mark wave failed, stop (user decides)
  6. If all tasks completed → `mergeWave()` → advance
  7. If merge ok → `createWaveWorktrees()` for next wave → `spawnWaveTasks()`
  8. If all waves merged → orchestration complete
  9. Save state

  Returns: `"waiting" | "advanced" | "completed" | "failed" | "merge_failed"`

- `getOrchestrationStatus(projectDir: string): OrchestrationStatus`
  - Current wave, per-task status, active pids, overall progress

**Polling:**
- `startOrchestrationPoller()` — `setInterval` (30s default), calls `advanceOrchestration()` for each project with active orchestration
- `stopOrchestrationPoller()` — clear interval
- Registered in serve.ts on server start

**Tests:**
- Launch creates worktrees + spawns task loops
- Task loop handles direct implementation (no subtasks)
- Task loop handles subtask expansion + iteration
- Max iterations prevents runaway
- Advance detects completed task loops
- Advance triggers merge when wave done
- Advance spawns next wave after merge
- Full flow: launch → poll → advance → merge → next wave → complete
- Failed task stops advancement
- State persistence across advances
- Prompt includes project context + task description (no DAG)

---

### Step 6: Routes
**Status: pending**

Create `src/kobra-kai/routes.ts` — API endpoints.

Mount in `src/server/index.ts` or `src/server/routes.ts` under `/api/kobra-kai/*`.

| Method | Path | Body/Query | Returns |
|--------|------|-----------|---------|
| POST | `/api/kobra-kai/plan` | `{ mode, goal?, planFile?, project }` | `TaskDAG` |
| POST | `/api/kobra-kai/launch` | `{ project, maxConcurrent? }` | `{ ok, waves, tasks }` |
| GET | `/api/kobra-kai/status/:project` | — | `OrchestrationStatus` |
| POST | `/api/kobra-kai/advance/:project` | — | `AdvanceResult` |
| GET | `/api/kobra-kai/dag/:project` | — | `TaskDAG` (raw) |
| POST | `/api/kobra-kai/cancel/:project` | — | kills all agent pids, cleans up |

**Flow from UI:**
1. User enters goal → `POST /plan` → gets DAG back
2. User reviews DAG → `POST /launch` → agents start
3. UI polls `GET /status/:project` → shows progress
4. Advancement happens automatically via poller (or manual `POST /advance`)

**Tests:**
- Route handlers (mock orchestration functions)
- Validation (project exists, DAG exists for launch)
- Cancel kills active agents

---

### Step 7: Frontend
**Status: pending**

Cherry-pick from Fenris `public/index.html` — add Kobra Kai UI to main.

**Components:**
- **Kobra Kai tab/view** — new navigation entry
- **Plan form** — goal text input, project dropdown, mode toggle (decompose/schedule), "Plan" button
- **DAG visualization** — wave rows, task cards with status badges (pending/running/done/failed)
- **Launch button** — after plan is generated
- **Progress display** — current wave, per-task status, agent output preview
- **Cancel button** — abort orchestration

**Approach:**
- Read Fenris's index.html, extract kobra-kai-specific CSS/JS/HTML blocks
- Adapt to main's existing UI patterns (view switching, header, etc.)
- Test mobile + desktop

---

## Open questions (resolved)

| Question | Resolution |
|----------|-----------|
| Does ralph handle worktrees? | No — but Kobra Kai reuses ralph's iteration logic (extract/run/mark) per worktree. |
| How does advancement trigger? | `setInterval` poller in serve.ts (30s). |
| Auto-start next wave? | Yes — when wave done, auto-merge + auto-start next wave. |
| What prompt does agent get? | Project context (gathered at spawn time) + task description + subtask protocol. No DAG. |
| What if task is too big? | Agent outputs `<subtasks>`, they run iteratively in the same worktree (ralph-style). |
| Where does project context come from? | Orchestrator gathers at spawn time, not the planner. |
