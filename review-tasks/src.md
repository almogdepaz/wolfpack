# Review Task: `src`

## Target
dev
## Baseline
main

## Files to review
- src/auth.ts
- src/cli/config.ts
- src/cli/index.ts
- src/cli/service.ts
- src/cli/setup.ts
- src/log.ts
- src/public-assets.ts
- src/server/backend.ts
- src/server/http.ts
- src/server/index.ts
- src/server/mock-backend.ts
- src/server/pty-backend.ts
- src/server/push.ts
- src/server/ring-buffer.ts
- src/server/routes.ts
- src/server/tmux-backend.ts
- src/server/tmux.ts
- src/server/websocket.ts
- src/test-hooks.ts
- src/triage.ts
- src/wolfpack-context.ts
- src/worktree.ts

## Instructions

1. Read `.context/context.md` — module map, invariants, trust boundaries
2. Read `.context/issues.md` if it exists — cross-reference known issues against the files above
3. Read `.context/src.md` if it exists — deep per-module context, invariants, call graphs
4. Use the edc-review skill to perform the full review on the files listed above
5. Write your report to `review-tasks/report-src.md`

DO NOT write your own review methodology.
DO NOT skip reading the context files.
USE the edc-review skill.
