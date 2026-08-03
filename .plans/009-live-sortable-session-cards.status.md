# live sortable session cards status

- plan: `.plans/009-live-sortable-session-cards.md`
- overall: `complete`
- current phase: `complete`

## task state

- 1 direct-drag browser tests: `accepted`
- 2 floating card and live placeholder: `accepted`
- 3 keyboard/accessibility migration: `accepted`
- 4 verification: `accepted`

## decisions

- mouse drag starts after movement; touch drag starts after long press.
- interactive controls never initiate ordering.
- one final domain move persists on release; preview movement is DOM-only.
- roots and child sessions move only within their existing hierarchy scope.

## evidence

- failing-first coverage confirmed the old handle interaction lacked direct card drag, live displacement, and alt+arrow card controls.
- full bun suite: 1,470 passed, 0 failed.
- isolated delegation suite: 12 passed, 3 inapplicable skips across iphone se, iphone 14, and desktop.
- navigation regressions covering parent-card click targets and expanded children: 4 passed.
- accessibility and mobile-scroll suites: 27 passed, 6 inapplicable skips, including mobile webkit.
- typecheck and `git diff --check` passed.
- local `broker=no` deployment verified the served bundle hash and preserved 7 sessions with broker pid unchanged.

## next action

review and commit the follow-up interaction changes.
