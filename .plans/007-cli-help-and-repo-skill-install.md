# fix cli help and document repo-based skill installation

**status:** implemented and verified with plan 006 — review findings 1 and 4 fixed; not deployed, restarted, committed, pushed, or merged
**branch/worktree:** `feat/session-open` in `/private/tmp/wolfpack-dev07`
**goal:** make the agent-native command discoverable without starting the dashboard, and give users an explicit repo-clone + skill-symlink installation path. Skills remain repository files; do not embed or install them from the compiled binary.

## accepted contract

- zero arguments still start the Wolfpack dashboard/server.
- `wolfpack --help`, `wolfpack -h`, and `wolfpack help` print top-level help and exit 0 without starting services.
- `wolfpack session --help`, `wolfpack session -h`, and `wolfpack session help` print session-command help and exit 0 without making API calls.
- `wolfpack session open --help` prints open-specific usage and exits 0 without requiring Wolfpack parent environment variables.
- an unknown top-level command fails with a concise error, points to `wolfpack --help`, exits nonzero, and never starts the dashboard.
- skill installation is documented from a cloned Wolfpack repository using symlinks or explicit copies into supported agent skill roots.
- do not add binary-embedded skill assets, a binary skill installer, network downloads, or automatic overwrites of user skill directories.

## 1. add failing cli behavior regressions

- Add subprocess-level tests against the real TypeScript CLI entrypoint proving all help aliases exit 0, include `wolfpack session open`, and do not print/start the dashboard.
- Prove `wolfpack session open --help` does not require `WOLFPACK_SESSION_NAME` or `WOLFPACK_AGENT_KIND` and performs no HTTP request.
- Add a regression proving an unknown command exits nonzero and does not fall through to `start()`.
- Preserve the existing zero-argument behavior. Test it at the smallest boundary that avoids launching a persistent server; extract a pure dispatcher decision only if needed.
- Run the new tests before production changes and record the expected failures.

## 2. implement minimal side-effect-free help dispatch

- Add one canonical top-level usage renderer covering setup, service, doctor, list, session, kill, attach, uninstall, migrate-plan, and worker commands.
- Add one canonical session usage renderer covering open, read, send, wait, and current-context, with open-specific usage.
- Handle help before any server/dashboard startup or parent-context/API validation.
- Change the top-level fallback so only an absent command calls `start()`; unknown commands return a usage error.
- Avoid a broad CLI refactor. Keep current command behavior and exit-code conventions unless the new help/error contract requires a minimal change.

## 3. document installation from the repository

- Update the README agent-skills section and `docs/agent-skills.md` with an explicit workflow:
  1. clone or update `https://github.com/almogdepaz/wolfpack`;
  2. review the requested `skills/<name>/SKILL.md` because skills are executable agent instructions;
  3. symlink the desired skill directory from the clone into a supported skill root;
  4. start a fresh agent context so descriptions are rescanned.
- Document concrete roots relevant to this project:
  - Pi global: `~/.pi/agent/skills/`
  - shared Agent Skills root supported by Pi: `~/.agents/skills/`
  - Claude global where used: `~/.claude/skills/`
- Prefer symlinks so `git pull` updates the skill source. Explain copying as an alternative that must be refreshed manually.
- Commands must fail safely when a destination already exists; do not recommend destructive `rm`, forced replacement, or overwriting user-modified skills.
- Show the `wolfpack-tailnet-control` installation example and the canonical natural-language/CLI sub-agent invocation.
- State explicitly that platform binaries do not install skills and that this is intentional: the repository is the auditable source of truth.

## 4. verify and stop

- Run focused CLI help/import/session-control and agent-skill documentation tests.
- Run typecheck and `git diff --check`.
- Re-run the full verification required by plan 006 if these changes land before its final verification; otherwise run the full Bun suite at minimum and report what remains.
- Update this plan status and provide exact changed files and command evidence.
- Do not deploy, restart services, commit, push, merge, or modify unrelated worktrees.

## execution record

- observed 9 expected subprocess failures before production changes: three top-level aliases, three session aliases, open help, unknown command, and zero-argument dispatch.
- observed the expected repository-skill documentation regression before documentation changes.
- added canonical top-level/session/open help dispatch before service startup, parent-context validation, and API access; only zero arguments select dashboard startup.
- documented audited clone/update, fail-closed symlink/copy installation, supported roots, fresh-context rescan, invocation, and the intentional no-binary-installer boundary.
- focused plan 007 suite: 48 passed; final combined focused suite with fixture signing disabled: 283 passed.
- combined full Bun suite: 1749 passed; Rust: 174 passed; Playwright: 86 passed with 109 platform-applicability skips.
- root/browser typechecks, deterministic generation, four-target production build, compiled-binary help smoke, package/asset diff checks, and `git diff --check` passed.
- review finding 1: the standalone copy fence now defines `REPO`, `SOURCE`, `DEST_ROOT`, and `DEST` before its fail-closed guard; regression observed red, then 7 agent-skill tests passed.
- review finding 1 follow-up: the copy fence now creates `DEST_ROOT` before the guard; regression observed red, then 7 agent-skill tests with 69 assertions passed.
- review finding 4: both executable install fences reject a missing source before creating the destination root. A real `/bin/bash` regression extracts each fence and proves fresh install, non-overwriting rerun, and missing-source behavior; observed red on the dangling-symlink path, then 7 tests with 81 assertions passed.

## success criteria

- an agent running `wolfpack --help` immediately discovers `wolfpack session open` and cannot mistake the binary for server-only;
- help commands are side-effect free;
- unknown commands no longer start the dashboard;
- users can install the audited skill directly from the repository with a safe, concrete symlink workflow;
- no skill content is embedded in or installed by the binary;
- existing session-open implementation and unrelated dirty files remain intact.
