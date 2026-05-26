# Terminal Rendering Current Findings

This document records observed current behavior only. It intentionally does not prescribe decisions or a path forward.

## Code paths involved

### Frontend entry points

- Single terminal creation is coordinated in `public/app.ts` via `openSession()`, `switchSession()`, `initTerminal()`, and `createPtyTerminalController()`.
- Grid terminal creation is coordinated in `public/app-grid.ts` via `addToGrid()`, `renderGridCells()`, and `mountGridController()`.
- Both single and grid terminals use `createPtyTerminalController()` in `public/app.ts`.
- Both single and grid terminals connect to `/ws/pty` through `createPtySocketClient()` in `public/app.ts`.

### Server entry points

- `/ws/pty` is handled by `src/server/websocket.ts`.
- Broker-backed snapshot prefill is fetched through `BrokerBackend.getSessionPrefill()` in `src/server/broker-backend.ts`.
- Broker snapshots are rendered to ANSI by `src/broker/snapshot-render.ts`.
- Broker terminal snapshots are produced from `broker/src/terminal_state.rs` via `snapshot_with_reflow()`.

## Modes and parameters

### Single terminal

- Single terminal passes `prefillMode: "full"` from `public/app.ts`.
- Single terminal uses `DESKTOP_TERMINAL_SCROLLBACK = 2000` for the browser-side Ghostty terminal scrollback limit.
- Broker full prefill uses `SNAPSHOT_SCROLLBACK_LINES = 500` by default in `src/server/broker-backend.ts`.
- `switchSession()` currently calls `initTerminal()` without loading/passing a cached snapshot.
- `openSession()` does load cached snapshot via `loadSnapshot(...)` and passes it to `initTerminal(cached)`.

### Grid terminal

- Grid cells pass `prefillMode: "viewport"` from `public/app-grid.ts`.
- Grid cells use `GRID_TERMINAL_SCROLLBACK = 2000` for browser-side Ghostty terminal scrollback limit.
- Grid cells use font size `Math.max(tp.fontSize - 2, 10)`.
- Grid viewport prefill maps to `VIEWPORT_PREFILL_SCROLLBACK_LINES = 0` in `src/server/websocket.ts`.
- Unit coverage in `tests/unit/broker-ws-attach.test.ts` asserts viewport attach calls backend prefill with `scrollbackLines: 0`.

## Server attach behavior

### Full mode server sequence

In `src/server/websocket.ts`, full mode does:

1. wait for client resize messages to settle via `waitForResizeSettle()`.
2. apply broker resize and wait for output quiescence via `waitForOutputQuiescence()`.
3. fetch broker snapshot via `getSessionPrefill(...)` with default scrollback lines.
4. send binary prefill chunks.
5. send `prefill_done`.
6. subscribe to live output with `sinceSeq = snapshot.seq`.
7. send `pty_ready`.

### Viewport mode server sequence

In `src/server/websocket.ts`, viewport mode does:

1. wait for client resize messages to settle via `waitForResizeSettle()`.
2. apply broker resize.
3. fetch broker snapshot via `getSessionPrefill(...)` with `scrollbackLines: 0`.
4. send binary viewport prefill as one frame.
5. send `prefill_viewport`.
6. send `prefill_done`.
7. subscribe to live output with `sinceSeq = snapshot.seq`.
8. send `pty_ready`.

Viewport mode does not call `waitForOutputQuiescence()` before snapshot.

### None mode server sequence

`prefillMode: "none"` skips snapshot prefill and subscribes directly, then resizes and sends `pty_ready`.

## Client attach behavior

### Binary frame buffering

In `createPtySocketClient()`:

- While `_awaitingPrefillDone` is true, binary frames are buffered in `_prefillChunks`.
- On `prefill_viewport`, the client flushes currently buffered chunks immediately to the terminal, then continues buffering later prefill chunks until `prefill_done`.
- On `prefill_done`, the client flushes remaining buffered chunks.
- Binary frames after `_awaitingPrefillDone` is false are treated as replay/live output and are written directly via `onBinaryData`.

### Full mode and `prefill_viewport`

Full mode does not emit a `prefill_viewport` boundary. The client buffers full binary prefill chunks and flushes them at `prefill_done`.

### Viewport mode `prefill_viewport`

For viewport mode, server sends binary prefill first, then `prefill_viewport`. The client flushes the viewport binary data at `prefill_viewport`.

## Content sources visible in terminals

Terminal content can come from multiple sources:

1. cached local snapshot from localStorage.
2. broker snapshot prefill bytes.
3. broker replay bytes after `subscribe(sinceSeq = snapshot.seq)`.
4. live PTY output after subscription.
5. program redraw caused by broker resize/SIGWINCH.
6. browser-side Ghostty scrollback accumulated after the cell/controller is mounted.

