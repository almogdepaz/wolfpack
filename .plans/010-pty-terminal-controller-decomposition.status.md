# status — pty terminal controller decomposition

- immutable plan: `.plans/010-pty-terminal-controller-decomposition.md`
- sha256: `cf543fbe6ee50476dbc06c71825fed764e62f3ee5ccbeda853a253d865f6ea23`
- overall state: `review_required`
- current phase: scoped decomposition complete; mount/disposal extraction deliberately deferred

## goal lock

- direct contribution: resolve #232's remaining terminal-controller maintainability debt without behavioral change
- source of truth: immutable plan, existing browser attach/reconnect behavior, and broker terminal-state invariants
- preserved boundaries: broker PTY authority, websocket attach/prefill protocol, grid/desktop controller surface, and existing strict migration gate
- non-goal check: no framework, protocol migration, broad strictness conversion, or adjacent UI refactor

## task states

| task | state | evidence / next action |
| --- | --- | --- |
| 1. characterize controller seams | `implemented` | desktop and grid callers mapped; production rehydration seam is covered by direct unit tests |
| 2. extract layout and resize ownership | `implemented` | `public/terminal-layout.ts` and `public/terminal-resize-lifecycle.ts` own fit/repaint/sync, debounce, observer, and cleanup |
| 3. extract hydration and websocket lifecycle ownership | `implemented` | replacement-prefill transitions and stale hydration-write callbacks have tested production owners |
| 4. finish mount/disposal cohesion | `cancelled` | user selected the scoped stop rather than a large mutable context object or new mount owner |
| 5. verify browser behavior and strict gate | `review_required` | focused unit/typecheck/e2e evidence is recorded; full-suite scope remains unrun |

## completed prior work

- #234 (`45040cd`) removed #232's dead delegation-grid exports.
- #234 extracted initial hydration, replaced the then-known browser-test mirrors with production imports, and added the incremental strict browser typecheck gate.
- the original review identified a 718-line controller at `public/app.ts:1435-2152` before this plan's first extractions.
- task 1 replaced the test-local rehydration action simulation with `src/terminal-rehydration.ts`, used by `public/app.ts` and directly covered by `tests/unit/terminal-rehydration.test.ts`.

## verification

- red: `bun test tests/unit/terminal-rehydration.test.ts` failed because the production module did not exist.
- green: `bun test tests/unit/terminal-layout.test.ts tests/unit/terminal-rehydration.test.ts tests/unit/reconnect-hydration.test.ts` — 10 passed.
- green: `bun run typecheck`.
- green: `bunx playwright test tests/e2e/terminal-lifecycle.e2e.ts` — 5 desktop passed, 10 mobile projects skipped by the existing test configuration.
- green: `bunx tsc --noEmit -p public/tsconfig.strict.json` after adding `public/terminal-layout.ts` and `public/terminal-resize-lifecycle.ts`.
- red then green: resize-lifecycle unit test initially failed because the production module did not exist; its two focused cases now pass.
- red then green: replacement-prefill lifecycle test initially failed because the production module did not exist; its three focused cases now pass.
- green: `bunx playwright test tests/e2e/terminal-lifecycle.e2e.ts` after task 3 wiring — 5 desktop passed, 10 mobile projects skipped by existing configuration.

## decisions

- task 2 moves fit-preserving-scroll, forced repaint, and resize forwarding into `public/terminal-layout.ts`, then moves resize debounce, observer lifecycle, pending scroll restoration, and cleanup into `public/terminal-resize-lifecycle.ts`.

## deferred work

- mount/disposal remains in the controller. extracting it now would require either a large mutable context object or a separately designed terminal-mount owner; user chose not to take that risk in this issue.

## blockers

- physical browser verification must cover Ghostty-sensitive attach, reconnect, resize, and takeover paths; unit tests alone cannot prove rendering continuity.

## changed files

- `.plans/010-pty-terminal-controller-decomposition.md`: immutable plan.
- `.plans/010-pty-terminal-controller-decomposition.status.md`: execution ledger.
- `src/terminal-rehydration.ts`: production rehydration-action decision.
- `tests/unit/terminal-rehydration.test.ts`: direct production-decision coverage.
- `tests/unit/reconnect-hydration.test.ts`: removed test-local action simulation.
- `public/app.ts`: consumes the production rehydration action and delegates fit/repaint/resize forwarding.
- `public/terminal-layout.ts`: typed layout operations with direct unit coverage.
- `public/tsconfig.strict.json`: adds the new typed browser module to the strict migration gate.
- `tests/unit/terminal-layout.test.ts`: direct fit/resize production coverage.
- `public/terminal-resize-lifecycle.ts`: observer/debounce/reconnect ownership.
- `tests/unit/terminal-resize-lifecycle.test.ts`: direct observer and debounced-reconnect coverage.
- `src/replacement-prefill-lifecycle.ts`: replacement-prefill transition ownership.
- `tests/unit/replacement-prefill-lifecycle.test.ts`: direct reconnect, empty-prefill, and takeover coverage.
- `src/hydration-write-tracker.ts`: connection-epoch and hydration-write completion ownership.
- `tests/unit/hydration-write-tracker.test.ts`: direct active/stale callback coverage.

## next action

review the scoped refactor. keep #232 open for any future deliberately designed terminal-mount owner rather than adding a mutable context object now.
