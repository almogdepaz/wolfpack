# Review: dev

**Date:** 2026-04-16T17:05:19Z
**HEAD:** 5e1f434bf48aa08ab7f5d7a4a311d66d20a44120
**Modules reviewed:** .context public root src tests 

---

## Module: `.context`

# Review Report: .context module — PR #106

## Summary

The `.context/` documentation was rebuilt in this session (commit `5e1f434`) via `edc-build`, replacing the old 5-module layout (`server.md`, `client.md`, `core.md`, `ralph.md`, `cli.md`) with a 12-module layout. The rebuild is internally consistent and the `.meta.json` `lastCommit` matches `HEAD`. However, 9 of the 12 new per-module context files and the new `context.md` root index are **untracked** (never committed), so the review task file was generated from a stale git diff and missed the majority of new modules. Three post-fix accuracy issues were found in `push.md` and `frontend.md`.

---

## Findings

### [CTX-01] Nine new context modules are untracked — review task file only covers old structure
**Severity:** high
**File(s):** `.context/auth.md`, `.context/build.md`, `.context/frontend.md`, `.context/push.md`, `.context/server-core.md`, `.context/session-backends.md`, `.context/shared.md`, `.context/validation.md`, `.context/websocket.md`, `context.md` (repo root)
**Description:** `git status` shows these 9 new per-module context files and the new `context.md` root index as untracked (`??`). The edc-review orchestrator uses `git diff main..HEAD --name-only` to enumerate changed files; untracked files are invisible to this command. As a result, the review task file listed only the 7 modified + 4 deleted old files and omitted the 9 new modules entirely.
**Impact:** Auth, Validation, Server Core, WebSocket, Session Backends, Push, Frontend, Shared, and Build context files were not included in any review task — roughly 75% of the new documentation is unreviewed by the orchestrated workflow.
**Suggested fix:** Stage and commit all new `.context/` files and `context.md` before running `edc-review`. Run `git add .context/ context.md && git commit -m "chore: commit rebuilt edc context"`, then regenerate review tasks.

---

### [CTX-02] push.md: `hkdfSha256` described as "documented constraint" — now an enforced guard
**Severity:** low
**File(s):** `.context/push.md:77`, `src/server/push.ts:244`
**Description:** `push.md` states: *"`hkdfSha256` is limited to 32-byte output (single HMAC block). Documented constraint; correct for AES-128-GCM key (16) and nonce (12) derivation."* Commit `5e1f434` added an explicit `throw` at `push.ts:244`: `if (length > 32) throw new Error(...)`. The constraint is no longer merely documented — it is actively enforced at runtime.
**Impact:** Documentation understates the safety guarantee. A reader of `push.md` may incorrectly believe the limit is advisory; the code now hard-fails on violation.
**Suggested fix:** Update `push.md` line 77 to: *"`hkdfSha256` enforces a 32-byte output limit via a runtime `throw` — single HMAC block only. Correct for AES-128-GCM key (16) and nonce (12) derivation."*

---

### [CTX-03] push.md: `derToRaw` description omits post-fix validation throws
**Severity:** low
**File(s):** `.context/push.md:78`, `src/server/push.ts:212-226`
**Description:** `push.md` states: *"`derToRaw` handles P-256 DER signatures only. P-256 sigs are always < 128 bytes, so multi-byte BER length encoding cannot occur."* Commit `5e1f434` added explicit validation: `derToRaw` now throws on invalid DER header (`der[0] !== 0x30`), missing INTEGER tags, and length overflow. The description implies correctness is guaranteed by invariant; the code now actively validates.
**Impact:** Understates the hardening; readers may not realize the function will now surface errors on corrupted or attacker-crafted DER blobs rather than silently misbehaving.
**Suggested fix:** Update `push.md` line 78: *"`derToRaw` validates DER header, INTEGER tags, and length bounds — throws on malformed input. P-256 DER signatures are always < 128 bytes so no multi-byte BER length encoding occurs."*

