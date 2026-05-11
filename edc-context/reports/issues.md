# Issues Report — Wolfpack Codebase

> Generated: 2026-05-10. Branch: fix/audit-findings-2026-05-10.
> Excludes fixed findings: SIGINT ralph cleanup, SW open-redirect, broker WS subscribe failure (onSubscribeError mitigation), grid WASM isolation guard, JWT startup misconfiguration silent, ralph srt-settings PID race, broker subscribe RPC dead-viewer, sinceSeq bigint truncation (clamped), reconnect resubscribe seq loss, hydration write epoch, isSessionAlive stale-cache (list() refresh), parseRalphLog PID-reuse (ps cmdline filter).
>
> Removed as no-op or accepted by-design: H1 dev-mode auth bypass (intentional — JWT enforced only when configured), H2 Tailscale-User-Login trust (intentional — assumes Tailscale ingress), H3 broker socket per-conn auth (declined — 0600 + same-UID threat model), H4 ralph sandbox optional (intentional — opt-in), M4 since_seq protocol gap (clamped; residual unfixable without protocol change), L7 removeWorktree --force fallback (warning added; no recovery possible), L15 CLOSE_CODE_SERVER_ERROR doc gap (constant added), L17 uninstall flag position (guard added; position-insensitive intentional).
>
> Resolved in commit batch 3: M1 CLI short-secret warning, M3 broker reconnect jitter, M6 PTY teardown order (kill before delete), M7 / L14 onReplayTruncated wiring (forces re-prefill on ring overrun), M8 config.json mode 0600, M11 Enter retry duplicate (timer dropped), M12 localStorage URL validation.
>
> Resolved in commit batch 4: L1 icon-192.png embedded as 192×192 PNG asset, L3 _wfTrace gated behind localStorage.wolfpackDebug, L9 broker JSON TextDecoder switched to fatal:true (corruption surfaces as CodecError), L11 server-side peer-fetch now uses peer-health adaptive timeouts, L13 GET /api/settings normalizes raw agentCmd when disabled.

---

## Medium Severity

### M2. Ralph lock TOCTOU window between stale-unlink and wx retry
**Location:** `src/server/routes.ts:747–778`
**Description:** When two concurrent `/api/ralph/start` requests race, both can detect a stale lock (PID dead), both call `unlinkSync(lockPath)`, and then both retry the atomic `wx` write. The first retry wins, the second gets a 409. The `unlinkSync` itself is not atomic relative to the concurrent request — if the first request hasn't written the lock yet when the second reads it, a double-unlink scenario exists. The consequence is benign (one request gets 409) but the window is not fully closed.
**Impact:** In theory, two ralph workers could both believe they acquired the lock in a narrow concurrent window. Practical risk low given typical usage patterns.

---

### M5. Quiescence loop produces stale snapshot for animated TUIs
**Location:** `src/server/websocket.ts:463–490`
**Description:** The quiescence loop exits at `QUIESCE_TIMEOUT_MS` (800ms) if the terminal byte rate never drops below 1024 bytes/100ms. Spinners, progress bars, clock displays, and any continuously-outputting TUI will never quiesce. The snapshot is taken mid-redraw, producing visually corrupt prefill that the client must overwrite with live output.
**Impact:** Users connecting to active TUI apps (htop, claude spinner, `watch`) see a garbled initial frame that takes 150–800ms to correct. No data loss, but visible UX artifact.

---

### M9. Push subscription file not fsync'd after rename
**Location:** `src/server/push.ts:119`
**Description:** Subscriptions are written via `writeFileSync(tmp) + renameSync(tmp, path)`. `renameSync` is atomic at the filesystem level but does not fsync the containing directory. On crash between rename and directory-entry flush on non-CoW filesystems (ext4 without `data=ordered`), the subscription file could revert to the previous state.
**Impact:** Push subscriptions silently lost on Linux after ungraceful server shutdown during a write. macOS (APFS) is safe.

---

### M10. `forceRepaint()` accesses ghostty-web private internals
**Location:** `public/app.ts:1213`
**Description:** `term.renderer?.render(term.wasmTerm, true, term.viewportY, term)` directly accesses private/undocumented ghostty-web API fields. This call is in the hot path (every `pty_ready` message triggers it). Any ghostty-web bundle update that renames or restructures these fields silently turns this into a no-op.
**Impact:** After a ghostty-web upgrade, `pty_ready` handling silently stops forcing a repaint, producing stale terminal display after attach. No error surfaced.

