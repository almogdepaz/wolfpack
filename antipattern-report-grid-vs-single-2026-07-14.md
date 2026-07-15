# Grid vs Single Terminal Flow Audit

**Target:** single-terminal and grid terminal browser flows on `dev07` (`6f6abb6`)
**Mode:** full scan of the browser flow; targeted server-side attach trace
**Date:** 2026-07-14
**Scope summary:** 9 browser production/test files read completely (8,071 LOC), plus the relevant server prefill, broker snapshot-render, CSS, history, and generated-client export paths
**Catalog:** [software anti-pattern catalog](file:///Users/home/.pi/agent/skills/antipattern-scan/CATALOG.md)

---

## Executive conclusion

The apparent grid scrollback is **not explained by configured snapshot history**. Current policy does the opposite:

- desktop single mode requests `prefillMode: "full"` and receives up to 500 broker scrollback lines;
- grid requests `prefillMode: "viewport"` and the server explicitly requests `scrollback_lines: 0`;
- both Ghostty terminals still allocate a 2,000-line client-side scrollback buffer.

The credible source of the grid-only visual scroll/scrollback is the attach timing difference. Grid resizes the PTY to cell dimensions, snapshots immediately after a short resize-settle window, then subscribes to post-snapshot output. It does **not** use the output-quiescence barrier used by single/full mode. A SIGWINCH/TUI redraw arriving after the viewport snapshot is therefore live output; Ghostty can visibly paint it and can push rows into its 2,000-line local scrollback buffer. Single/full mode waits for resize output to quiet before taking the snapshot, so the same redraw is generally absorbed into the hidden authoritative prefill.

This is strongly supported by the code path, but the existing tests do not reproduce a real broker-generated post-resize redraw. Treat it as a high-confidence causal hypothesis, not a measured reproduction.

## Behavior matrix

| phase | desktop single | grid | shared? |
|---|---|---|---|
| entry | `openSession` / `switchSession` | `addToGrid` / `renderGridCells` | no |
| controller | `createPtyTerminalController` | same controller | yes |
| terminal buffer capacity | 2,000 lines | 2,000 lines | value duplicated under separate names |
| attach prefill | `full` | `viewport` | same socket client, different policy |
| broker history request | default 500 lines | 0 lines | same renderer, different limit |
| pre-snapshot stabilization | resize settle + output quiescence | short resize settle only | no |
| hydration engine | protocol gate + write/silence gates | same | yes |
| loading-state callbacks | single adapter | grid adapter | duplicated |
| take-control state logic | shared pure functions | shared pure functions | yes |
| take-control orchestration/overlay | single implementation | grid implementation | duplicated |
| reconnect/repaint | shared controller, mode branches around it | shared controller, repeated fan-out | partly |
| teardown/snapshot persistence | single implementation | grid implementation | duplicated |

## What is already unified and should stay unified

- `createTerminalInstance()` — terminal construction, wheel routing, input, and resize forwarding (`public/app.ts:410-575`).
- `createInitialHydrationController()` — hide/reveal, protocol completion, silence, and forced completion (`public/app.ts:607-760`).
- `createPtySocketClient()` — attach protocol, prefill buffering, deadlines, reconnect, and close handling (`public/app.ts:838-1217`).
- `createPtyTerminalController()` — terminal/socket/hydration composition (`public/app.ts:1309-1955`).
- terminal visual-state labels and slow-load indicator (`public/terminal-loading-ui.ts:1-82`).
- pure take-control decisions (`src/take-control-logic.ts`, consumed through `WP`).
- broker snapshot rendering (`src/broker/snapshot-render.ts`).

Do not create separate grid versions of these. The duplication is in the adapters and state transitions around this shared core.

---

## Findings

### HIGH severity

#### 1. Grid live state transitions reimplement their declared canonical source — confidence: HIGH
- **Location:** `public/app-grid.ts:83-91`, `public/app-grid.ts:518-659`, `public/app-grid.ts:742-764`; canonical equivalents in `src/grid-logic.ts:7-85`
- **Snippet:**
  ```ts
  const MAX_GRID_CELLS = 6;
  export function isGridActive() { return state.gridSessions.length >= 2; }
  function gridLayoutClass(count) {
    if (count >= 2 && count <= 6) return "grid-" + count;
  }
  ```
- **Why this matches:** `MAX_GRID_CELLS`, `gridLayoutClass`, active-state detection, add semantics, and remove/focus semantics exist in both files. The pure module calls itself canonical, but live grid add/remove mutate arrays manually. Only preserved-grid paths use `WP.addToGridState()` and `WP.removeFromGridState()`. Unit tests for `src/grid-logic.ts` therefore do not exercise the live production implementation they appear to specify.
- **Why it might be intentional:** DOM/controller disposal must remain imperative around the pure state calculation. That does not require duplicating the calculation itself.
- **Suggested fix:** export the missing pure functions/constants through `src/wolfpack-client-lib.ts`, use them for both live and preserved transitions, and keep controller/DOM side effects around the returned state.
- **Catalog:** Repeating Yourself (WET), Copy-paste Programming, Stovepipe System

#### 2. Full and viewport attach policies have different stabilization contracts — confidence: HIGH
- **Location:** `public/app-grid.ts:151-163`, `public/app.ts:3141-3207`, `src/server/websocket.ts:704-753`, `src/server/websocket.ts:991-1026`, `src/server/broker-backend.ts:595-618`
- **Snippet:**
  ```ts
  if (prefillMode === "viewport") {
    // short resize settle, resize, then snapshot
  } else {
    const settled = await waitForSettledResizeAndOutputQuiescence(...);
  }
  ```
- **Why this matches:** both flows solve the same attach/resize/reveal concern, but grid omits output quiescence. Grid's snapshot asks for zero history, yet late resize redraw bytes are subscribed as live output and can create local client scrollback after the snapshot. This matches the reported grid-only visual behavior better than cached or broker history does.
- **Why it might be intentional:** viewport mode was optimized for low latency, and architecture explicitly permits different prefill strategies. Different payload sizes are intentional; different correctness/reveal boundaries are the risky part.
- **Suggested fix:** define one typed attach policy for each mode and one invariant shared by both: the terminal is not revealed until the initial resize snapshot plus its bounded post-snapshot redraw/replay has settled. Keep `historyLines` different; unify the stabilization/reveal contract.
- **Catalog:** Stovepipe System, Shotgun Surgery

#### 3. The shared terminal runtime is trapped inside a 4,952-line application module — confidence: HIGH
- **Location:** `public/app.ts:410-1955`, `public/app-grid.ts:15-57`
- **Snippet:**
  ```ts
  interface GridDeps {
    showView: ...;
    createPtyTerminalController: ...;
    createConflictOverlay: ...;
    // ...12 injected responsibilities
  }
  ```
- **Why this matches:** the reusable terminal runtime is implemented inside `app.ts`, while `app-grid.ts` uses a broad dependency-injection object to avoid a circular import. This ownership shape encourages adapter duplication and makes grid/single parity changes span both files.
- **Why it might be intentional:** extraction was incremental, and dependency injection avoided a direct cycle without a large refactor.
- **Suggested fix:** move the production terminal runtime and its public types into an importable browser module. Both single and grid should import it directly; `app.ts` should retain app/navigation composition only.
- **Catalog:** God Object/Function, Big Ball of Mud, Stovepipe System

### MEDIUM severity

#### 4. Nine terminal lifecycle callbacks are implemented twice — confidence: HIGH
- **Location:** `public/app-grid.ts:151-263` and `public/app.ts:3196-3311`
- **Snippet:**
  ```ts
  onOpen: ...,
  onPtyReady: ...,
  onViewerConflict: ...,
  onDisconnected: ...,
  onHydrationStart: ...,
  onHydrated: ...,
  ```
- **Why this matches:** about 229 lines independently map the same controller events to repaint, load-state, slow-path, conflict, reconnect, ended, and hydration behavior. History confirms fixes have repeatedly been copied from single to grid (for example the grid `onPtyReady` comment explicitly says it parallels a single-terminal fix).
- **Why it might be intentional:** single mode has connection banners, mobile keyboard work, metrics, and one controller; grid has per-cell focus and ended-state behavior. Those are mode hooks, not reasons to duplicate the common transition table.
- **Suggested fix:** create one production lifecycle presenter that owns common state transitions and accepts only small mode-specific hooks for metrics, focus, banners, and per-cell ended behavior.
- **Catalog:** Repeating Yourself (WET), Copy-paste Programming

#### 5. Active-controller fan-out is repeatedly branched on grid vs single — confidence: HIGH
- **Location:** `public/app-state.ts:102-121`, `public/app.ts:2009-2022`, `public/app.ts:2127-2150`, `public/app.ts:3893-3990`, `public/app.ts:4274-4314`, `public/app.ts:4755-4767`
- **Snippet:**
  ```ts
  if (isGridActive()) {
    for (const gs of state.gridSessions) { ... }
  } else if (state.terminalController?.term) {
    ...
  }
  ```
- **Why this matches:** font updates, snapshot flushing, background reconnect, repaint, input routing, clear, and resize repeatedly discover active controllers independently. There are 22 `isGridActive()` call sites across `app.ts`/`app-grid.ts`, with several identical grid-loop/single-fallback shapes.
- **Why it might be intentional:** focus-sensitive input is genuinely different from all-controller repaint/reconnect operations.
- **Suggested fix:** add a small `activeTerminalBindings()` production helper returning controller/session/machine/focus metadata. Use it for generic fan-out; retain explicit mode logic only where focus or navigation semantics differ.
- **Catalog:** Repeating Yourself (WET), Action at a Distance

#### 6. Viewer-conflict orchestration has drifted despite shared pure state logic — confidence: HIGH
- **Location:** `public/app.ts:3098-3139`, `public/app-grid.ts:332-390`
- **Snippet:**
  ```ts
  // grid only
  gs._takeControlTimer = setTimeout(() => {
    gs.controller.reconnect({ takeControl: true });
  }, 3000);
  ```
- **Why this matches:** both flows use the same `WP.handleViewerConflict`, `handleControlGranted`, and `handleTakeControlClick` decisions, but overlay lifecycle and takeover retry are separate. Grid has a 3-second fallback; single mode does not. Cleanup also differs because grid owns per-cell timers.
- **Why it might be intentional:** grid state is per cell while single state is global. The different storage scope is necessary; the takeover protocol is not.
- **Suggested fix:** extract a per-terminal take-control coordinator parameterized by controller, overlay host, and state storage. Keep one retry/cleanup protocol for both modes.
- **Catalog:** Stovepipe System, Repeating Yourself (WET)

#### 7. Disabled cached-placeholder paths remain wired into both flows — confidence: HIGH
- **Location:** `public/app.ts:3127-3194`, `public/app.ts:3226-3242`, `public/app-grid.ts:140-149`, `public/app-grid.ts:187-203`, `public/app.ts:1531-1540`
- **Snippet:**
  ```ts
  const showCachedPlaceholder = false;
  let _cachedPendingReset = showCachedPlaceholder;
  // ...fallback and onOutput cleanup remain
  ```
- **Why this matches:** cached plaintext is no longer written by `mount()`, single placeholders are hard-disabled, and grid cached data only reasserts the loading state already set before lookup. `_cachedPendingReset`, `_gridCachedPending`, cached mount arguments, placeholder rendering, and fallback cleanup remain as inactive branches in both adapters.
- **Why it might be intentional:** comments preserve a possible future re-enable path. That is a boat anchor; git history already preserves it safely.
- **Suggested fix:** remove disabled rendering plumbing while retaining snapshot persistence. Reintroduce a tested placeholder policy later if product behavior requires it.
- **Catalog:** Boat Anchor, Lava Flow

### LOW severity

#### 8. Terminal surface CSS duplicates the same hide/reveal/loading machinery — confidence: HIGH
- **Location:** `public/styles.css:1297-1361`, `public/styles.css:1439-1469`, `public/styles.css:1499-1563`
- **Snippet:**
  ```css
  #desktop-terminal-container canvas { opacity: 0; visibility: hidden; }
  .grid-cell canvas { opacity: 0; visibility: hidden; }
  ```
- **Why this matches:** canvas defaults, hydration transitions, loading sheen, and reveal selectors are separately defined for single and grid. Behavioral CSS changes require editing both selector families.
- **Why it might be intentional:** grid cells need a header offset and border/focus styling.
- **Suggested fix:** apply a shared terminal-surface class for canvas visibility and loading states; keep only grid header/layout differences mode-specific.
- **Catalog:** Repeating Yourself (WET), Shotgun Surgery

---

## Scrollback-specific evidence

1. `public/app-grid.ts:159` hardcodes `prefillMode: "viewport"`.
2. `src/server/websocket.ts:113` sets `VIEWPORT_PREFILL_SCROLLBACK_LINES = 0`.
3. `src/server/websocket.ts:718-720` passes that zero to `getSessionPrefill()`.
4. `src/server/broker-backend.ts:604` defaults full snapshots to 500 lines.
5. `public/app-state.ts:359-360` gives both client terminals a 2,000-line local buffer.
6. `src/server/websocket.ts:1007-1020` gives viewport mode only resize-settle, while full mode calls `waitForSettledResizeAndOutputQuiescence()`.
7. `tests/e2e/grid.e2e.ts:188-235` verifies cached prose is absent and mocked grid scrollback remains below 10 lines. It does not simulate delayed SIGWINCH redraw/replay after the viewport snapshot.
8. `tests/e2e/session-switch.e2e.ts:104-211` does simulate delayed full-prefill chunks and checks hidden reveal, but there is no equivalent viewport/grid redraw test.

Git history shows policy drift:

- `0e2d337` changed grid from `none` to `viewport`, described as “so cells get history on attach.”
- `e3e5013` later introduced `VIEWPORT_PREFILL_SCROLLBACK_LINES = 0`.
- `1a1898c` removed cached plaintext replay and made desktop single mode always full.

Current tests and code say grid should have no initial broker scrollback. Any observed grid scrollback is therefore post-snapshot client output or a rendering/resize effect, not intended snapshot history.

## Recommended unification order

1. **Use `src/grid-logic.ts` in the live grid path.** Smallest change; removes a false canonical source immediately.
2. **Introduce an active-terminal binding iterator.** Unifies repaint, reconnect, font, resize, clear, and snapshot fan-out without changing mode policy.
3. **Unify lifecycle presentation and take-control orchestration.** Keep explicit hooks for single banners/mobile/metrics and grid focus/cell-ended UI.
4. **Represent attach policy explicitly.** Keep full vs viewport payload size, but decide and test one reveal/stabilization invariant. This is where the reported grid scroll behavior should be addressed.
5. **Extract the terminal runtime from `app.ts`.** Do this after behavior tests exist; otherwise the timing-heavy move is too risky.
6. **Collapse shared terminal-surface CSS and delete disabled cached-placeholder plumbing.** Mechanical cleanup after behavior is stable.

## Cross-mode compatibility check

### Verdict

Do **not** choose one mode wholesale. “Single mode” is itself two profiles: desktop single uses full prefill, while mobile fast single uses the same viewport prefill family as grid. The safe selection unit is one concern at a time.

| concern | can one implementation serve both? | strongest current source | compatibility verdict |
|---|---|---|---|
| terminal/socket/controller runtime | yes | existing shared runtime in `public/app.ts:410-1955` | ready to extract without changing policy |
| grid add/remove/layout state | grid-only concern | `src/grid-logic.ts` | ready; use for live and preserved grid paths |
| `pty_ready` repaint | yes | both implementations now call `forceRepaint()` | ready to centralize |
| loading and slow-path state | yes, with labels/hooks | `public/terminal-loading-ui.ts` plus single’s complete state sequence | ready to centralize common transitions |
| hydration protocol gate | yes | shared controller, with desktop single’s hard completion behavior | mechanism is compatible; viewport redraw regression is missing |
| prefill payload/history | no | explicit mode policy | keep full history for desktop single and zero-history viewport for grid/mobile fast |
| pre-snapshot stabilization | yes as an invariant, not necessarily the same timing budget | full/single server path | adopt bounded output stabilization for grid, but do not copy full payload or worst-case budget blindly |
| missing `prefill_done` handling | not currently | neither | blocked: full closes after 15s; viewport force-completes after 2s |
| reconnect replacement hydration | yes in principle | single/full behavior | blocked: grid manual retry is deliberately tested to skip rehydration |
| viewer conflict/take-control | yes, per controller | grid coordinator + shared pure state machine | grid is stronger: it has bounded retry and timer cleanup; add equivalent single coverage first |
| output-driven recovery snapshots | yes, with identity metadata | single scheduling cadence + grid session identity | single is stronger: grid currently saves on remove/suspend, not periodically during output |
| repaint/reconnect/font/clear fan-out | yes | neither adapter; use shared active-terminal bindings | ready; operation must declare `focused` vs `all` targets |
| input acceptance | common interface, different policy | existing pure grid/default gates | keep focus gating for grid and open-socket gating for single |
| resize scrollback rehydrate | no | current mode-specific behavior | keep full-only; viewport has no authoritative scrollback to reflow |
| teardown/disposal | yes, with collection hooks | controller `dispose()` | common primitive is ready; grid iteration/navigation restoration remains mode-specific |
| cached placeholder behavior | no active behavior exists | neither | remove dead plumbing; there is nothing valid to standardize |
| terminal canvas/loading CSS | yes at base layer | neither exact selector family | share visibility/loading primitives; retain grid header offset and focus border |

### Which existing behavior should win

1. **Use desktop single’s stability contract** for hydration and initial redraw hiding.
   - hard protocol completion before reveal;
   - replacement hydration on authoritative reconnect;
   - output stabilization before declaring initial attach complete.
   - do **not** copy its 500-line payload to every grid cell. Six capped full prefills could send roughly 1.5 MiB before replay (`6 × 256 KiB`).

2. **Use grid’s take-control orchestration** for both modes.
   - state must be per controller, not the single global `_tcState`;
   - retain the 3-second takeover fallback and mandatory timer cleanup;
   - single’s current click path is simpler but less resilient.

3. **Use single’s snapshot cadence, parameterized by terminal identity.**
   - single calls `scheduleSnapshotSave()` on output;
   - grid only persists on remove/suspend because its `onOutput` never schedules a save;
   - a shared output hook should schedule the specific terminal’s snapshot rather than rely on a single global timer/current-session key.

4. **Use `src/grid-logic.ts` for all grid collection transitions.**
   - this does not apply to single mode, but it removes the live/preserved split and makes the tested source real.

5. **Use the existing shared terminal runtime for mechanics.**
   - extraction is preferable to selecting either adapter;
   - mode profiles should provide focus, payload, history, labels, and collection identity.

6. **Use neither cached-placeholder implementation.** Both are disabled residue.

### Items not yet proven safe to unify

1. **Viewport initial redraw completion.** Existing grid tests send a simple mocked snapshot; they do not emit delayed SIGWINCH/TUI redraw after subscribe. This is the reported behavior’s critical missing contract.
2. **Viewport protocol timeout.** `prefill_viewport` replaces the new 15-second close deadline with a 2-second force-flush and calls `onPrefillDone()`. Full and grid therefore do not share the hard completion guarantee.
3. **Grid manual retry.** `shouldRehydrate()` treats `viewport` as “prefill disabled”; unit tests explicitly require manual grid retry not to clear/rehydrate. Copying single replacement behavior would change this contract.
4. **Single takeover fallback.** Grid’s stronger 3-second reconnect fallback has no single-mode browser regression.
5. **Grid periodic snapshot persistence.** Current grid output does not exercise `scheduleSnapshotSave()`; adopting single cadence needs per-session timer/key coverage.

These are blockers to implementation selection, not reasons to keep duplicated adapters indefinitely.

## Required behavior tests before unification

- parameterized browser contract for single/full and grid/viewport:
  - no canvas reveal before protocol completion;
  - no reveal during delayed initial resize redraw/replay;
  - viewer conflict force-finishes hydration;
  - reconnect starts replacement hydration;
  - `pty_ready` forces repaint;
  - missing completion has a bounded, mode-explicit outcome.
- real or realistic viewport attach regression that emits a delayed TUI-style redraw after the snapshot and asserts:
  - no visible scroll-through;
  - no unexpected local scrollback growth from the initial redraw.
- live and preserved add/remove paths must execute the same pure grid transition functions.

## Verification performed

```text
bunx playwright test tests/e2e/grid.e2e.ts tests/e2e/session-switch.e2e.ts
39 passed, 63 skipped across desktop, iPhone SE, and iPhone 14 profiles

bun test --max-concurrency 8 \
  tests/unit/grid-logic.test.ts \
  tests/unit/reconnect-hydration.test.ts \
  tests/unit/take-control-logic.test.ts \
  tests/unit/terminal-buffer.test.ts
125 passed, 0 failed
```

This confirms current encoded behavior and pure state contracts; it does not cover the real-broker post-resize redraw gap described above.