---

### [CTX-04] frontend.md: `escAttr` character list incomplete — missing `\t` tab escape
**Severity:** low
**File(s):** `.context/frontend.md:50`, `public/app-state.ts:21`
**Description:** `frontend.md` documents `escAttr` as escaping `\`, `'`, `"`, `<`, `>`, `&`, and newlines. Commit `5e1f434` added `.replace(/\t/g, "\\t")` to `escAttr` (HIGH-02 fix). The `\t` tab escape is absent from the documentation.
**Impact:** Minor doc drift. Readers building new `onclick` attribute patterns may not account for tab characters in user-supplied values.
**Suggested fix:** Update `frontend.md` line 50: *"Escapes `\`, `'`, `"`, `<`, `>`, `&`, newlines, and tabs."*

---

### [CTX-05] issues.md: SERV-4 and CLI-1 are duplicate entries for the same issue
**Severity:** low
**File(s):** `.context/issues.md:54-57`, `.context/issues.md:138-141`
**Description:** `SERV-4` ("serviceStop auth gap", under Server Core) and `CLI-1` ("serviceStop unauthenticated localhost call", under CLI) describe the same root cause with nearly identical text. Both note `serviceStop()` in `src/cli/service.ts` calls `/api/backend` without an auth header, yielding 401 and confusing UX. Neither entry notes the partial UX improvement from `5e1f434` (now prompts user to confirm before stopping when count is unavailable).
**Impact:** Duplicate entries create review noise and risk one copy being marked fixed while the other persists as if open.
**Suggested fix:** Remove `CLI-1`. Update `SERV-4` to note the `5e1f434` UX improvement and that the root gap (no auth header) remains.

---

### [CTX-06] Meta freshness: `lastCommit` matches HEAD — context is fresh
**Severity:** info
**File(s):** `.context/.meta.json:2`
**Description:** `.meta.json` `lastCommit` = `5e1f434bf48aa08ab7f5d7a4a311d66d20a44120` = `git rev-parse HEAD`. The `--check-context` assertion will pass.
**Impact:** None. Noted for completeness.
**Suggested fix:** N/A.

---

### [CTX-07] coverage gap: `src/wolfpack-client-lib.ts` not tracked in `.meta.json` modules
**Severity:** info
**File(s):** `.context/.meta.json`, `src/wolfpack-client-lib.ts`
**Description:** `wolfpack-client-lib.ts` is the barrel entry point re-exporting `terminal-buffer.ts`, `terminal-input.ts`, `grid-logic.ts`, `take-control-logic.ts`, `reconnect-hydration.ts` for bundling into `public/wolfpack-lib.js`. Referenced in `full-context.md` and `build.md` but not tracked in any `.meta.json` module, so changes won't trigger a stale-context signal.
**Impact:** Very low — pure re-export barrel with no logic. Content changes would be caught via the modules it re-exports.
**Suggested fix:** Optionally add to `build` module files in `.meta.json`, or leave as-is.

---

## Verdict

Meta freshness: PASS (lastCommit = HEAD). Internal consistency: PASS — `context.md` module index matches on-disk `.context/` files, and `.meta.json` module registry aligns with `context.md`. Line number spot-checks pass (auth.ts:81, 98, 143-146, 184; routes.ts:134, 657; http.ts:142-179; push.ts:101, 125) within ±2 lines. The critical finding (CTX-01) is a workflow gap — 9 new context modules are on disk but uncommitted, making them invisible to `git diff`-based review tooling. CTX-02/03/04 are minor post-fix doc drift from commit `5e1f434`. No claim was found to be factually wrong against source code.

---

## Module: `public`

# Review Report: public/ module — PR #106

## Summary

Large diff (~870 lines): push notification infrastructure (new `sw-push.js`, reworked `requestNotifications`/`unsubscribeNotifications`), scroll-lock monkey-patch for ghostty-web, `_term.reset()` vs `clear()` fix, `useClassicMobile()` hardcoded `false`, binary running/idle triage, snapshot-key ordering fix, backend toggle UI, `AbortSignal.timeout` for remote machines, DOM dispose ordering fixes. No critical issues. Most of the push notification subsystem has correctness gaps.

## Diff Scope

- `public/app-state.ts` — push subscribe/unsubscribe logic, `syncNotificationsPermission`
- `public/app.ts` — scroll-lock, `_term.reset()`, classic-mobile disable, snapshot key ordering, `AbortSignal.timeout`, visibility guard removal
- `public/app-grid.ts` — `suspendGridMode` dispose ordering fix
- `public/sw-push.js` — new service worker for push notifications
- `public/index.html`, `public/styles.css` — minor UI updates
- `public/app-ralph.ts` — minimal changes

## Findings

### [PUB-01] `syncNotificationsPermission` bypasses `toggleSetting` — server subscription leaks on OS-level permission revoke
**Severity:** medium
**File(s):** `public/app-state.ts:346-357`
**Category:** correctness / invariant (FE-3)

When browser notification permission is revoked externally (OS settings), `syncNotificationsPermission` directly writes `wpSettings.notifications = false` and hand-serializes `localStorage`, bypassing `toggleSetting()`. The invariant (FE-3, frontend.md) is that settings mutations MUST go through `toggleSetting()`. The critical effect: `toggleSetting("notifications", false)` would call `applySetting("notifications", false)` → `unsubscribeNotifications()` → `POST /api/push/unsubscribe`. The direct write skips this. Server holds a stale active push endpoint after every external permission revoke; pushes are silently discarded by the browser but the server continues sending them.

**Impact:** Server accumulates stale push subscriptions; wastes bandwidth and increases attack surface.

**Suggested fix:** Call `toggleSetting("notifications", false); state.notificationsEnabled = false;` instead of the direct write.

### [PUB-02] Push `fetch()` calls bypass JWT on JWT-gated deployments
**Severity:** medium
**File(s):** `public/app-state.ts:178, 193, 219`
**Category:** security / correctness

`requestNotifications()` and `unsubscribeNotifications()` call `fetch("/api/push/vapid-key")`, `fetch("/api/push/subscribe")`, and `fetch("/api/push/unsubscribe")` directly. All three are `/api/*` paths; `shouldAuthenticateApiPath` returns `true` for all `/api/*` except `/api/info`. On a JWT-configured deployment, all three return 401, push subscription silently fails in console, user sees toggle flip but is never subscribed.

Note: the `api()` helper in `app.ts` also omits JWT injection (confirmed by reading `app.ts:1437-1455`). The whole app relies on JWT being disabled (AUTH-1 default). This is a pre-existing design gap, but the new push functions in `app-state.ts` can't even import `api()` (different module), making it worse. On any deployment with `WOLFPACK_JWT_SECRET` configured, push notifications are dead on arrival.

**Impact:** Push notifications non-functional on any auth-enabled deployment.

**Suggested fix:** Move push logic into `app.ts` where `api()` is accessible. Long-term: `api()` should inject JWT from localStorage.

### [PUB-03] `unsubscribeNotifications` — server call failure leaves browser subscription active
**Severity:** low
**File(s):** `public/app-state.ts:211-232`
**Category:** correctness

`await fetch("/api/push/unsubscribe")` runs before `await sub.unsubscribe()`, both inside one `try/catch`. If the server call throws (network error, 4xx), catch swallows it and returns without calling `sub.unsubscribe()` — browser subscription stays active, `state.notificationsEnabled` stays `true`, user thinks they've unsubscribed.

**Impact:** Unsubscribe UX broken on transient network errors.

**Suggested fix:** Unsubscribe browser-side unconditionally; treat server removal as best-effort:
```ts
await sub.unsubscribe();
state.notificationsEnabled = false;
fetch("/api/push/unsubscribe", { method: "POST", ... }).catch(() => {});
```

### [PUB-04] `checkStateTransitions` visibility guard removed — haptic fires on foreground transitions
**Severity:** low
**File(s):** `public/app.ts:2802-2821`
**Category:** UX regression

Old code: `if (document.visibilityState === "visible") return;`. Removed in this PR. Haptic `[200, 100, 200]` now fires every time a session transitions `running → idle` even when the user is actively watching the session list. The guard existed specifically to avoid vibrating the phone when the transition is already visible. Also the `state.notificationsEnabled` guard was removed — haptic now fires whenever `wpSettings.notifications` is true regardless of whether push subscription succeeded.

**Impact:** Annoying buzzing when user is already looking at the session list.

**Suggested fix:** Restore the visibility guard, at minimum for the haptic call.

### [PUB-05] `AbortSignal.timeout` — unavailable on iOS 15 Safari
**Severity:** low
**File(s):** `public/app.ts:1744`
**Category:** correctness

`AbortSignal.timeout(5000)` is used in `fetchMachine` for remote machine requests. Available since Safari 16 (iOS 16+). On iOS 15, `AbortSignal.timeout` is `undefined` — calling it throws `TypeError`. The whole `fetchMachine` call aborts, showing the machine as offline.

**Impact:** Remote machines appear offline on iOS 15.

**Suggested fix:** `typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(5000) : undefined`

### [PUB-06] `sw-push.js` — `client.url.includes(origin)` should be `startsWith`
**Severity:** low
**File(s):** `public/sw-push.js:24`
**Category:** security (cosmetic in SW context)

```js
if (client.url.includes(self.location.origin) && "focus" in client)
```
`.includes()` matches if the origin appears anywhere in the client URL. In a SW context all clients are same-origin so this is effectively harmless — cross-origin pages can't be controlled by this SW. But semantics are wrong.

**Impact:** Currently harmless, but incorrect intent.

**Suggested fix:** `client.url.startsWith(self.location.origin)`

### [PUB-07] `app-grid.ts` dispose ordering — `suspendGridMode` fix correct, minor caveat
**Severity:** info
**File(s):** `public/app-grid.ts:389-395`
**Category:** correctness

Fix is sound: `controller.dispose()` before `_cellElement.remove()` matches `dispose()`'s internal use of `_container.removeEventListener`. The loop iterates `for (const gs of state.gridSessions)` then `state.gridSessions = []` — safe, loop completes first. `_cellElement` is nulled even in suspend (not just remove), meaning `restorePreservedGrid` must re-create cells from scratch — consistent with existing behavior.

### [PUB-08] `useClassicMobile()` hardcoded `false` — dead code kept
**Severity:** info
**File(s):** `public/app.ts:12-19`
**Category:** correctness

`useClassicMobile()` returns `false`; all classic mobile paths (`initClassicMobile`, `handleTerminalWs`, `applyTerminalPane`, `destroyClassicMobile`, `startClassicPolling`) are dead. The PR comment says "cleanup in follow-up PR" — acceptable. Verified the event listeners inside these functions are registered lazily (inside `initClassicMobile`), so they don't attach at boot.

### [PUB-09] `applyTerminalPane` search highlight — correct fix
**Severity:** info
**File(s):** `public/app.ts:3864-3883`
**Category:** security

The old `esc(pane).replace(re, m => \`<mark>${m}</mark>\`)` ran the regex on HTML-escaped text, which could split `&amp;` and produce broken HTML. New approach: run regex on raw `pane`, then `esc()` each segment. This is correct — `match[0]` is raw text, `esc()` applied to it is safe. No finding; confirming this fix is sound.

### [PUB-10] `destroyTerminal` always calls `flushSnapshot()` — risk of empty-snapshot eviction
**Severity:** info
**File(s):** `public/app.ts:2343-2348`
**Category:** correctness

`flushSnapshot()` is now always called in `destroyTerminal()` regardless of whether `snapshotTimer` was pending. If called before a terminal was ever created (`state.terminalController === null`), `flushSnapshot()` may write an empty snapshot under `state.currentSession`'s key, evicting a valid cached snapshot. Risk is low if `flushSnapshot()` guards against null controller, but should be confirmed.

### [PUB-11] `openSession` snapshot-key ordering fix — correct
**Severity:** info
**File(s):** `public/app.ts:1893-1897`
**Category:** correctness

Moving `destroyTerminal()` before `setState({ currentSession: name })` is correct: `flushSnapshot()` inside `destroyTerminal()` uses `state.currentSession` as the key. Old order would save the OLD terminal's content under the NEW session's key. Fix is sound.

## Verdict

**Approve with fixes for PUB-01 through PUB-04.** The ghostty-web workarounds, dispose ordering, snapshot key fix, search highlight fix, and force-reconnect changes are all correct and well-commented. The push notification subsystem has four correctness/UX gaps that should be addressed before merge, particularly PUB-01 (stale server subscriptions on permission revoke) and PUB-02 (push broken on JWT deployments).

---

## Module: `root`

# Review Report: root files — PR #106

## Summary

5 root-level files changed: `README.md` updated for dual-backend architecture, `install.sh` significantly simplified (removed auto-install logic), and 3 review/diff docs added then deleted (net: they are absent in working tree but present in the diff as additions from `main`'s perspective — git diff `main...HEAD` shows them being added, but `git status` marks them deleted in the worktree because they were subsequently removed by later commits).

**Overall verdict:** APPROVE with minor docs fixes. No security regressions. The install.sh simplification is a net positive. README has 3 stale doc references that should be corrected.

---

## Diff Scope

| File | Change | Lines |
|------|--------|-------|
| `README.md` | Modified — dual-backend docs, security section, config update | +71/-8 |
| `install.sh` | Modified — removed auto-install logic, added security hints | +18/-125 |
| `DIFFERENTIAL_REVIEW_REPORT.md` | Added in branch (deleted in working tree — review artifact) | +126 |
| `REVIEW-DEV-VS-MAIN.md` | Added in branch (deleted in working tree — review artifact) | +401 |
| `REVIEW-PR106.md` | Added in branch (deleted in working tree — review artifact) | +110 |

Review artifacts (`DIFFERENTIAL_REVIEW_REPORT.md`, `REVIEW-DEV-VS-MAIN.md`, `REVIEW-PR106.md`) are deleted from the working tree in the tip commit of `dev` — they were added in earlier commits and removed before merge. Git diff from `main` still shows them as additions because `main` has none of them. The deletion is correct housekeeping; no concern.

---

## Findings

### [ROOT-01] README feature list references removed `needs-input` triage state
**Severity:** low
**File(s):** `README.md:168`
**Category:** docs
**Description:**
The Features → Session Management bullet still reads: `Session triage — running, idle, and needs-input states with color-coded indicators`. The `needs-input` triage state and `isInputPrompt()` were removed from `src/triage.ts` in this PR (triage is now binary `running | idle`). The README was not updated to match.
**Impact:** Users who search for `needs-input` behavior based on the README will find it absent. Minor accuracy issue; no security impact.
**Suggested fix:** Change to `Session triage — running and idle states with color-coded indicators` (or a description matching the new binary model).

---

### [ROOT-02] README Desktop section mentions xterm.js but desktop terminal uses ghostty-web
**Severity:** low
**File(s):** `README.md:174`
**Category:** docs
**Description:**
`- **xterm.js PTY** — full terminal emulator with direct PTY connection (not capture-pane polling)` — xterm.js is not used. The desktop terminal is `ghostty-web.bundle.js` (ghostty-web 0.4.0). The `ghostty-web.bundle.js` includes an xterm.js compatibility shim internally, but from the user/docs perspective the terminal is ghostty-web, not xterm.js. The Mobile section correctly references ghostty-web WASM.
**Impact:** Inaccurate documentation. Users familiar with xterm.js won't find it; the bundle name is `ghostty-web.bundle.js`.
**Suggested fix:** Change to `- **ghostty-web PTY** — full terminal emulator with direct PTY connection (not capture-pane polling)`

---

### [ROOT-03] README Mobile section says Classic is default; code changed default to wasm
**Severity:** low
**File(s):** `README.md:183`, `public/app-state.ts:72`
**Category:** docs
**Description:**
`README.md:183` reads: `- **Classic** (default) — lightweight capture-pane polling.` But `public/app-state.ts:72` now sets `mobileTerminal:"wasm"` as the default (changed from `"classic"` in main). The README was not updated. This is also noted as LOW-04 in `REVIEW-DEV-VS-MAIN.md` as a behavioral change with no migration path.
**Impact:** New users reading the README expect Classic as default; they get WASM. Mismatch between docs and code.
**Suggested fix:** Update to remove "(default)" from Classic and add "*(default)*" to the Ghostty (WASM) entry.

---

### [ROOT-04] README Security section says raw IP "won't work" — imprecise, potentially misleading
**Severity:** info
**File(s):** `README.md:216`, `install.sh:213,222`
**Category:** docs
**Description:**
The README security section correctly explains: raw IP access bypasses CORS but still works. The install.sh post-install message says: `not your machine's IP (it won't work)`. These conflict: raw IP does work; it just reduces security. `install.sh` overstates the constraint.
**Impact:** User confusion rather than security gap. The README is accurate; install.sh is not.
**Suggested fix:** Change `install.sh:213,222` parenthetical from `(it won't work)` to `(bypasses CORS protection)`.

---

### [ROOT-05] `install.sh` uses `set +e` with silent failure on service-upgrade path
**Severity:** low
**File(s):** `install.sh:14`, `install.sh:155-162`
**Category:** security
**Description:**
`set +e` disables exit-on-error for the entire script. Download, chmod, codesign, and symlink steps all have explicit `if !` guards. However, the service-upgrade block (lines 155-162) swallows a failed `service install` with a dim message and continues. Not a regression from `main`, but the removal of the large auto-install block makes this pattern more visible.
**Impact:** A failed service upgrade during a re-install is not surfaced to the operator. Low impact since the final `exec wolfpack setup` step would expose the issue.
**Suggested fix:** Add an explicit failure message to the service restart command or add `set -u` for uninitialized variable protection.

---

### [ROOT-06] Review artifact docs deleted from working tree — confirm staged before merge
**Severity:** info
**File(s):** `DIFFERENTIAL_REVIEW_REPORT.md`, `REVIEW-DEV-VS-MAIN.md`, `REVIEW-PR106.md`
**Category:** hygiene
**Description:**
`git status` shows `D` (deleted) for all three review files. These were generated review artifacts committed to `dev` during the review cycle and later deleted. This is correct housekeeping — they should not appear in `main`.
**Impact:** None if deletions are committed. Confirm they are staged (not just working-tree changes) before merging.
**Suggested fix:** Run `git status` to verify deletions are committed to the branch tip, not just working-tree. Run `git add -u` and commit if needed.

---

## Verdict

**APPROVE with minor fixes.**

The dual-backend README additions are accurate and well-written. The install.sh simplification (removing auto-install logic and the `curl | sudo sh` Tailscale install pattern) is the right call — it was a footgun with no hash verification and a hard brew/apt dependency. The security hints added post-install are useful.

Must fix before merge:
- ROOT-03 (code/docs mismatch on mobile terminal default — new users get WASM, README says Classic)

Recommended:
- ROOT-01 (stale `needs-input` reference — one-line fix)
- ROOT-02 (xterm.js reference — one-line fix)
- ROOT-04 (conflicting install.sh phrasing)

Informational only (no action required):
- ROOT-05, ROOT-06

---

## Module: `src`

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

---

## Module: `tests`

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

---

