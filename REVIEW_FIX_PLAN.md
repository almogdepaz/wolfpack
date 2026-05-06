# PR #123 — Review Fix Plan

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

Each phase is independently shippable. #1–#3 + #10 are merge-blockers; the rest can land as follow-ups.

---

## Phase 1 — Ship-blockers (must land before merging #123)

### [x] 1. Close the socket-perms TOCTOU race
**File:** `broker/src/server.rs:~110`
**Problem:** `UnixListener::bind` creates the socket with default umask; `set_permissions(0o600)` runs after — local attacker can `connect()` in between.
**Fix:**
- `umask(0o077)` before bind, restore after, OR
- bind in a 0o700 parent dir (always — not only when path literally ends in `.wolfpack`) and `rename` into place
- harden the *parent dir* unconditionally for the fallback path, not pattern-matched on name
**Test:** integration test that `stat`s the socket immediately after `wait_ready` and asserts `0o600`. Parallel test using a custom socket path locks in parent-dir hardening.

### [x] 2. Fix snapshot→subscribe seq gap
**Files:** `src/server/broker-backend.ts:~372`, `src/broker/client.ts` (subscribe call site)
**Problem:** `getSessionPrefill` returns `snapshot.seq = N`, then `client.subscribe` attaches at broker's `current_seq = M ≥ N` with **no `since_seq`**. Bytes `(N, M]` sit in the ring but are never replayed → relies on byte-overlap heuristics.
**Fix:** pass `sinceSeq: snapshot.seq` to `subscribe`. Broker already replays from ring. Remove or downgrade `__stripInitialPtyOverlap` once seq-based replay covers the gap.
**Test:** integration test injecting PTY output between snapshot capture and subscribe attach; assert no bytes lost and no duplicates.

### [x] 3. Surface subscribe RPC errors in BrokerBackend
**File:** `src/server/broker-backend.ts:361-392`
**Problem:** RPC failure leaves local cb registered with refcount=1 → silent leak, no error to caller.
**Fix:** await the RPC inside `subscribeOutput`, unwind local cb registration on rejection, propagate error.
**Test:** unit in `broker-backend.test.ts` mocking RPC failure; assert no leaked subscriber state and that caller observes the error.

### [x] 10. Investigate & fix: black screen after time on another session; devtools-resize unblocks but with limited scrollback
**Symptom:** switch to another session, come back later → terminal canvas blank → opening devtools triggers layout/resize → screen renders but scrollback is short.

**Two compounding hypotheses:**
- **(a) renderer canvas invalidation.** xterm's canvas/webgl backing store can be invalidated by browser when the host element is hidden/unmounted. Only a forced reflow (resize, devtools toggle) triggers `term.refresh()`. The existing `visibilitychange` handler at `public/app.ts:2860` covers tab visibility but **not** in-app session switches — tab is still visible, only a different DOM node is shown.
- **(b) prefill mode truncates scrollback.** The first prefill into xterm's in-memory ring is `prefillMode: "viewport"` for grid cells (right) but possibly also for the focused single-session view (wrong). After the forced redraw, xterm draws what's in *its* ring — the broker's full scrollback was never streamed. So the post-resize render shows only the visible screen + whatever fit.

**Investigation steps:**
- repro: open session, switch away >X minutes, switch back. Log `term._core._renderService` state and `document.visibilityState` at the black-frame moment.
- confirm `visibilitychange` does NOT fire on in-app session switch (expected — tab still visible).
- check exactly what triggers redraw when devtools opens: window resize? `ResizeObserver`? Add instrumentation.
- audit `prefillMode` per controller: single-session vs grid cell, first attach vs reconnect.
- check whether `term.refresh()` alone (without resize) clears the black frame in repro — that pins the hypothesis to (a) vs (b).

