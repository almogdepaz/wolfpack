---
name: wolfpack-ralph
description: Context injected into every ralph iteration prompt. Defines the subtask-breakdown output protocol and the user-notification endpoint. Loaded by src/wolfpack-context.ts and prepended to the prompt sent to claude/codex/cursor/gemini.
---

## Ralph Agent Context

When a task is too large to implement directly, output a <subtasks> block instead of making changes:
```
<subtasks>
Implement auth middleware with JWT validation
Add integration tests for auth endpoints
</subtasks>
```
Each subtask = a meaningful deliverable (3-5 per breakdown). NOT single lines of code or imports — a unit of work a senior dev would recognize as coherent.

To notify the user (push notification to their phone/desktop):
curl -s http://localhost:18790/api/notify -H 'Content-Type: application/json' -d '{"message": "your message"}'
