# Review Report: tests/ module — PR #106

## Summary

24 files changed, 2992 diff lines. The dominant change is migration from `__setTestOverrides()` (tmux stub shims) to `__setTestBackend(MockBackend)` — tests now exercise real `BackendRouter` routing. Eight new unit test files cover previously untested modules (ring buffer, PTY backend, push crypto/VAPID, strip-ansi, tailscale exec, backend singleton, backend router). The migration is broadly correct. Two correctness issues require fixing before merge.

## Diff Scope

- `tests/integration/api.test.ts` — rewritten against real server (~750 lines)
- `tests/integration/pty-test-helpers.ts` — MockBackend boot helper
- `tests/integration/auth-middleware.test.ts` — JWT config singleton handling
- `tests/integration/pty-takeover.test.ts`, `concurrent-pty-viewer.test.ts`, `take-control.test.ts` — WS lifecycle
- `tests/integration/desktop-terminal.test.ts`, `desktop-grid.test.ts` — close-code assertions
- `tests/integration/boot-backend.test.ts` — new, tests backend singleton init
- `tests/unit/` — 8 new test files
- `tests/unit/ralph-worktree.test.ts` — gpgsign fix
- `tests/unit/triage.test.ts` — `isInputPrompt` removal

## Findings

### [TEST-01] Notify rate limiter state not reset between tests — order-dependent
**Severity:** medium
**File(s):** `tests/integration/api.test.ts:774-784`
**Category:** flakiness

`beforeEach` clears `__pollRateLimiter._map` and `__globalRateLimiter._map` but NOT `notifyTimestamps` (module-level in `push.ts`). The test comment acknowledges "already sent 1 call above" — explicit ordering dependency. If test order changes or the preceding `valid notification → 200` test is skipped, the burst count is different.

**Impact:** Test order-dependent; flaky under re-ordering or parallel runs.

**Suggested fix:** `_testing.notifyTimestamps = []` (or `_testing.resetDebounce()`) in the notify `beforeEach`, mirroring `tests/unit/push.test.ts:319-321`.

### [TEST-02] Subscription cap test has no try/finally — leaks real files on assertion failure
**Severity:** medium
**File(s):** `tests/unit/push.test.ts:284-312`
**Category:** cleanup

The cap test adds up to 20 real entries to `~/.wolfpack/push-subscriptions.json`. The cleanup `for (const ep of added) removeSubscription(ep)` is inline — if any `expect()` throws mid-loop, the file retains garbage entries. Subsequent runs start with a non-zero `getSubscriptionCount()` baseline, potentially failing the cap logic.

**Impact:** Persistent cross-run test pollution.

**Suggested fix:** Wrap body in `try/finally { for (const ep of added) removeSubscription(ep); }`.

### [TEST-03] session-unavailable test weakened — 4001 close code regression no longer locked in
**Severity:** medium
**File(s):** `tests/integration/desktop-terminal.test.ts:463-475`
**Category:** correctness

Old test verified the server sends WS close code `4001` before any prefill messages. New test accepts either "connect throws" OR `ev.code >= 1000` — the latter accepts any close code including `1000`. Because the server correctly rejects at the HTTP upgrade level (403 Forbidden, not a WS close), the `catch` branch fires and the test passes unconditionally regardless of what code the server would send. The regression lock is gone.

**Impact:** Regression in close-code semantics (frontend takes-control state machine depends on 4001) would pass unnoticed.

**Suggested fix:** Assert the `catch` branch fires (HTTP 403 rejection), and fail if the upgrade was accepted. Or use a helper that validates close code matches `CLOSE_CODE_SESSION_UNAVAILABLE`.

### [TEST-04] bootTestServer leaks `__setTestBackend` singleton across loop iterations
**Severity:** low
**File(s):** `tests/integration/boot-backend.test.ts:14-38`
**Category:** cleanup

The `for (const backendType of ["tmux", "pty"])` loop calls `bootTestServer()` twice. Each call calls `__setTestBackend(mock, backendType)` (global mutation) but `ctx.cleanup()` does NOT call `__resetBackend()`. The second iteration overwrites the singleton left by the first, but any test in the same bun worker running after this file inherits a "pty" mock backend. Same contamination class as the pre-existing JWT singleton issue (TEST-1 in issues.md).

**Impact:** Cross-file test contamination under same bun worker.

**Suggested fix:** Add `__resetBackend()` to `ctx.cleanup()` in `pty-test-helpers.ts`.

