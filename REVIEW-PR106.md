<!-- Differential Review — PR #106: dev → main -->
# Differential Review: PR #106

**Branch:** dev → main
**Scope:** 62 files, +5406/-919 lines
**Reviewed:** 2026-04-06

---

## Critical / High

### FIND-01 — sw.js route always 404 (broken Map access)
- **Severity:** HIGH
- **File:** `src/server/routes.ts:240`
- **Description:** `assets["sw-push.js"]` uses bracket notation on a `Map`. Should be `assets.get("sw-push.js")`. Always returns `undefined` → service worker endpoint silently broken → push notifications can never register.
- **Status:** NEW — must fix before merge

---

## Medium

### FIND-02 — SSRF via push subscription endpoint
- **Severity:** MEDIUM
- **File:** `src/server/push.ts:315`
- **Description:** `sendPush` fetches `sub.endpoint` (user-supplied URL). Validation enforces HTTPS + 1024 char max, but any authenticated user can make the server POST to arbitrary HTTPS endpoints with a signed VAPID JWT. Mitigated by JWT auth requirement.
- **Recommendation:** Restrict endpoints to known push service domains (fcm.googleapis.com, updates.push.services.mozilla.com, etc.) or document the trust model.

### FIND-03 — safeTriage() regression (ISS-04 worsened)
- **Severity:** MEDIUM
- **File:** `public/app.ts:1712, 3521`
- **Description:** `safeTriage(s.triage || "idle")` call sites replaced with `esc()`, which doesn't sanitize CSS class names. A server returning `triage: "idle injected-class"` would inject arbitrary CSS classes. `safeTriage()` is now dead code.
- **Status:** NEW regression — ISS-04 was previously mitigated, now broken again
- **Fix:** Restore `safeTriage()` at both call sites

### FIND-04 — sw-push.js opens server-controlled URL
- **Severity:** MEDIUM
- **File:** `public/sw-push.js:16`
- **Description:** `clients.openWindow(event.notification.data?.url || "/")` — URL from push payload. If push payload is compromised, user navigates to attacker URL.
- **Fix:** Validate `url` is same-origin or starts with `/`

---

## Low

### FIND-05 — Push state maps partial cleanup
- **File:** `src/server/push.ts:359-421`
- **Description:** `lastPushTime` shared between session and ralph transitions with different key namespaces. Ralph keys (`ralph-${project}`) only cleaned by `checkRalphLoopTransitions`. If that stops being called, entries leak. Bounded by project count.

### FIND-06 — Subscription file write not atomic
- **File:** `src/server/push.ts:111`
- **Description:** `writeFileSync` directly — crash during write corrupts file. Write-to-temp-then-rename is more robust.

### FIND-07 — `__resetJwtAuthConfig` missing WOLFPACK_TEST guard
- **File:** `src/auth.ts:195`
- **Description:** Every other `__` test hook guards with `process.env.WOLFPACK_TEST`. This one doesn't. Inconsistent.

### FIND-08 — `renderMachinesList` still concatenates URL (ISS-03 remnant)
- **File:** `public/app.ts:3228`
- **Description:** `m.url + "/api/info"` — string concatenation while `api()` was fixed to use `new URL()`. Inconsistent.

### FIND-09 — Desktop wake force-reconnect all sessions
- **File:** `public/app.ts:2853-2863`
- **Description:** Changed from connect-if-disconnected to unconditional force-reconnect on tab return after 60s. All grid cells + main terminal reconnect simultaneously. May cause brief content flash.

---

## Info (Positive)

- **escAttr() hardening** — `\n`/`\r` escaping added, closes theoretical attribute injection vector
- **openSession() snapshot fix** — `destroyTerminal()` before `setState()` prevents cross-session snapshot contamination
- **ISS-18 (rate limiter)** — Fixed with 10K IP cap + insertion-order eviction
- **ISS-01 (peer name sanitization)** — Fixed with `sanitizePeerName`
- **ISS-14 (attach_ack timer)** — Mitigated via `_lastSentResize` dedup
- **Test quality** — Strong: real crypto verification, real PTY spawning, real HTTP integration. No mock theater.

---

## Complexity Cross-Reference

| Flag | Status |
|------|--------|
| app.ts size | Grew 3,942 → 4,096 lines (+3.9%). Continues accreting. |
| Dead exports | `safeTriage()` + `VALID_TRIAGE` now dead (FIND-03 regression) |
| New wrappers | None concerning |
| Test mirroring | No new production logic copied into tests |

---

## Pre-Existing Issues (unchanged)

| Issue | Status |
|-------|--------|
| ISS-06: shellEscape NUL bytes | Not addressed |
| ISS-08: classifyDisconnect string contract | Not addressed |
| ISS-13: log.ts extra key collision | Not addressed |
| ISS-15: cleanupAllExceptFinal no mutex | Not addressed |
| ISS-23: Tailscale CORS header trust | Unchanged, documented |

---

## Verdict

**3 findings must be addressed before merge:**
1. FIND-01 (HIGH) — Map bracket access breaks push entirely
2. FIND-03 (MEDIUM) — safeTriage regression re-introduces ISS-04
3. FIND-04 (MEDIUM) — sw-push.js URL validation

FIND-02 (SSRF) is acceptable with documentation if push endpoints are restricted to authenticated users only (which they are).

Everything else is low/info — overall code quality is high, test coverage is strong, and the architectural changes (backend abstraction, push system) are well-structured.
