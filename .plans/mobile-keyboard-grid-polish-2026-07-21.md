# mobile keyboard/grid polish — 2026-07-21

status: ready for pr
branch: fix/mobile-keyboard-grid-polish
base: main d5643cb

## goals
- fix mobile keyboard accessory/proxy disappearing behavior with a regression test.
- include existing red→green fixes for mobile session swipe peek, mobile autocomplete replacement commits, and grid add flicker.
- open one pr.

## checklist
- [x] reproduce keyboard accessory bug red
- [x] implement minimal keyboard fix
- [x] port mobile swipe peek fix/tests
- [x] port mobile autocomplete replacement fix/tests
- [x] port grid add flicker fix/tests
- [x] regenerate browser assets
- [x] run targeted tests/typecheck/diff check

## verification
- `bun run typecheck` — pass
- `bun test tests/unit/desktop-terminal-logic.test.ts tests/unit/kb-accessory-layout.test.ts` — pass
- `bunx playwright test tests/e2e/session-switch.e2e.ts --project=iphone-14 --grep "keyboard viewport shift|mobile card swipe peek|mobile touch scrolling"` — pass
- `bunx playwright test tests/e2e/grid.e2e.ts --project=desktop --grep "addToGrid|grid topology add|forceRepaint"` — pass
- `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test` — pass
- `bunx playwright test` — pass
- follow-up suffix-only autocomplete regression: red `bun test tests/unit/desktop-terminal-logic.test.ts`, then green after fix
- follow-up mobile e2e slice: `bunx playwright test tests/e2e/session-switch.e2e.ts --project=iphone-14 --grep "keyboard viewport shift|mobile card swipe peek|mobile touch scrolling"` — pass
- review finding fix red: `bunx playwright test tests/e2e/session-switch.e2e.ts --project=iphone-14 --grep "autocomplete replacement"` failed with `Received: "tehthe"`
- review finding fix green: `bun scripts/gen-assets.ts && bunx playwright test tests/e2e/session-switch.e2e.ts --project=iphone-14 --grep "autocomplete replacement|keyboard viewport shift|mobile card swipe peek|mobile touch scrolling" && bun test tests/unit/desktop-terminal-logic.test.ts && bun run typecheck && git diff --check` — pass
- live mobile correction follow-up red: `teh` + fragment `he` unit test failed with `Received: "he"`
- live mobile correction follow-up green: `bun test tests/unit/desktop-terminal-logic.test.ts && bun scripts/gen-assets.ts && bunx playwright test tests/e2e/session-switch.e2e.ts --project=iphone-14 --grep "autocomplete replacement|keyboard viewport shift|mobile card swipe peek|mobile touch scrolling" && bun run typecheck && git diff --check` — pass
- sequential single-char correction red: e2e emitted `t`,`e`,`h`,`h`,`e` and failed with `Received: "tehhe"`
- sequential single-char correction green: `bun test tests/unit/desktop-terminal-logic.test.ts && bun scripts/gen-assets.ts && bunx playwright test tests/e2e/session-switch.e2e.ts --project=iphone-14 --grep "autocomplete replacement|keyboard viewport shift|mobile card swipe peek|mobile touch scrolling" && bun run typecheck && git diff --check` — pass
