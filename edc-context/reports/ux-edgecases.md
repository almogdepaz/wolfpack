# UX edgecase review — navigation/back flows

Date: 2026-07-09
Scope: browser client navigation flows in `public/`, focused on Escape/back/cancel paths that can leave the app in a blank or misleading view.

## Found issues

### UX-001 — Escape/cancel from new-session picker opened from expanded desktop sessions can land on an empty terminal

- Severity: high
- Area: `public/app.ts`
- Trigger:
  1. Open a terminal on desktop.
  2. Expand sessions view.
  3. Start `+` new session flow.
  4. Press Escape or click Cancel/back.
- Root cause: entering the project picker clears `state.sessionsExpanded`; returning with `showView("sessions")` redirects to `terminal` because `state.currentSession` is still set, but the terminal controller was destroyed on picker entry.
- Fix: route all project-picker exits through `returnFromProjectPicker()`, which uses `backToSessions()` when the picker was opened from sessions.
- Regression: `tests/e2e/ux-navigation.e2e.ts` — `desktop escape from new-session picker returns to expanded sessions, not an empty terminal`.

### UX-002 — Escape/cancel from new-session picker opened from a desktop terminal can return to an uninitialized terminal

- Severity: high
- Area: `public/app.ts`
- Trigger:
  1. Open a terminal on desktop.
  2. Open new-session picker from terminal/sidebar/Cmd+T path.
  3. Press Escape or click Cancel/back.
- Root cause: `showView("projects")` destroys the active terminal. The previous return path only made `#terminal-view` visible again, without reinitializing the terminal controller/canvas.
- Fix: `returnFromProjectPicker()` detects `viewBeforePicker === "terminal"` and restores the previous terminal session.
- Regression: `tests/e2e/ux-navigation.e2e.ts` — `desktop escape from new-session picker reopens the previous terminal`.

### UX-003 — Escape/back from Ralph launched from a desktop terminal returns to sessions instead of the originating terminal

- Severity: medium
- Area: `public/app-ralph.ts`, `public/app-grid.ts`, `public/app-state.ts`, `public/app.ts`
- Trigger:
  1. Enable Ralph.
  2. Open a terminal on desktop.
  3. Launch Ralph start/detail view from the terminal/sidebar.
  4. Press Escape/back.
- Root cause: `backFromRalph()` only restored preserved desktop grids; single-terminal origin was not tracked, so the fallback always went to sessions.
- Fix: add `state.viewBeforeRalph`, set it when entering Ralph detail/start flows, and make `backFromRalph()` return to the recorded origin. Preserved-grid restore remains first priority.
- Regression: `tests/e2e/ux-navigation.e2e.ts` — `desktop escape from ralph launched from a terminal reopens that terminal`.

## Audited paths with no code change

- Settings opened from a desktop terminal: already returns to and reinitializes the terminal via `returnToTerminalView()`; covered by `desktop settings back from a terminal reopens that terminal`.
- Agent picker Escape/back: returns to project picker and does not destroy a terminal directly; project picker exit is now covered by `returnFromProjectPicker()`.
- Settings opened from sessions: already uses `backFromSettings()` → `backToSessions()`.
- Ralph opened from expanded sessions: with `viewBeforeRalph === "sessions"`, back returns to sessions.
- Preserved desktop grid from Ralph/settings: existing preserved-grid path remains first priority.

## Verification

Fresh after final diff:

- `bun run typecheck` — pass.
- `bunx playwright test tests/e2e/ux-navigation.e2e.ts --project=desktop --timeout=30000 --reporter=line` — 4 passed.
- `bunx playwright test tests/e2e/grid.e2e.ts tests/e2e/ux-navigation.e2e.ts --project=desktop --timeout=30000 --reporter=line` — 17 passed.

Attempted but not final-green:

- `bun run test:e2e -- --reporter=line` — harness timeout at 300s during test 112/150 after the final patch.
- `bun test` — harness timeout at 180s before summary after the final patch. A prior run before the final one-line Ralph self-review patch passed 1543/1543, but that is not counted as final verification.

## Remaining risk

- Mobile swipe-back gestures share some header/back handlers, but this review primarily verified desktop blank-terminal regressions because the reported black-screen reproduction is desktop/new-session related.
- Full manual browser pass on a real phone is still useful for soft-keyboard edge cases; automated coverage here focuses on deterministic desktop navigation regressions.
