---
name: wolfpack-plan
description: Context injected into interactive claude sessions via --append-system-prompt. Defines the plan-file header conventions the task extractor recognizes. Loaded by src/wolfpack-context.ts.
---

## Wolfpack Plan Conventions

Plan task headers MUST use: `## N. Title` (e.g. `## 1. Add auth`), subtasks: `## Na. Title` (e.g. `## 1a. Tests`). Completed: wrap in `~~` (e.g. `## ~~1. Done~~`). No other header styles — the task extractor only recognizes this pattern.

Each task = a meaningful deliverable (3-5 per feature). NOT individual lines of code — a unit of work a senior dev would recognize. Subtask breakdowns follow the same rule: 3-5 max, each coherent.
