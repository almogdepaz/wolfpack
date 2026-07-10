# ux edgecase review

status: verified with caveats

## goal
find and fix browser ux edge cases where navigation/actions leave the app in a broken or confusing state, including the known escape-key black screen in create-new-session flow.

## scope
- browser client flows in `public/`
- pure helper seams in `src/` when browser behavior depends on them
- tests for each confirmed fix where practical
- report of all confirmed issues and fixes

## findings
- ux-001: escape/cancel from project picker opened from expanded desktop sessions could land on destroyed/empty terminal.
- ux-002: escape/cancel from project picker opened from an active desktop terminal could show terminal view without reinitializing its canvas/controller.
- ux-003: escape/back from ralph launched from a desktop terminal fell back to sessions instead of originating terminal.
- audited no-change: settings-from-terminal already restores terminal; agent picker relies on fixed project-picker exit; preserved-grid ralph/settings path remains first-priority.

## changed
- `public/app.ts`: added common project-picker return helper; wired escape/cancel/header back; mobile ralph header now delegates to `backFromRalph`.
- `public/app-ralph.ts`: records `state.viewBeforeRalph` when entering ralph detail/new-start flows.
- `public/app-grid.ts`: ralph back now returns to recorded origin, preserving existing grid restore priority.
- `public/app-state.ts`: added `viewBeforeRalph` state.
- `tests/e2e/ux-navigation.e2e.ts`: added desktop regressions for project picker, settings, and ralph navigation.
- `src/public-assets.ts`: regenerated embedded browser assets.
- `edc-context/reports/ux-edgecases.md`: report of findings.

## verification
- red: project picker from expanded sessions failed before fix (`body` lost `sessions-expanded`).
- red: project picker from terminal failed before fix (terminal view visible but no canvas).
- red: ralph from terminal failed before fix (terminal view not visible after Escape).
- green: `bun run typecheck`.
- green: `bunx playwright test tests/e2e/ux-navigation.e2e.ts --project=desktop --timeout=30000 --reporter=line` — 4 passed.
- green: `bunx playwright test tests/e2e/grid.e2e.ts tests/e2e/ux-navigation.e2e.ts --project=desktop --timeout=30000 --reporter=line` — 17 passed.
- not final-green: `bun run test:e2e -- --reporter=line` timed out at 300s during test 112/150 after final patch.
- not final-green: `bun test` timed out at 180s before summary after final patch. prior run before the final one-line ralph self-review patch passed 1543/1543, but not counted as final verification.
