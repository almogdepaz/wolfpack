# review/audit fix status

## goal
address EDC review follow-ups from `review-HEAD.md`:
1. restore Ralph structured response/control-channel behavior and regression tests
2. restore transient git excludes and prompt/docs coverage
3. restore Codex+srt sandbox allowances and socket-denial diagnostics/tests
4. restore Ralph opt-in and srt/socket docs; correct skill runtime-injection claim
5. cover reconnect banner behavior separately from fast broker reconnect recovery tests

## progress
- [x] inspect history/context
- [x] add/restore coverage for Ralph response, sandbox, git-exclude, prompt, broker diagnostic
- [x] implement Ralph structured response, transient excludes, Codex+srt, docs/skill fixes
- [x] add deterministic reconnect-banner e2e coverage
- [x] run verification
- [ ] commit and push

## evidence
- review run succeeded with final report `review-HEAD.md`.
- current branch: `pr-149`.
- red observed: `bun test tests/unit/ralph-sandbox.test.ts` failed because git metadata dirs were absent from `buildSrtSettings().filesystem.allowWrite`.
- targeted green: `bun test tests/unit/ralph-control.test.ts tests/unit/plan-parsing.test.ts tests/unit/ralph-sandbox.test.ts tests/unit/deploy-local.test.ts tests/integration/pty-takeover.test.ts` — 128 pass, 0 fail.
- deterministic reconnect-banner test initially failed because stalling Playwright's routed websocket still opened the browser-side socket and hid the banner; switched reproduction to a browser network outage.
- green: `bunx tsc --noEmit -p .`
- green: `bunx tsc --noEmit -p public/`
- green: `bun test tests/unit/ralph-response.test.ts tests/unit/ralph-agent-command.test.ts tests/unit/ralph-prompt.test.ts tests/unit/ralph-git-exclude.test.ts tests/unit/ralph-sandbox.test.ts tests/unit/ralph-worker-response.test.ts` — 42 pass, 0 fail.
- green: `cargo test --manifest-path broker/Cargo.toml --bin wolfpack-broker` — 3 pass, 0 fail.
- green: `bunx playwright test tests/e2e/reconnect.e2e.ts --grep "network outage|shows reconnecting banner"` — 4 pass, 2 skipped.
- green: `bun test` — 1515 pass, 0 fail.
- green: `cargo test --manifest-path broker/Cargo.toml` — 164 pass, 0 fail across lib/bin/integration/fixtures, 0 doctests.
- green: `git diff --check && git diff --cached --check`.
