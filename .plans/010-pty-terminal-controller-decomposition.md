# plan — pty terminal controller decomposition

## status

proposed. this is an immutable implementation plan; `.plans/010-pty-terminal-controller-decomposition.status.md` is the mutable execution ledger.

## goal lock

reduce `createPtyTerminalController` in `public/app.ts` without changing the terminal wire protocol or user-visible terminal behavior.

success means lifecycle, layout/resize, and hydration/reconnect ownership are understandable and independently testable. it does **not** mean rewriting the browser terminal stack.

## evidence and current state

- #232 identified four independent findings.
- #234 (`45040cd`) already removed the two dead delegation-grid exports, extracted initial hydration, replaced the then-known browser-test mirrors with production imports, and introduced `public/tsconfig.strict.json`.
- current `createPtyTerminalController` is `public/app.ts:1435-2152` (718 lines) and still owns terminal mounting, scroll-lock event wiring, layout/resize/reconnect, hydration transitions, socket callbacks, and disposal.
- `tests/unit/reconnect-hydration.test.ts:77-209` still simulates controller-owned rehydration effects rather than exercising a production seam.
- `bunx tsc -p public/tsconfig.strict.json --noEmit` is currently clean; this plan must preserve that migration gate, not make all legacy browser files strict in one change.

## invariants

- broker remains the sole PTY and terminal-state authority. do not change broker RPCs, websocket frames, attach ordering, prefill modes, replay handling, or take-control semantics.
- snapshot-to-live continuity must retain the existing reset, prefill, and reconnect behavior.
- full-prefill resize rehydration remains gated by `TERMINAL_PREFILL_MODE.FULL`, an open PTY client, non-transient sidebar layout, and user-requested scrollback.
- dispose invalidates stale callbacks, closes the client, cancels hydration/timers/observers, unregisters listeners, and disposes the terminal exactly as today.
- do not create a generic frontend framework, an event bus, or a new browser state store. extract only cohesive production ownership.

## sequence

### 1. characterize the controller boundary before moving code

- record current public controller surface and all callers: desktop (`initTerminal`) and grid (`public/app-grid.ts`).
- identify the production seams that own:
  1. layout/resize and scroll-position preservation;
  2. hydration/replacement-prefill transitions;
  3. terminal mount/listener cleanup and socket lifecycle.
- write focused behavioral tests at those seams before moving production code. remove only tests that mirror the production implementation; retain end-to-end browser coverage for actual attach/reconnect behavior.

acceptance:
- no caller contract change for the desktop or grid controller;
- every extracted decision has a production import in its test;
- baseline tests name the preserved behavior rather than internal variables.

### 2. extract layout and resize ownership first

- move fit-preserving-scroll, forced repaint, layout sync scheduling, resize observer ownership, and full-prefill resize-rehydrate scheduling into one cohesive production module.
- pass narrow terminal/client accessors or explicit callbacks; do not export mutable controller internals.
- retain the controller as the coordinator and preserve grid-specific `canSendResize` behavior.

acceptance:
- resize, sidebar/layout-transition suppression, scrollback restoration, and reconnect triggers preserve existing behavior;
- focused unit coverage imports the extracted production decisions;
- no broker/server protocol changes.

### 3. extract hydration and websocket lifecycle ownership

- compose the existing `createInitialHydrationController` with the socket lifecycle in a cohesive production owner.
- move reconnect reset, replacement-prefill activation, `prefill_done`, binary-data buffering, and stale-client/epoch guards together where their ordering is explicit.
- replace `simulateRehydration` in `tests/unit/reconnect-hydration.test.ts` with assertions against the extracted production transition/owner.

acceptance:
- first connect, ordinary reconnect, manual retry, takeover, empty prefill, and dispose-during-callback retain their current outcomes;
- tests invoke production behavior rather than a test-local action recorder;
- the outer controller is orchestration only and no longer owns all lifecycle, layout, and hydration branches.

### 4. finish mount and disposal cohesion without broad UI changes

- leave feature-specific UI behavior (scroll lock, keyboard bridge, browser shortcuts) close to terminal mounting unless it has a real independent owner.
- make listener/timer/observer cleanup ownership explicit and preserve existing cancellation order.
- do not refactor machine discovery, session UI, grid presentation, or Ghostty internals as part of this issue.

acceptance:
- mount/dispose has one clear cleanup owner;
- no leaked listeners, timers, observers, or stale websocket callbacks in focused tests;
- no unrelated formatting or public API churn.

### 5. verify browser behavior and strict migration preservation

run, in order:

1. focused unit tests for the extracted owners and `tests/unit/reconnect-hydration.test.ts`;
2. `bun run typecheck`;
3. targeted terminal lifecycle and grid browser tests covering attach, reconnect, full-prefill resize, and takeover;
4. the full suite when its known external blockers are resolved or separately documented.

acceptance:
- browser strict migration gate remains clean;
- desktop and grid consumers retain terminal attach/reconnect behavior;
- any Ghostty rendering failure is treated as a release blocker, not papered over with retry/silenced exceptions.

## out of scope

- making every legacy browser file strict;
- protocol or broker changes;
- changing prefill timing or Ghostty rendering workarounds absent a reproducing regression;
- session-grid visual changes;
- authentication, peer discovery, or mobile-control roadmap work.

## rollback

keep each extraction behavior-preserving and independently revertible. if browser attach, resize, or reconnect regressions appear, revert the current extraction rather than adding compatibility branches to the controller.
