# Ralph Loop

Autonomous task runner. Write a markdown plan file, pick an agent, set iterations, and let it rip. Ralph reads the plan, extracts the first incomplete task, hands it to the agent, marks it done, and moves on — implementing, testing, and committing along the way.

## Plan File Format

Tasks use numbered markdown headers. Ralph recognizes this pattern and nothing else:

```markdown
# Plan: My Feature

## Context
Background info, goals, constraints — Ralph skips this.

## 1. Add auth middleware
Implement JWT validation middleware for all API routes.
**Files:** `server.ts`, `auth.ts`

## 2. Write integration tests
Cover login, token refresh, and expired token flows.
**Files:** `tests/auth.test.ts`

## 3. Update API docs
Add auth headers to all endpoint examples.
**Files:** `README.md`
```

**Task header rules:**
- Top-level: `## N. Title` (e.g. `## 1. Add auth middleware`)
- Subtasks: `## Na. Title` (e.g. `## 1a. Write unit tests`)
- Completed: wrap in `~~` (e.g. `## ~~1. Add auth middleware~~`)

## Iteration Mechanics

Each Ralph iteration:

1. **Read** the plan file
2. **Extract** the first task not wrapped in `~~`
3. **Execute** — invoke the configured agent with task context (see [`wolfpack-context.ts`](../wolfpack-context.ts))
4. **Mark done** — wrap the task header in `~~`
5. **Append** to the progress file (default: `progress.txt`)
6. **Repeat** until all tasks are done or iterations run out

A final cleanup pass identifies and removes dead code after all tasks complete.

Start, monitor, and cancel loops from your phone via the Ralph panel, or from the CLI.
