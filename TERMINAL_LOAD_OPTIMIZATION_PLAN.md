# Plan: Terminal Load Optimization

Status: drafted, not started.

Goal: minimize perceived time from opening a session/cell to a usable terminal in both single-terminal and grid modes, while preserving correctness: no lost output, no stale prefill, no cross-cell leaks, no reconnect loops, no jarring blank/flash states.

Success metrics to establish before optimizing:
- Single mode: tap/open → terminal shell visible; tap/open → input accepted; reconnect → hydrated view stable.
- Grid mode: add cell → first visible terminal content; add N cells → all cells usable; focus switch → input accepted.
- Server path: WS upgrade → attach received → snapshot/prefill sent → subscribe active → first live byte forwarded.
- UX smoothness: no blank > 250ms after route transition if cached snapshot exists; no content flash during hydration; no layout jump after final fit.

Constraints:
- Do not weaken the snapshot→subscribe gap protection.
- Do not bypass per-cell isolated Ghostty WASM in grid mode.
- Keep instrumentation gated or low-overhead; do not expose session contents in telemetry.
- Every behavior change gets regression coverage before production changes.

## 1. Add terminal-load timing instrumentation

Map the real critical path before optimizing.

Work:
- Add a dev/debug-only timing trace for single mode and grid mode using `performance.mark()` / `performance.measure()` or the existing opt-in `wolfpackDebug` tracer.
- Capture at least: openSession/addToGrid start, DOM view/cell created, Ghostty ready, terminal instance created, first fit, WS open, attach sent, attach_ack, prefill first chunk, prefill_done, pty_ready, hydration revealed, first input accepted.
- Add matching server-side log timing around `/ws/pty`: upgrade accepted, attach parsed, resize settle start/end, snapshot fetch start/end, prefill send start/end, subscribe start/success, first output forward.
- Redact session data; log only session name/mode/timing numbers.

Acceptance:
- A local debug run can produce a single waterfall for single mode.
- A local debug run can produce one waterfall per grid cell.
- Instrumentation is disabled or near-zero overhead by default.
- Tests cover any pure timing helper/formatting logic added.

## 2. Build a repeatable performance reproduction harness

Make terminal load measurable without vibes.

Work:
- Add a Playwright or Bun integration harness that opens a known broker-backed session and records client timing marks.
- Cover single mode and grid mode with 1, 2, 4, and 6 cells if the real broker is available; otherwise skip with a clear reason.
- Include a synthetic slow-prefill scenario if feasible through existing test hooks or a focused mock boundary.
- Write baseline numbers into the plan/status output, not hardcoded as pass/fail thresholds yet.

Acceptance:
- One command produces timing summaries for single and grid modes.
- The harness can distinguish Ghostty creation time, WS/server time, prefill time, and hydration reveal time.
- Existing test suite remains deterministic; perf harness is opt-in if noisy.

## 3. Optimize single-terminal first paint and hydration

Reduce user-visible blank time without hiding correctness bugs.

Work:
- Use baseline data to identify whether the largest cost is Ghostty init, route animation, fit/resize, snapshot prefill, hydration silence timers, or server subscribe.
- If cached snapshot exists, render a non-authoritative placeholder/skeleton immediately while the real terminal hydrates, or shorten the blank route transition safely.
- Review hydration thresholds (`minPendingMs`, `silenceMs`, fallback/safety timers) against measured write completion timing; lower only where evidence says safe.
- Avoid double work on session switch: prevent duplicate fit/repaint/resize cycles if the terminal is about to reconnect anyway.

Acceptance:
- Single mode improves measured open→visible and open→usable time versus baseline.
- Reconnect still preserves snapshot→subscribe correctness and does not lose live bytes.
- Tests cover hydration reveal timing decisions or reconnect behavior affected by the change.

## 4. Optimize server attach/prefill path

Shorten backend time before the client can display stable terminal content.

Work:
- Use server timing to inspect resize-settle, quiescence wait, snapshot rendering, prefill chunking, and subscribe ordering.
- For `prefillMode: viewport`, avoid full-scrollback work and unnecessary waits that only help full prefill.
- Confirm `prefillMode: none` short-circuits all snapshot/quiescence work.
- Consider sending `attach_ack` as early as safely possible, then stream prefill/live data in the current ordering contract.
- Keep replay gap handling and `onSubscribeError` teardown intact.

