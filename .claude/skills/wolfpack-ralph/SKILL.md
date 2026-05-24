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

## Srt Sandbox and Local Sockets

Default Ralph srt is intentionally restrictive. Do not plan default-srt work that requires starting local listeners unless the plan explicitly includes a host/non-srt verification phase.

Known default-srt blockers:
- Unix domain socket bind/listen, including starting `wolfpack-broker` inside srt.
- Localhost TCP bind/listen unless a socket-capable profile explicitly enables local binding.
- Broker-backed perf/integration tests that spawn their own broker process.

Preferred handling:
- Normal Ralph tasks must not access Wolfpack's host broker socket from inside srt; broker socket access is equivalent to host PTY control.
- For broker startup tests, perf harnesses, browser/dev servers, or anything that must bind/listen locally, run that step with `--sandbox false` or ask for an explicit socket-capable srt profile.
- Do not enable `allowAllUnixSockets` in default Ralph runs. If a task truly needs Unix sockets inside srt, scope `network.allowUnixSockets` to the exact socket path/dir and ensure the socket directory is writable only when bind/listen is required.
