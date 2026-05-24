# Terminal Load Performance

This is the linked report for `TERMINAL_LOAD_OPTIMIZATION_PLAN.md` task 7.

## Pipeline

Single-terminal load:

1. `openSession()` creates the terminal view and starts a debug trace when `localStorage.wolfpackDebug = "1"`.
2. Ghostty WASM is ready, the terminal instance is created, fitted, and connected to `/ws/pty`.
3. The client sends `attach` with full prefill unless the path explicitly requests another prefill mode.
4. The server sends `attach_ack`, applies the requested size, fetches prefill, sends binary prefill, sends `prefill_done`, subscribes from the snapshot sequence, then sends `pty_ready`.
5. The client reveals after hydration writes are complete or the safety timer fires.

Grid-cell load:

1. `addToGrid()` creates a cell immediately and marks it as loading before async WASM work.
2. Each cell owns an isolated Ghostty instance; grid mode is refused if isolated instances are unavailable.
3. Each mounted cell connects as soon as its own mount finishes. Other cells no longer block it.
4. Grid attach uses viewport prefill, so the server avoids full scrollback and quiescence work.
5. Input remains gated to the focused connected cell.

## Debug Tools

- Browser trace: set `localStorage.wolfpackDebug = "1"` and reload. Use `window.__wf_dumpTrace()` for per-session event order, prefill/replay bytes, hydration timing, and rAF counts.
- Server timing: set `WOLFPACK_TERMINAL_LOAD_DEBUG=1`. The websocket server logs redacted `terminal_load` events with `event`, `session`, `mode`, `tMs`, and `sinceStartMs`.
- Harness: run `bun run perf:terminal-load`. It requires a broker binary by default.
- Existing broker mode: run `WOLFPACK_PERF_USE_EXISTING_BROKER=1 WOLFPACK_BROKER_SOCKET=/path/to/broker.sock bun run perf:terminal-load` when the environment cannot bind a new Unix socket.
- Synthetic slow prefill: add `WOLFPACK_PERF_SLOW_PREFILL_MS=<ms>` to exercise slow-path loading states.

## Budgets

The perf harness is advisory. It drives a browser, broker, PTY, WASM, and local process scheduling, so hard thresholds would be flaky across laptops and CI runners right now.

Advisory budgets:

| scenario | metric | advisory budget |
| --- | ---: | ---: |
| single:1 | hydration reveal | <= 900 ms |
| grid:2 | max hydration reveal | <= 1000 ms |
| grid:4 | max hydration reveal | <= 1400 ms |
| grid:6 | max hydration reveal | <= 1800 ms |

Correctness regressions are covered by deterministic tests where available:

- `tests/unit/broker-ws-attach.test.ts` asserts attach ordering, viewport-only prefill, `none` prefill short-circuiting, subscribe sequence reuse, and replay-truncated teardown.
- `tests/unit/prefill-chunking.test.ts` asserts chunked prefill delivery and mid-delivery teardown behavior.

Remaining deterministic gaps:

- Grid mount concurrency should get a unit harness for progressive per-cell connection, stale controller suppression, and isolated-WASM enforcement.
- Terminal load timing should get unit coverage for timing opt-in, mode mapping, and redacted timing field formatting.

## Measurements

Local measurement command:

```sh
WOLFPACK_PERF_USE_EXISTING_BROKER=1 WOLFPACK_BROKER_SOCKET=/Users/home/.wolfpack/broker.sock bun run perf:terminal-load
```

Same-host measurement attempt on 2026-05-23:

- Main/base was measured from `git archive main` extracted under `.baseline-main`, with the current perf harness copied in only as measurement tooling because `main` does not contain `scripts/terminal-load-perf.ts`.
- New broker mode cannot run on this host: `wolfpack-broker` exits with `Operation not permitted (os error 1)` when binding a Unix socket.
- Existing broker mode reaches the test-server startup path, then Bun cannot bind localhost: `Failed to start server. Is port 0 in use?`.
- Localhost connectivity is also blocked from this runner: `curl http://127.0.0.1:18790/api/backend` fails immediately with `Operation not permitted`.

| tree | command | result |
| --- | --- | --- |
| main/base (`ef18a86`) | `WOLFPACK_PERF_USE_EXISTING_BROKER=1 WOLFPACK_BROKER_SOCKET=/Users/home/.wolfpack/broker.sock bun scripts/terminal-load-perf.ts` | no browser timing; test server failed before `READY:<port>` with `Failed to start server. Is port 0 in use?` |
| improved working tree | `bun run perf:terminal-load` | no browser timing; broker socket was not created because Unix socket bind failed with `Operation not permitted` |
| improved working tree | `WOLFPACK_PERF_USE_EXISTING_BROKER=1 WOLFPACK_BROKER_SOCKET=/Users/home/.wolfpack/broker.sock bun run perf:terminal-load` | no browser timing; test server failed before `READY:<port>` with `Failed to start server. Is port 0 in use?` |

| mode | scenario | before timing | improved timing | status |
| --- | --- | ---: | ---: | --- |
| single | single:1 | not produced: localhost bind blocked | not produced: localhost bind blocked | rerun on a host/session that can bind and connect to `127.0.0.1` |
| grid | grid:2/grid:4/grid:6 | not produced: localhost bind blocked | not produced: localhost bind blocked | rerun on a host/session that can bind and connect to `127.0.0.1` |