Acceptance:
- Server-side attach timing improves for viewport and none prefill modes.
- Full prefill behavior remains correct on desktop single mode.
- Regression tests cover the ordering: attach_ack, prefill chunks, prefill_done, subscribe/live output, replay-truncated close.

## 5. Optimize grid mounting and multi-cell concurrency

Make grid cells appear progressively and avoid N-cell startup waterfalls.

Work:
- Audit `addToGrid()`, `renderGridCells()`, `mountGridController()`, `Promise.all(mountPromises)`, and `runGridRelayoutTransition()` for serialized work.
- Connect each new cell as soon as its controller and first fit are ready instead of waiting on unrelated cells, unless layout correctness requires a barrier.
- Avoid redundant fits caused by layout transition + controller init; batch relayout reads/writes to reduce forced reflow.
- Keep focused-cell stdin routing and per-cell WASM isolation unchanged.

Acceptance:
- Grid mode shows each cell progressively rather than all-or-nothing when possible.
- Adding 2/4/6 cells improves measured all-cells usable time and first-cell visible time.
- Tests cover no cross-cell input leakage, no stale controller after remove/re-add, and no regression to shared WASM fallback.

## 6. Smooth loading UX and failure states

Optimize perception, not just raw milliseconds.

Work:
- Replace jarring blank/loading states with consistent skeleton/hydrating states that match single and grid modes.
- Ensure cached snapshot, prefill loading, viewer conflict, displaced, and reconnect states have distinct visual states without flicker.
- Add a visible but unobtrusive slow-path indicator when load exceeds a measured threshold.
- Respect reduced-motion/no-animations settings.

Acceptance:
- No white/black flash or empty grid cell gap during normal load in single or grid mode.
- Slow paths are explainable to the user without blocking interaction.
- Visual changes have browser-level or DOM-level regression coverage where practical.

## 7. Lock in budgets and regression tests

Prevent terminal load from getting slow again.

Work:
- After optimization, record baseline and improved timings in this plan or a linked report.
- Add stable assertions for ordering/correctness in unit/integration tests.
- Add optional perf thresholds only if the harness is stable enough on local/CI machines; otherwise keep them advisory.
- Update docs for the terminal load pipeline and any debug tools added.

Acceptance:
- `bun run typecheck` passes.
- Relevant unit/integration tests pass.
- Full `bun test` passes before final handoff.
- The final report lists measured before/after timings for single mode and grid mode.

- [ ] run the perf harness on a host that allows localhost and unix socket binding, then update docs/terminal-load-performance.md with actual measured before/after timings for single mode and grid mode
- [ ] run full bun test on a host/test configuration that allows required local sockets, localhost servers, pgrep/sysmond access, and test-owned WOLFPACK_DIR writes
- [ ] commit the code/doc/test changes from a context allowed to write the shared git common dir

- [ ] run `bun run perf:terminal-load` on a host where both localhost TCP listen and Unix socket listen succeed, capture the JSON summary for current improved timings
- [ ] run the same harness against the pre-optimization baseline, capture single:1 and grid:2/grid:4/grid:6 hydration reveal timings, then update `docs/terminal-load-performance.md` with measured before/after values and commit only the doc change

- [ ] run on a host profile where bun/node can bind localhost port 0 and listen on required unix sockets, including hardcoded /tmp broker-client sockets
- [ ] allow pgrep/sysmond process-list access for ralph pid liveness tests
- [ ] build/provide WOLFPACK_BROKER_BIN, then rerun full bun test with WOLFPACK_TEST=1 and test-owned HOME/WOLFPACK_DIR

- [ ] run the perf harness on a host where localhost and unix socket binding are permitted and capture after-state json for single:1 and grid:2/grid:4/grid:6
- [ ] measure the before baseline from main/base on the same host, update docs/terminal-load-performance.md with actual before/after timings, then commit only the doc change

- [ ] commit the existing worktree changes from an execution context with write permission to the shared git common dir, excluding runner-owned transient files and TERMINAL_LOAD_OPTIMIZATION_PLAN.md
