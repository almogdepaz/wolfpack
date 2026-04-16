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
