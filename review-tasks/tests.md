# Review Task: `tests`

## Target
dev
## Baseline
main

## Files to review
- tests/e2e/test-server.ts
- tests/integration/api.test.ts
- tests/integration/auth-middleware.test.ts
- tests/integration/boot-backend.test.ts
- tests/integration/concurrent-pty-viewer.test.ts
- tests/integration/desktop-grid.test.ts
- tests/integration/desktop-terminal.test.ts
- tests/integration/prompt-reconnect.test.ts
- tests/integration/pty-takeover.test.ts
- tests/integration/pty-test-helpers.ts
- tests/integration/rate-limit.test.ts
- tests/integration/take-control.test.ts
- tests/integration/ws-dispatch.test.ts
- tests/unit/backend-router.test.ts
- tests/unit/backend.test.ts
- tests/unit/config-validation.test.ts
- tests/unit/escaping.test.ts
- tests/unit/pty-backend.test.ts
- tests/unit/push.test.ts
- tests/unit/ralph-worktree.test.ts
- tests/unit/ring-buffer.test.ts
- tests/unit/strip-ansi.test.ts
- tests/unit/tailscale-exec.test.ts
- tests/unit/triage.test.ts

## Instructions

1. Read `.context/context.md` — module map, invariants, trust boundaries
2. Read `.context/issues.md` if it exists — cross-reference known issues against the files above
3. Read `.context/tests.md` if it exists — deep per-module context, invariants, call graphs
4. Use the edc-review skill to perform the full review on the files listed above
5. Write your report to `review-tasks/report-tests.md`

DO NOT write your own review methodology.
DO NOT skip reading the context files.
USE the edc-review skill.
