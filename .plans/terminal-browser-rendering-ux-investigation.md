# terminal browser rendering ux investigation

## status
- [x] map browser → websocket → broker → snapshot → ghostty rendering path
- [x] inspect relevant history and prior reviews
- [x] reproduce lifecycle, stale-socket, transition-resize, latency, and snapshot-fidelity failures
- [x] rank fixes and define regression coverage
- [x] phase 1 — ghostty document-listener disposal
- [x] phase 2 — websocket generation isolation
- [x] phase 3 — broker snapshot edit operations
- [x] phase 4 — atomic sidebar layout transitions
- [x] phase 5a — private perf-harness broker socket
- [x] phase 5b — rerun measurements and remove first-open sidebar width churn
- [x] full verification and build
- [x] server/browser local install with broker pid and all 5 sessions preserved
- [ ] broker binary install — blocked on explicit destructive-restart approval

## scope and method

Investigation began on `dev_new` at `744c9d3`; every defect was rechecked before implementation from `origin/main` at `ed49315`. Implementation is isolated in `/Users/home/Dev/wolfpack-terminal-rendering` on `fix/terminal-rendering-reliability`. No subagents were used.

Covered:
- solo and grid terminal mount/dispose
- websocket attach/reconnect/replacement
- broker canonical terminal state and snapshot replay
- ghostty prewarm, hydration, canvas reveal, and resize behavior
- sidebar pin/unpin transitions
- standalone and existing-broker performance harness paths

## findings

### p0 — ghostty-web disposal leaks a complete terminal per mount

**Evidence**
- 30 solo session switches followed by forced GC grew browser heap from approximately **3.8 MB to 26.6 MB**.
- each mount leaked one `document.mousedown` and one `document.mouseup` listener.
- after final terminal disposal, **31 mousedown + 31 mouseup listeners** remained.
- canvases disappear from the DOM, but the document listeners retain the selection manager / terminal closure graph, including renderer, textarea, and WASM-facing state.

**Root cause**
- ghostty-web 0.4.0 selection manager registers anonymous `document.addEventListener("mousedown", ...)`; `dispose()` has no reference with which to remove it.
- `Terminal.dispose()` sets `isOpen = false` before `cleanupComponents()`, while cleanup removes its document-level `mouseup` listener only when `isOpen` is true. That removal is therefore unreachable on normal disposal.
- source is represented in `patches/ghostty-web@0.4.0.patch`; this is a dependency lifecycle defect, not a Wolfpack controller-count problem.

**Fix contract**
1. patch/vendor ghostty-web so every document-level listener has a stored bound callback.
2. remove those callbacks unconditionally during disposal; disposal must remain idempotent.
3. add a browser regression that instruments document listener add/remove calls, mounts/disposes repeatedly, and asserts listener counts return to baseline.
4. keep forced-GC heap growth as a soak diagnostic, not a brittle CI threshold.

### p0 — replaced websocket callbacks can mutate the current terminal

**Evidence**
- deterministic fake-WebSocket repro replaced socket A with socket B, then delivered a delayed binary frame from A.
- the stale frame was accepted and written into the current terminal.

**Root cause**
- `public/app.ts:1273-1290` guards neither `onopen` nor `onmessage` with socket identity.
- only `onclose` checks `if (ws !== sock) return` at `public/app.ts:1292-1295`.
- a stale binary message can paint old output; a stale text message can mutate attach/prefill state; a stale open can send an attach and invoke current connection callbacks.

**Fix contract**
1. add the same current-socket identity/generation guard to `open`, `message`, and `close` processing.
2. when retiring a socket, detach all callbacks before closing so old closures are released promptly.
3. add a deterministic regression delivering stale text and binary frames after replacement; neither may write, reveal, reset hydration, or invoke current connection callbacks.

### p0 — broker snapshots silently diverge on standard terminal edit sequences

**Evidence**
- `broker/src/terminal_state.rs:1200-1257` ignores unhandled CSI actions.
- direct broker-state repro:

```text
DCH input: ABCDE + CUP(1,2) + CSI 2 P
expected:  ADE
snapshot:  ABCDE

ICH input: ABCDE + CUP(1,2) + CSI 2 @
expected:  A  BCDE
snapshot:  ABCDE
```

- related standard operations are also absent: ECH (`X`), IL/DL (`L`/`M`), and SU/SD (`S`/`T`).

**Root cause and user-visible mechanism**
- the live Ghostty terminal applies these operations, while the broker's canonical model silently drops them.
- reconnect then replaces a correct live viewport with a stale broker snapshot.
- resizing sends SIGWINCH; a full-screen TUI redraw then repairs the display. This is a concrete mechanism for "wrong/junk display until resize."
- confidence is high that snapshots are incorrect whenever these operations occur; capture of the exact reported production stream is still needed to attribute every junk-byte report to this one cause.

**Fix contract**
1. add table-driven Rust tests first for ICH, DCH, ECH, IL, DL, SU, and SD, including count=0/default, clipping, scroll margins, attributes, wide graphemes, and continuation cells.
2. implement row/region helpers that preserve wide-cell invariants; do not raw-shift cells and leave orphan continuations.
3. add broker snapshot/reconnect coverage using the same byte fixtures.
4. sample a real Claude/Pi TUI stream and record which unsupported CSI actions it emits before expanding beyond this core set.

### p1 — only the first sidebar layout transition is hidden; later transitions resize live canvases

**Evidence**
- pin and unpin keep the canvas visible while issuing approximately **three terminal resizes per CSS transition**.
- `state.sidebarResizeDone` is reset when a session/grid is initialized, checked before hiding at `public/app.ts:5229` and `:5250`, then set true at `:5318`.
- pin/unpin handlers do not reset it. Thus only the first transition after session/grid initialization can hide the terminal.
- the ResizeObserver at `public/app.ts:1783-1791` suppresses hover overlay transitions, but not pinned layout transitions, so intermediate widths are fitted and sent to the PTY.

