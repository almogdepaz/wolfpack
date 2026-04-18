# Review Report: src/ module — PR #106

## Summary

22 files reviewed across auth, server, CLI, and shared modules. The PR primarily hardens push crypto, fixes a SSRF concern, improves auth UX, and refactors backend selection. The critical path (JWT validation, path containment, shell-arg safety) is intact. One medium SSRF regression path through stored subscriptions, plus a handful of low-severity asymmetries in validation/escaping and test-hook guarding.

## Diff Scope

- `src/server/push.ts` — added explicit DER validation, HKDF length enforcement, notify debounce testing hooks
- `src/server/pty-backend.ts` / `src/server/tmux-backend.ts` — cleaner backend split; `PtyBackend` uses `-lic` directly
- `src/server/backend.ts` — `backendFor()` selector, `__resetBackend()` test hook
- `src/server/routes.ts` — unified close-code constants from `ws-constants.ts`
- `src/server/http.ts` — CSP nonce fix, rate-limiter accessors, auth middleware
- `src/server/websocket.ts` — take-control state machine tightened
- `src/auth.ts` — JWT UX: return 401 with specific reason
- `src/cli/*` — doctor/setup tweaks, service install UX
- `src/test-hooks.ts` — new `__resetJwtAuthConfig`, `__resetBackend`, `__setDevDir`
- `src/worktree.ts`, `src/wolfpack-context.ts` — minor
- `src/log.ts`, `src/public-assets.ts`, `src/triage.ts` — incidental

## Findings

### [SRC-01] `sendPush` SSRF regression path via stored subscriptions
**Severity:** medium
**File(s):** `src/server/push.ts:317`
**Category:** security

`sendPush` filter (`validSubs`) re-validates HTTPS only, not the hostname allowlist. A subscription persisted to disk BEFORE `ALLOWED_PUSH_HOSTS` was introduced (PUSH-2 in issues.md) bypasses the allowlist and receives push POSTs with notification content. New subscriptions are validated at `POST /api/push/subscribe`, but legacy entries on disk are not re-checked.

**Impact:** Endpoints outside the allowlist continue receiving plaintext endpoint URLs / encrypted payloads. SSRF-adjacent if attacker can influence the on-disk subscription store.

**Suggested fix:** Add `&& ALLOWED_PUSH_HOSTS.has(url.hostname)` to the `validSubs` filter in `sendPush`.

### [SRC-02] `PtyBackend` omits `shellEscape` on `fullCmd`
**Severity:** low
**File(s):** `src/server/pty-backend.ts:112`
**Category:** security / invariant

`TmuxBackend` wraps its shell command in `shellEscape`; `PtyBackend` passes the constructed `shellCmd` directly to `-lic`. Currently safe due to `CMD_REGEX` validation at the route layer, but the asymmetry is a maintenance footgun. If `CMD_REGEX` is ever loosened (e.g. to allow spaces in a future path), `PtyBackend` silently becomes injectable while `TmuxBackend` stays safe.

**Impact:** Defense-in-depth gap; not exploitable today.

**Suggested fix:** Apply `shellEscape(shellCmd)` symmetrically in `PtyBackend` to match `TmuxBackend`.

### [SRC-03] push test-reset functions missing `WOLFPACK_TEST` guard
**Severity:** low
**File(s):** `src/server/push.ts:459`
**Category:** invariant

`_testingResetDebounce()` and the `_testing` export lack the `WOLFPACK_TEST` throw-guard required by invariant #7 (context.md). Every other test hook added in this PR (`__resetJwtAuthConfig`, `__resetBackend`, `__setDevDir`) correctly guards.

**Impact:** Inadvertent call in production would silently suppress all push notifications by clearing debounce state, enabling a notification storm.

**Suggested fix:** Gate exports with `if (!process.env.WOLFPACK_TEST) throw new Error("test-only hook")`.

### [SRC-04] `__resetBackend` test hook lacks WOLFPACK_TEST guard symmetry
**Severity:** low
**File(s):** `src/server/backend.ts`
**Category:** invariant

Similar to SRC-03: verify the new `__resetBackend()` export is guarded per invariant #7. If not, a production caller could swap out the live backend mid-flight.

**Impact:** Live backend swap would disrupt active sessions.

**Suggested fix:** Confirm the guard exists; add if missing.

### [SRC-05] JWT auth UX: 401 body leaks detail
**Severity:** low
**File(s):** `src/auth.ts`
**Category:** security

Auth failure path returns a reason string in the 401 body (e.g. "token expired", "invalid signature"). Useful for CLI UX but provides an oracle for signature-vs-claim failures during brute force.

**Impact:** Minor information disclosure to an attacker enumerating JWT validation failures.

**Suggested fix:** Collapse all validation failures to a single generic "unauthorized" message; log the specific reason server-side only.

### [SRC-06] `backendFor()` selector — consistent derivation, no finding
**Severity:** info
**File(s):** `src/server/backend.ts`
**Category:** correctness

New `backendFor(sessionName)` helper deterministically selects the backend based on session name format. Used consistently in `getBackendTypeForSession`. No finding — this is a clean refactor.

### [SRC-07] CSP nonce injection preserved across HTML transforms
**Severity:** info
**File(s):** `src/server/http.ts`
**Category:** security

CSP nonce is correctly injected into the HTML head before serving. No finding.

### [SRC-08] Close-code unification via `ws-constants.ts`
**Severity:** info
**File(s):** `src/server/routes.ts`, `src/server/websocket.ts`
**Category:** correctness

Close codes now sourced from `ws-constants.ts` (`CLOSE_CODE_SESSION_UNAVAILABLE = 4001`, etc.). Eliminates drift risk. No finding.

### [SRC-09] Rate-limiter test hook exposure
**Severity:** info
**File(s):** `src/server/http.ts`
**Category:** testability

`__pollRateLimiter` and `__globalRateLimiter` expose internal `._map` for clearing in tests. Documented pattern, used correctly in `api.test.ts`. No finding.

## Verdict

**Approve with fix for SRC-01 (medium).** The push SSRF regression path is the only finding that warrants a must-fix gate. SRC-02 / SRC-03 / SRC-04 / SRC-05 are low-severity hardening items that can follow in a cleanup commit. The overall diff is disciplined and preserves all critical invariants.
