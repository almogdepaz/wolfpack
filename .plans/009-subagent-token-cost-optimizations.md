# subagent token-cost optimizations

## 1. Regression tests
- status: red observed
- goal: cover compact `--plan`, safe `--prompt-file`, and child notification cli behavior.
- evidence: `bun test tests/unit/session-control-fast-path.test.ts` failed before implementation on missing parse/support paths; prompt-file test also had a raw-newline fixture bug to fix.

## 2. CLI implementation
- status: complete
- goal: generate compact prompts locally and avoid parent-authored long prompts/heredocs.
- evidence: focused unit suite passes after implementation.

## 3. Docs/skill updates
- status: complete
- goal: steer agents to `wolfpack agent spawn --plan ... --notify-parent` and away from verbose prompts.

## 4. Verification
- status: complete
- goal: run focused tests and typecheck for touched code.
- focused tests: `bun test tests/unit/session-control-fast-path.test.ts tests/unit/session-control.test.ts tests/unit/cli-help.test.ts tests/unit/agent-skills.test.ts` => 50 pass, 0 fail.
- typecheck: `bun run typecheck` => pass.
- full suite: `bun test` => 1777 pass, 21 skip, 0 fail.
