# pi extension and skills setup

status: implemented — verification complete
base: main @ ed49315

**goal**

when setup detects pi on `PATH`, offer one explicit opt-in that installs wolfpack session-control skills plus structured pi task delegation. users without pi must not see the offer.

**assumptions**

- one default-no prompt covers the complete pi subagent integration
- acceptance invokes pi's package manager in dependency order:
  1. `pi install npm:wolfpack-bridge` for wolfpack-owned skills
  2. `pi install npm:@sgtbeatdown/pi-tasks` for `agent_task_*` and `wolfpack-pi-task-delegation`
- the second install runs only if the first succeeds
- non-interactive setup installs nothing and prints the commands only when pi exists
- wolfpack does not edit pi settings or copy skill files directly

**success criteria**

- [x] non-pi users receive no pi integration prompt or guidance
- [x] pi users receive a concise ownership explanation and default-no install prompt
- [x] acceptance invokes both canonical package installs in order
- [x] decline changes nothing
- [x] first-package failure prevents extension installation
- [x] failures show the exact retry command without aborting core setup
- [x] README and `docs/agent-skills.md` explain the extension/skill roles and opt-in behavior
- [x] focused tests, typecheck, full tests, package dry-run, and diff checks pass

## ~~1. Add pi integration behavior tests~~

add focused tests for PATH detection, interactive/non-interactive offer selection, ordered real subprocess arguments, and fail-closed sequencing.

## ~~2. Implement and wire the opt-in setup flow~~

add a small cli helper around canonical argv-based `pi install`, then call it from setup only when pi is detected.

## ~~3. Document extension and skill ownership~~

update README and `docs/agent-skills.md` with the exact package commands, ownership boundaries, opt-in behavior, and manual audited alternative.

## ~~4. Verify the complete change~~

run focused tests, typecheck, full `bun test`, `npm pack --dry-run --json`, and `git diff --check`; record fresh evidence here.

**out of scope**

- pi installation
- direct pi settings mutation
- non-pi harness skill installation
- pi package uninstall/update management

**status log**

- 2026-07-26: switched to clean main after stashing prior `dev_new` work as `stash@{0}`.
- 2026-07-26: inspected main setup, skill docs/tests, pi package/skill documentation, and the `@sgtbeatdown/pi-tasks` manifest.
- 2026-07-26 red: `bun test tests/unit/pi-integration-setup.test.ts` failed because `src/cli/pi-integration.ts` did not exist.
- 2026-07-26 green: focused setup/docs suite passed, 14 tests and 109 assertions.
- 2026-07-26 typecheck: `bun run typecheck` passed.
- 2026-07-26 full suite: `bun test` passed, 1922 tests across 127 files, 0 failures after rebasing onto current main.
- 2026-07-26 package: `npm pack --dry-run --json` included all three Wolfpack skill files and updated docs.
- 2026-07-26 real Pi package smoke: isolated temporary HOME installed both npm sources successfully; `pi list` showed both packages and filesystem checks found `wolfpack-tailnet-control`, the Pi Tasks extension, and `wolfpack-pi-task-delegation`.
- 2026-07-26 hygiene: `git diff --check` passed.
- 2026-07-26: fast-forwarded/rebased onto current `origin/main` at `ed49315` and branched as `feat/pi-integration-setup`.
- 2026-07-26 post-rebase verification: full suite, typecheck, package dry-run, and diff hygiene all passed.