**Likely fix:**
- on session show/focus, call `term.refresh(0, term.rows - 1)` unconditionally (cheap, idempotent) → addresses (a)
- for the active single-session view, default `prefillMode: "full"`; viewport mode stays for grid cells → addresses (b)
- on long-stale return (>`DESKTOP_STALE_THRESHOLD_MS`-equivalent applied to session-switch, not just tab-visibility), force `reconnect()` so broker re-streams from current snapshot+scrollback
- add `IntersectionObserver` on the terminal element → on becoming visible after being hidden, fire refresh + (if stale) reconnect

**Test:** e2e — open session, toggle hide/show via `display:none`, assert canvas non-blank within 100ms. Separate test: stale (>60s) session switch triggers a snapshot RPC and full-scrollback prefill.

---

## Phase 2 — Notable concerns (tracked issues, follow-up PRs)

### [x] 4. Notify clients on broadcast `Lagged`
**File:** `broker/src/server.rs:475-512`
**Fix:** on `Lagged(n)`, emit `subscription_dropped` event (new) or reuse `snapshot_invalidated`. Client auto-resyncs via fresh snapshot+subscribe. Don't tear down the connection.
**TS:** handler in `src/broker/client.ts` re-issues snapshot + subscribe with current seq.
**Test:** integration test with one slow consumer + one fast producer; assert the slow consumer gets a resync event and recovers.

### [x] 5. Signal replay truncation on subscribe
**Files:** `broker/src/output_bus.rs`, `broker/src/protocol.rs`
**Fix:** add `replay_truncated: bool` to `SubscribeResponse`; set when `since_seq < earliest_seq_in_ring`. TS treats it as "fetch snapshot before live."
**Test:** unit on `output_bus` with ring eviction; assert the flag.

### [x] 6. Move resize event emission onto `Session`
**Files:** `broker/src/session.rs:308-329`, `broker/src/session_router.rs`
**Fix:** `Session::resize` calls `EventSender::session_resized` directly; router becomes a thin caller.
**Why:** invariant lives with the type that owns the state — drift risk goes away.

### [x] 7. Tighten `unsubscribe` semantics + test session-id reuse
**File:** `broker/src/server.rs:431-467`
**Fix:** drain pending writer mpsc for that subscription before acking unsubscribe, or document the lag and add a fence frame.
**Test:** unsub session A, immediately sub session B with same recycled name (post-reap); assert no A-frames delivered as B.

---

## Phase 3 — Test coverage gaps

### [x] 8. Add the missing failure-mode tests
- malformed JSON in `control_request` payload → broker returns typed error, connection survives
- oversized frame (>16 MiB) over a live socket (currently only codec-level test) → connection dropped cleanly
- slow consumer end-to-end exceeding `DEFAULT_BROADCAST_CAPACITY` → exercises #4 path
- broker `SIGKILL` mid-session + client reconnect — manual + scripted via `kill -9`
- socket perms: `stat` after start, assert `0o600` (covered by #1's test)

---

## Phase 4 — Minor cleanup (single bundled PR, post-merge)

### [x] 9. Polish
- pooled buffer in `broker/src/codec.rs:72` — deferred (profiling needed)
- fix TS `unsubscribe` return type — done (`Promise<ControlResponse | null>` → `Promise<void>`)
- `BrokerBackend.list()` cache TTL — deferred (O(1) on cache hit; miss-path acceptable for current session counts)
- extract `terminal_state.rs` vte-tracking layer — deferred (architectural, separate PR)

---

## Out of scope
- redesigning broadcast vs ring capacity coupling (#5 makes truncation observable; decoupling sizes is a separate proposal)
- replacing xterm with ghostty-web everywhere

---

## Sequencing
1. **before merge:** #1, #2, #3, #10 — parallelizable, different files
2. **week of merge:** #4 + #5 as a pair — slow-consumer recovery needs both
3. **opportunistic:** #6, #7, #8, #9

## Verification gate before declaring done
- all Phase 1 boxes checked
- `cargo test` + `bun test` + e2e suite green
- manual repro of #10 confirmed fixed on real device (desktop + mobile)
- CI captures `stat` of socket post-start showing `0o600`