**Impact**
- visible canvas reflow/flicker during every later pin/unpin.
- repeated SIGWINCH/TUI redraw churn during a 200 ms CSS animation.
- avoidable snapshot rehydrate work when scrollback is active.

**Fix contract**
1. represent an active layout-changing sidebar transition explicitly; reset it for every pin/unpin/expanded-layout action.
2. hide the relevant solo/grid canvases at transition start.
3. suppress ResizeObserver-driven fits while that layout transition is active.
4. on `transitionend`, perform one settled fit/backend resize, then reveal.
5. preserve current hover-overlay behavior: it does not change terminal width and must not resize the PTY.
6. regression must toggle pin/unpin at least twice; a one-toggle test misses the bug.

### p1 — standalone performance harness is broken by broker socket hardening

**Evidence**
- existing-broker mode runs successfully.
- standalone `scripts/terminal-load-perf.ts` creates `/tmp/wp-perf-<uuid>.sock` at `:190-206`.
- broker startup hardens the socket parent directory to `0700` at `broker/src/server.rs:101-109`.
- on macOS, attempting to chmod shared `/tmp` fails with `EPERM`, so the harness cannot spawn its broker.

**Fix contract**
1. create a private temporary directory with `mkdtemp()`.
2. place the socket inside that directory.
3. remove the socket/directory during cleanup on success and failure.
4. do not weaken broker directory hardening.
5. verify both standalone and `WOLFPACK_PERF_USE_EXISTING_BROKER=1` modes.

### p2 — terminal creation/prewarm is not the dominant load cost

**Evidence**
- fresh existing-broker run: solo reveal approximately **319 ms**; two grid cells approximately **241–257 ms**.
- cold Ghostty creation measured approximately **13–18 ms**.
- controlled mock path: prewarmed opens approximately **156 ms**, cold approximately **188–195 ms**.
- prewarmed instance acquisition itself was effectively free.

**Conclusion**
- prewarm helps modestly but is not the primary reason terminals feel slow.
- dominant remaining time is server readiness/snapshot sequencing plus browser hydration/reveal gating.
- do not attempt a server-side renderer or multiplexing rewrite based on current evidence. Existing snapshot-before-subscribe ordering, hidden hydration, output coalescing/backpressure, and per-cell isolation are doing real correctness work.

**Next measurement after p0/p1 fixes**
- rerun the repaired perf harness with trace splits for layout stable, attach ack, snapshot fetch, first prefill byte, prefill done, write completion, and reveal.
- optimize only the largest measured interval; do not remove correctness gates wholesale.

## negative and stale hypotheses

- no leaked `perf-*` sessions or investigation processes remained after the repros.
- a forced queued-hydration reveal followed immediately by session switching stayed hidden (`visible/0`) until disposal; that attempted stale-reveal race did **not** reproduce.
- sidebar hover expansion is overlay-only and correctly suppresses PTY resize.
- prior review claims that wide/CJK snapshot support is absent are stale: current broker state stores grapheme strings and explicit continuation cells, with tests. Wide-cell correctness is still a required edge case for the missing edit operations above.
- prewarm is not currently worth removing for performance reasons; revisit only after the actual leak is fixed and memory is remeasured.

## implementation order

Each phase is a separate reviewable change and starts with a failing regression.

### phase 1 — stop unbounded retention
- ghostty listener/disposal regression
- dependency patch
- repeated-switch verification and heap soak

### phase 2 — isolate websocket generations
- stale text/binary/open regression
- identity guards and callback retirement
- reconnect/session-switch/browser suite

### phase 3 — restore canonical snapshot fidelity
- Rust behavior fixtures
- ICH/DCH/ECH/IL/DL/SU/SD implementation
- broker snapshot/reflow/reconnect suites
- real TUI stream sample

### phase 4 — make layout transitions atomic
- repeated pin/unpin regression
- explicit layout-transition suppression
- one settled resize then reveal
- solo, normal grid, delegation grid, and expanded sessions coverage

### phase 5 — repair and rerun performance measurement
- private temp socket directory
- standalone + existing-broker verification
- rerun A/B after phases 1–4
- only then choose a load-latency optimization

## verification matrix

- repeated solo session switches, final disposal, forced GC
- repeated grid/delegation-grid create, collapse, expand, and dispose
- reconnect with delayed old-socket open/text/binary/close events
- snapshot replay containing ICH/DCH/ECH/IL/DL/SU/SD, wide/combining characters, and scroll regions
- pin/unpin repeated twice in solo/grid/delegation grid
- sessions-expanded enter/exit and first terminal open
- background/foreground and session exit/restart
- standalone and existing-broker perf harness modes
- full Bun and Rust suites after each production phase

## implementation measurements

The repaired standalone harness now starts and cleans up an isolated broker without touching the installed broker.

Before settling the pinned sidebar synchronously, solo open attached at 159 columns and stabilized at 134 columns. A fresh run measured:
- solo reveal: 300.0 ms
- server ready: 193.8 ms
- attach-to-stable column delta: -25

After settling the sidebar before Ghostty mount:
- solo reveal: 213.9 ms (**86.1 ms / 28.7% faster**)
- server ready: 112.9 ms (**80.9 ms faster**)
- attach/stable columns: 126/126 (zero churn)

Grid cells remained stable at zero column delta; their one-run timings varied within the prior observed range, so no grid correctness gate was removed.

## non-goals

- no full server-side terminal renderer rewrite.
- no websocket multiplexing rewrite.
- no removal of hydration/snapshot ordering without measurement proving it safe.
- no broad adjacent UI cleanup.
