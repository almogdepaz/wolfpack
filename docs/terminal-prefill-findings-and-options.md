# Terminal Prefill Findings and Options

Date: 2026-05-26

## What we verified

### Code path

For `/ws/pty` attaches, `src/server/websocket.ts` maps prefill mode to broker snapshot options:

- `prefillMode: "viewport"` → `scrollbackLines: 0`
- `prefillMode: "full"` → default broker scrollback cap
- `prefillMode: "none"` → no snapshot prefill

`BrokerBackend.getSessionPrefill()` then fetches one broker snapshot and renders it with `renderSnapshotToAnsi()`.

Important: `scrollbackLines: 0` removes broker snapshot scrollback, but the snapshot still includes `visible_screen`.

After prefill, the server subscribes to broker output from the snapshot sequence (`sinceSeq = snapshot.seq`). Any output emitted after the snapshot can arrive as replay/live bytes and become browser-side Ghostty scrollback.

## Direct probe results

A real broker-backed test server was used. The probe attached directly to `/ws/pty` and counted binary bytes before and after `prefill_done`.

### Pure shell

A shell session was populated with:

```text
PURE-1 ... PURE-220
```

Viewport attach:

```text
prefillMode: viewport
prefillBytes: 442
replayBytes: 0
prefill markers: PURE-201 ... PURE-220 (20 lines)
```

Full attach:

```text
prefillMode: full
prefillBytes: 2566
replayBytes: 0
prefill markers: PURE-1 ... PURE-220 (220 lines)
```

Conclusion: for plain shell, viewport prefill includes only the visible bottom rows. It does not include older broker scrollback.

### Pi session

A fresh `pi` session was attached.

Viewport attach:

```text
prefillMode: viewport
prefillBytes: 3007
replayBytes: 10473
```

The viewport prefill contained current visible Pi UI/footer. The replay stream contained Pi startup/context/help text such as:

```text
pi v0.74.0
escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more
[Context]
~/.pi/agent/AGENTS.md, ~/Dev/wolfpack/AGENTS.md
```

Full attach:

```text
prefillMode: full
prefillBytes: 4007
replayBytes: 0
```

Conclusion: Pi in viewport mode can appear to bring “history” because Pi emits/redraws transcript/context-like content after the snapshot. Those bytes arrive as replay/live output and then accumulate in browser-side Ghostty scrollback. That is real browser history, but it is not broker snapshot scrollback.

## Why grid mode appears to have history with `scrollbackLines: 0`

Grid mode uses `prefillMode: "viewport"`, which requests zero broker scrollback.

Grid can still show useful history because:

1. The visible snapshot can contain many rows. Grid cells often have small font and tall visible areas, so visible screen can be ~50–70 rows.
2. Replay/live bytes after snapshot are written to Ghostty and become browser scrollback.
3. Pi/TUI apps often redraw or emit transcript/context-like output after attach/resize.
4. Browser-side Ghostty accumulates everything received after mount.

This means grid history is useful but opportunistic:

- Pi/agent TUI: often history-like replay/redraw appears.
- Plain shell: older scrollback outside the visible screen is not guaranteed.

## Benchmark findings

A solo switch benchmark compared forced `viewport` vs forced `full` using real broker-backed sessions populated with shell output.

### Before hydration tuning

| Mode | p50 reveal | p95 reveal | p50 ready | Server p50 |
|---|---:|---:|---:|---:|
| viewport | ~321ms | ~347ms | ~145ms | ~118ms |
| full | ~607ms | ~714ms | ~427ms | ~400ms |

### After experimental hydration tuning

Hydration changed from:

```text
minPendingMs: 200 → 80
silenceMs: 150 → 50
```

| Mode | p50 reveal | p95 reveal | p50 ready |
|---|---:|---:|---:|
| viewport | ~218ms | ~284ms | ~130ms |
| full | ~483ms | ~540ms | ~400ms |

### Bottleneck breakdown

For viewport mode after tuning:

- Ghostty creation: ~0ms, prewarm is working.
- Server viewport attach: ~108ms p50.
- Server viewport costs:
  - resize settle: ~68ms
  - snapshot fetch/render: ~20–30ms
- Visible reveal cost is mostly hydration gating.

For full mode:

- Server full attach: ~380–400ms p50.
- Server full costs:
  - resize settle: ~204ms
  - quiescence: ~85ms
  - snapshot fetch/render: ~69–90ms

## Prefill modes

### `none`

No snapshot. Subscribe/live stream directly.

Pros:

- Fastest server path.

Cons:

- No initial terminal state.

### `viewport`

Snapshot with `scrollbackLines: 0`; includes visible screen only.

Pros:

- Fastest useful initial state.
- Works well for grid.
- Pi/TUI replay can still produce useful browser scrollback.

Cons:

- No guaranteed shell history beyond visible screen.
- History depends on app redraw/replay behavior.

### `full`

Snapshot with default scrollback cap.

Pros:

- Predictable broker-backed scrollback/history.
- Best fidelity.

Cons:

- Slowest.
- Pays resize settle + quiescence + larger snapshot render.

### Potential `recent`

Not implemented. Would snapshot with a limited scrollback cap, e.g. 100–200 lines.

Pros:

- Predictable recent history.
- Faster than full.
- Simpler than shadow/full-split.

Cons:

- Slower than viewport.
- Requires implementation and tuning.

### Deferred `full_split` / shadow terminal

Not implemented. Would show viewport first, load full history into a hidden terminal, then swap.

Research found:

- Ghostty-web has no history insertion API.
- Ghostty-web has no snapshot import/export API.
- `CSI ?2026h` synchronized update does not prevent canvas repaint.

Pros:

- Could provide fast first paint plus reliable full history.

Cons:

- High complexity.
- Requires hidden shadow terminal, replay buffering, and atomic-ish DOM swap.
- Overkill if recent/opportunistic history is acceptable.

## Current practical options

### Option A — keep solo as viewport

Use grid-like behavior for solo terminal.

Best when:

- Fast switching matters most.
- Pi is the common workload.
- Opportunistic/replay history is acceptable.

Expected behavior:

- Fast current view.
- Pi often produces useful scrollback through replay/live output.
- Plain shell only gets visible rows.

### Option B — add `recent` for solo

Use limited broker scrollback for solo terminal.

Best when:

- User wants a predictable number of lines back.
- Full history is not required.
- Some extra latency is acceptable.

Suggested starting point:

```text
scrollbackLines: 150
```

Need to benchmark 50/100/150/250 lines against real Pi and shell sessions.

### Option C — keep `full` as optional

Use only when maximum fidelity/history matters.

Best when:

- User explicitly wants full-ish history.
- Slower switch is acceptable.

### Option D — revisit `full_split`

Only if both are required:

- fast viewport paint
- reliable deep history

Requires a real implementation plan around shadow terminal swap.

## Recommendations

1. Keep grid on `viewport`.
2. For Pi-heavy solo usage, `viewport` is a reasonable default because Pi emits useful replay/history-like output.
3. If predictable shell history matters, implement `recent` instead of going back to `full`.
4. Keep `full` available as an optional/history-heavy mode, not the fast default.
5. Keep tightened hydration thresholds only if visual testing confirms no flicker in real Pi sessions.
6. Next benchmark target: compare `viewport`, `recent:50`, `recent:150`, `recent:250`, and `full` on both pure shell and Pi.
