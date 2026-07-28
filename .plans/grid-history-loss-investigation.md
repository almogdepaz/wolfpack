# grid history loss investigation

status: completed
branch: `investigate/grid-history-loss`

## goal

Determine why a grid terminal can appear to lose history until a resize restores it.

## boundaries

- reproduce before changing production code.
- distinguish broker scrollback loss from browser hydration/render/viewport loss.
- do not ship resize/repaint workarounds.

## findings

- grid mounts the same Ghostty `Terminal` wrapper as solo mode, with an isolated WASM instance per cell, `scrollback: GRID_TERMINAL_SCROLLBACK`, and viewport-only broker prefill. It does not have a separate renderer or snapshot-replay implementation.
- the broker asks for a bounded viewport snapshot for grid and emits `prefill_viewport`, `prefill_done`, then `pty_ready`; no evidence points to broker eviction or an attach/replay race.
- the shipped Ghostty 0.4.0 wrapper calls `wasmTerm.update()` twice per normal render: once in the renderer and again through `getViewport()`. This corrupts/replaces browser-side scrollback under sustained writes before its 10,000-line configured limit.
- deterministic browser regression: fourteen 68-line ANSI batches in a 130x39 terminal drop browser scrollback at batch 11 (`641 -> 345`) on this branch. The test reaches Ghostty directly, so the broker, websocket, grid state, hydration, and browser resize machinery are excluded.
- the existing `fix/terminal-rendering` Ghostty vendored patch makes `getViewport(refreshRenderState)` perform exactly one coherent render-state read and preserves the 14-batch scrollback sequence. Its identical browser regression passes there.
- resize forcing a full canvas render explains why the symptom can look like a resize recovery. It is not an acceptable workaround and cannot recover scrollback already discarded by the broken wrapper.

## recommended fix

Use the already-verified Ghostty patch and regenerated bundle from `fix/terminal-rendering` (commit `19547b8`) rather than adding grid-only repaint, timing, resize, prefill, or broker changes. Keep grid viewport prefill unchanged: full prefill changes the product contract and does not fix the browser-side defect.

## verification

- failing baseline: `bunx playwright test tests/e2e/ghostty-scrollback.e2e.ts --project=desktop`
  - failure: `scrollback dropped after batch 11`; expected `>= 641`, received `345`.
- patched comparison worktree at `fix/terminal-rendering` / `6f89e70`:
  `bunx playwright test tests/e2e/ghostty-scrollback.e2e.ts --project=desktop --grep 'retains append-only'`
  - passed.
- applied fix verification on this branch:
  - regenerated `public/ghostty-web.bundle.js` and `src/public-assets.ts` from the patched dependency; the only embedded-asset delta is `ghostty-web.bundle.js`.
  - `bunx playwright test tests/e2e/ghostty-scrollback.e2e.ts --project=desktop`: 2 passed.
  - `bunx playwright test tests/e2e/grid.e2e.ts --project=desktop --grep 'grid viewport prefill does not seed cached prose into terminal scrollback'`: passed.
  - `bun run typecheck`: passed.
- unrelated existing failure, reproduced both here and the patched comparison worktree:
  `grid output persists debounced recovery snapshots for every live cell` times out waiting for localStorage snapshots. It is outside this investigation and was not changed.

## steps

- [x] trace grid attach, prefill, reconnect, and resize paths.
- [x] build a deterministic browser reproduction that excludes broker and hydration.
- [x] identify the first layer where history diverges: Ghostty browser wrapper/render-state reads.
- [x] document root cause, evidence, and smallest safe fix scope.
- [x] apply the verified Ghostty patch and generated assets only.
- [x] verify the regression and targeted grid behavior.
