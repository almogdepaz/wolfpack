# terminal loading message polish — 2026-07-20

status: implemented

## goal

make terminal loading/status labels less technical without changing terminal state transitions, reveal timing, socket behavior, or animation behavior.

## scope

- copy-only polish in `public/terminal-loading-ui.ts`
- expose `terminalLoadLabelFor()` for a small unit-level copy contract
- regenerate embedded assets

## out of scope

- no loading/reveal timing changes
- no state machine changes
- no css animation changes
- no take-control behavior changes

## verification

- red: `bun test tests/unit/terminal-loading-ui.test.ts` failed because `terminalLoadLabelFor` was missing
- green: `bun test tests/unit/terminal-loading-ui.test.ts tests/unit/ghostty-prewarm-pool.test.ts tests/unit/terminal-load-perf.test.ts` passed, 14 tests
- green: `bun run typecheck` passed
- green: `git diff --check` passed
- green: server-only deploy with `./scripts/deploy-local.sh --broker=no`
- green: browser smoke observed `prefill-loading` label as `loading terminal`, final grid cells `live`, no console errors or failed requests
