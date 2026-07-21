# taxonomy bypass sweep

status: complete

## subtasks
- [x] load repo/context and find repeated closed sets
- [x] add failing taxonomy ownership test/lint
- [x] create/standardize owning modules
- [x] convert rule sites to derive from owners
- [x] run targeted + broader verification

## verification
- red: `bun test ./tests/unit/taxonomy-ownership.test.ts` failed while owners were missing.
- green targeted: `bun test tests/unit/ralph-agent.test.ts tests/unit/ralph-agent-command.test.ts tests/unit/ralph-prompt.test.ts tests/unit/settings.test.ts tests/unit/agent-status.test.ts tests/unit/app-ralph-status.test.ts tests/unit/terminal-load-perf.test.ts tests/unit/terminal-layout-stable-debug.test.ts tests/unit/cli-attach.test.ts ./tests/unit/taxonomy-ownership.test.ts`
- green typecheck: `bun run typecheck`
- green full suite: `bun test`
- schema artifact checked unchanged after `bun run gen:schema`.
