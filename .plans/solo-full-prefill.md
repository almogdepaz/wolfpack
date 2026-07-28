# solo full prefill

status: implemented, verification has unrelated e2e failures
branch: `fix/solo-full-prefill`

## goal

Solo terminals always request full history, with no user-facing fast/viewport prefill option.

## success criteria

- remove the solo prefill setting from the settings UI and client state.
- solo terminal attach always uses `TERMINAL_PREFILL_MODE.FULL`.
- grid remains `TERMINAL_PREFILL_MODE.VIEWPORT`.
- remove tests that only encode the obsolete setting; add/update behavioral regression coverage.
- regenerate committed browser assets when source changes require it.
- run focused tests, typecheck, and the full suite; report unrelated blockers precisely.

## boundaries

- do not alter broker retention, protocol, or grid prefill behavior.
- do not touch `.plans/terminal-canvas-corruption.md`.
- use test-first workflow and keep the change surgical.

## progress

- [x] add/update failing regression coverage.
- [x] remove solo prefill configuration and force full solo prefill.
- [x] regenerate assets.
- [x] verify focused and full suites.

## verification

- `bun run scripts/gen-assets.ts` — passed.
- `bun run typecheck` — passed.
- `bun test` — passed after removing local untracked `.cache/` that made `taxonomy-ownership.test.ts` traverse a dangling Ghostty symlink.
- `bunx playwright test tests/e2e/session-switch.e2e.ts -g "settings UI does not expose solo prefill mode|mobile created solo session requests full prefill"` — passed.
- `bunx playwright test` — assignment regressions passed; unrelated existing/flaky failures remained:
  - `tests/e2e/session-switch.e2e.ts:129` mobile keyboard native input on iphone-se/iphone-14 sent no frame.
  - `tests/e2e/session-switch.e2e.ts:773` final PTY column ink check failed on iphone-se/iphone-14/desktop.
  - `tests/e2e/grid.e2e.ts:440` debounced grid snapshot persistence timed out on desktop.