`scrollbackLines: 0` only affects broker snapshot scrollback. It does not prevent replay/live output after the snapshot from adding browser-side scrollback.

## Broker snapshot behavior

- Broker `Snapshot` contains `visible_screen` and `scrollback`.
- `SnapshotParams.scrollback_lines` is optional.
- `snapshot_terminal(Some(n), ...)` truncates broker scrollback to trailing `n` raw rows before reflow.
- `snapshot_terminal(Some(0), ...)` returns zero broker scrollback rows.
- `visible_screen` is still included even when scrollback is zero.

## Local reproduction data

### Controlled temp shell session: direct WebSocket comparison

A temporary shell session was created and populated with `WFGH-1..WFGH-140` lines. It was then attached directly over WebSocket in viewport and full modes.

Viewport attach at `60x20`:

- `prefill_done`: ~274 ms from WebSocket open.
- binary prefill bytes: `388`.
- observed `WFGH-*` lines in prefill: `16`.
- first observed marker: `WFGH-125`.
- last observed marker: `WFGH-140`.

Full attach at `60x20`:

- `prefill_done`: ~317 ms from WebSocket open.
- binary prefill bytes: `1693`.
- observed `WFGH-*` lines in prefill: `140`.
- first observed marker: `WFGH-1`.
- last observed marker: `WFGH-140`.

This run showed viewport prefill containing only current visible rows, while full prefill contained the generated historical lines.

### Controlled temp shell session: browser single vs 2-cell grid

Two temporary shell sessions were created and opened in the browser.

Single full attach:

- hydration reveal elapsed from open action: ~774 ms.
- trace prefill bytes: ~3075.

2-cell grid attach:

- hydration reveal elapsed from add-to-grid action: ~506-522 ms per cell.
- trace prefill bytes: ~1200 per cell.

Immediate post-hydration grid terminal state in one 2-cell run:

- `rows`: `69`.
- `cols`: `83`.
- `scrollbackLength`: `0`.
- `bufferLength`: `69`.

This run showed a grid cell with many visible rows but no browser-side scrollback immediately after hydration.

### Current live sessions: `wolfpack` single full attach

Playwright opened the current live `wolfpack` session in single-terminal mode. The page encountered viewer conflict and the run clicked take-control.

Observed:

- elapsed to hydration reveal: ~802 ms.
- `prefillBytes`: ~78 KB.
- `replayBytes`: `0` in trace.
- terminal `rows`: `57`.
- terminal `cols`: `146`.
- terminal `scrollbackLength`: `502`.
- terminal `bufferLength`: `559`.
- nonblank lines counted in Ghostty buffer: `501`.

### Current live sessions: `wolfpack` + `edc` grid

Playwright opened grid mode with current `wolfpack` and `edc` sessions.

Observed for grid transition:

- elapsed until grid cells visually hydrated: ~511 ms.

Observed for `wolfpack` grid cell:

- `prefillBytes`: ~6 KB.
- `replayBytes`: ~442 KB.
- `prefill_done`: ~321 ms in trace.
- `pty_ready`: ~321 ms in trace.
- hydration reveal: ~490 ms in trace.
- terminal `rows`: `67`.
- terminal `cols`: `83`.
- terminal `scrollbackLength`: `646`.
- terminal `bufferLength`: `713`.
- nonblank lines counted in Ghostty buffer: `636`.

Observed for `edc` grid cell in that run:

- viewer conflict occurred.
- `prefillBytes`: `0`.
- `replayBytes`: `0`.
- no valid connected-load metric was collected for `edc` in that run.

## Observed discrepancy

Code and unit tests show grid viewport prefill requests broker snapshots with `scrollbackLines: 0`.

However, in the current live `wolfpack` grid run, the grid cell accumulated browser-side scrollback after attach:

- `scrollbackLength: 646`.
- `replayBytes: ~442 KB`.

The scrollback in that run was not from broker snapshot scrollback prefill. It was present in the browser terminal after post-prefill replay/live output was written.

## Timing notes

The measured timings depend on the session state and viewer conflict state.

Observed examples:

- controlled temp shell, direct WebSocket viewport prefill: ~274 ms to `prefill_done`.
- controlled temp shell, direct WebSocket full prefill: ~317 ms to `prefill_done`.
- controlled temp shell, browser single full: ~774 ms to hydration reveal.
- controlled temp shell, browser 2-cell grid: ~506-522 ms to hydration reveal.
- current live `wolfpack`, single full with take-control: ~802 ms to hydration reveal.
- current live `wolfpack`, grid cell: ~490 ms trace hydration reveal, with ~442 KB replay bytes after prefill.

## Files touched during investigation

- `plans/PLAN-terminal-rendering-smoothness.md` was updated with investigation notes.
- This file records the current behavior findings in doc form.
