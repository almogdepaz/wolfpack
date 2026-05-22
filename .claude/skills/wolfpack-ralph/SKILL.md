---
name: wolfpack-ralph
description: Context injected into every ralph iteration prompt. Defines the structured response expectations and user-notification endpoint. Loaded by src/wolfpack-context.ts and prepended to the prompt sent to claude/codex/cursor/gemini.
---

## Ralph Agent Context

Before exiting, write the structured JSON response file requested by the runner prompt. The response file is the ONLY runner control channel for every supported agent; do not emit XML-ish control tags in stdout.

When a task is too large to implement directly, do not make code changes. Write a response with `"status": "needs_subtasks"` and `"subtasks"` as an array of meaningful deliverables:
```json
{
  "version": 1,
  "status": "needs_subtasks",
  "prereqs": ["assumption or prerequisite"],
  "tests": ["test command or planned test"],
  "done": ["completion criterion"],
  "subtasks": [
    "Implement auth middleware with JWT validation",
    "Add integration tests for auth endpoints"
  ]
}
```
Each subtask = a meaningful deliverable (3-5 per breakdown). NOT single lines of code or imports — a unit of work a senior dev would recognize as coherent.

To notify the user (push notification to their phone/desktop):
curl -s http://localhost:18790/api/notify -H 'Content-Type: application/json' -d '{"message": "your message"}'