### [TEST-05] sendTakeControl sends two frames — relies on in-order delivery
**Severity:** low
**File(s):** `tests/integration/pty-test-helpers.ts:150-153`
**Category:** flakiness

`sendTakeControl` sends `attach` then `take_control` as two separate sends. WS message ordering within a single connection is guaranteed by the spec so this is safe. Noted for awareness — the comment in the helper is sufficient documentation. No action required.

### [TEST-06] backend-router.test.ts uses Object.create + `(router as any).field` for private fields
**Severity:** low
**File(s):** `tests/unit/backend-router.test.ts:19-30`
**Category:** correctness

`createTestRouter()` bypasses `BackendRouter`'s constructor (which spawns real PtyBackend/TmuxBackend) via `Object.create(BackendRouter.prototype)` and manually injects private fields by string name. A field rename in production would produce silent wrong behavior rather than a type error. The `(router as any)` cast disables TypeScript's protection.

**Impact:** Silent test breakage on private-field rename.

**Suggested fix:** Add a comment listing the private field names and noting they must stay in sync with `BackendRouter`. Alternatively expose a test-only static factory.

### [TEST-07] pty-backend.test.ts uses fixed `sleep()` waits — inherently flaky on loaded CI
**Severity:** low
**File(s):** `tests/unit/pty-backend.test.ts:70-87`
**Category:** flakiness

`capturePane captures PTY output` and `send writes to PTY` use `sleep(300)` + `sleep(500)` before asserting output content. On loaded CI macOS runners, process spawn + shell prompt + command echo can exceed 800ms. Tests are placed in `tests/unit/` despite being labeled "integration-ish" (spawning real PTY processes).

**Impact:** Flaky under CI load.

**Suggested fix:** Replace fixed sleeps with a poll loop: `while (Date.now() < deadline && !output.includes(marker)) { await sleep(50); output = await capturePane(); }`.

### [TEST-08] triage.test.ts removes isInputPrompt tests — behavioral change correctly locked
**Severity:** info
**File(s):** `tests/unit/triage.test.ts`
**Category:** coverage

`isInputPrompt` is removed from production (`TriageStatus` is now `"running" | "idle"` only). The test file correctly removes all `isInputPrompt` tests. The `api.test.ts` rename of "classifies needs-input" → "classifies idle" with updated assertion is correct behavior lock-in for the intentional `needs-input` removal. No action needed.

### [TEST-09] ralph-worktree.test.ts gpgsign fix is correct
**Severity:** info
**File(s):** `tests/unit/ralph-worktree.test.ts:11`
**Category:** correctness

Added `-c commit.gpgsign=false` to git invocations. Prevents CI hang on machines with global GPG signing configured. Correct fix, no action needed.

### [TEST-10] escaping.test.ts escAttr inline copy updated in sync with production
**Severity:** info
**File(s):** `tests/unit/escaping.test.ts:22-33`
**Category:** mirror

The inline `escAttr` copy in the test was updated to match the `\n`, `\r`, `\t` escaping added to `public/app-state.ts`. Both are now in sync. Pre-existing mirror pattern (FE-2/complexity.md). Future changes to `app-state.ts` still require manual sync.

### [TEST-11] validation.test.ts stale inline replica — not addressed, pre-existing
**Severity:** info
**File(s):** `tests/unit/validation.test.ts` (unchanged)
**Category:** mirror

Pre-existing: inline copies of `isValidSessionName`, `isValidProjectName`, etc. not imported from `src/`. `validation-extracted.test.ts` + `validation-fuzzing.test.ts` cover the real code. Out of scope for this PR but still present.

### [TEST-12] ralph-api.test.ts hand-rolled server mirror — not addressed, pre-existing
**Severity:** info
**File(s):** `tests/integration/ralph-api.test.ts` (unchanged)
**Category:** mirror

1683-LOC hand-rolled server reimplementing ralph route handlers (complexity.md finding). This PR fixed the equivalent pattern in `api.test.ts` but not `ralph-api.test.ts`. Out of scope; track separately.

## Verdict

**Approve with required fixes:**

- TEST-01 (required): Add `_testing.notifyTimestamps = []` to `beforeEach` in notify test block in `api.test.ts`
- TEST-02 (required): Wrap subscription cap test body in `try/finally` for cleanup
- TEST-03 (recommended): Strengthen session-unavailable test to assert rejection rather than accept any outcome
- TEST-07 (recommended): Replace fixed `sleep()` in `pty-backend.test.ts` with poll-based waits

Pre-existing debt in `validation.test.ts` and `ralph-api.test.ts` remains but was not introduced by this PR.