---

## Low Severity

### L2. Service worker registered as `/sw.js` but source is `sw-push.js`
**Location:** `public/app-state.ts:158`, `src/server/routes.ts:306–310`
**Description:** The frontend registers `navigator.serviceWorker.register("/sw.js")`. The server has an explicit `GET /sw.js` route that reads the `sw-push.js` asset and serves it. This works but is a non-obvious naming indirection: editing `sw-push.js` works, editing a hypothetical `sw.js` in `public/` would have no effect.
**Impact:** Developer confusion; low breakage risk, but the indirection is undocumented.

---

### L4. `resolveRipgrepBin` executes `which rg` at call time (per-iteration)
**Location:** `src/validation.ts:99–109`
**Description:** `resolveRipgrepBin()` calls `execFileSync("which", ["rg"])` synchronously. This is called from `buildSrtSettings` → `writeSrtSettings` → `runIteration` — once per ralph iteration, not at module load as previously noted. In stripped containers without `which`, falls back silently. If `which` hangs (NFS PATH, etc.), the entire iteration startup hangs.
**Impact:** Blocking sync exec on each ralph iteration. In containers without `which`, falls back silently. Hang risk on unusual PATH configurations.

---

### L5. Peer health state not persisted across page reloads
**Location:** `src/peer-health.ts`, `public/app.ts`
**Description:** `peerHealth` is in-memory state reset on every page reload. Dead peers get a fresh `5000ms` timeout immediately after reload, causing slow initial polls when a peer is down.
**Impact:** Page reload on a network with unreachable peers causes 5s hangs per dead peer before adaptive timeout kicks in. Minor UX annoyance.

---

### L6. `worktree.ts` order-file write failure is non-fatal but silently degrades cleanup
**Location:** `src/worktree.ts:63–69`
**Description:** If `.wolfpack/worktree-order.txt` cannot be written (disk full, permission denied), the worktree is still created but `cleanupAllExceptFinal` falls back to numeric path sort. If paths don't sort in creation order (slug collisions with timestamp suffixes), the "final" worktree selected for preservation may be wrong.
**Impact:** Wrong worktree preserved after ralph cleanup, potentially discarding the most-recent work.

---

### L8. `hasTTY` is a mutable module-level global set as a side effect
**Location:** `src/cli/config.ts:38–40`
**Description:** Opening `/dev/tty` in `ask()` sets `hasTTY = false` as a side effect if the open fails. This global controls whether all subsequent interactive prompts in setup are shown. Non-interactive environments (CI, pipes) skip all prompts silently with no indication.
**Impact:** Silent setup skipping in non-interactive environments. Callers cannot distinguish "user declined" from "non-interactive skip".

---

### L10. Broker `WRITER_QUEUE_CAPACITY` can backpressure the read loop
**Location:** `broker/src/server.rs:28`
**Description:** Each connection's writer queue is capped at 1024 entries. A slow WebSocket consumer fills the queue, backpressuring the read loop, which eventually stalls the TCP window. The PTY is not directly blocked, but the connection stops processing incoming control frames (input, resize) while the queue is full.
**Impact:** Slow mobile clients receiving heavy output may lose keyboard input and resize commands until they drain the queue.

---

### L12. `injectAgentContext` silent fallback on `--append-system-prompt` rejection
**Location:** `src/server/shell.ts:47–50`
**Description:** For claude, context injection uses `agentCmd + " --append-system-prompt " + shellEscape(ctx) + " || " + agentCmd`. If `--append-system-prompt` is rejected by a future claude version (flag removed), the `|| agentCmd` fallback runs claude without any context injection. This is silent degradation rather than an error; no alarm path exists.
**Impact:** Ralph context (subtask protocol, push notification endpoint) is silently omitted from all claude invocations if the flag is ever removed. Agents proceed without system context.

---

### L16. `audit-regressions.test.ts` contains a local replica of `validateProjectDir`
**Location:** `tests/unit/audit-regressions.test.ts`
**Description:** The test file inlines a copy of `validateProjectDir` logic from `src/server/routes.ts` to test it in isolation. If the production implementation diverges from the test's local copy (e.g., a new validation step is added to routes.ts), the regression test may pass while the real code is broken. This is explicitly noted in the test comments but remains a structural risk.
**Impact:** Regression tests for a security-sensitive boundary (path containment) may silently stop covering the actual production code path. Requires manual sync discipline.

