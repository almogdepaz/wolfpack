# Differential Review — Commit 5e08973

**Date:** 2026-03-30
**Scope:** `HEAD~1..HEAD` (14 files, +439/-72 lines)
**Modules affected:** server, client, cli, tests

---

## Verdict: APPROVE — no blocking issues

One incomplete fix (escAttr test sync) and one documented trust assumption (Tailscale CORS). Everything else is correct and well-tested.

---

## Findings

### FIND-01: escAttr test copy out of sync (MEDIUM)

**File:** `tests/unit/escaping.test.ts:22-30`
**Status:** Pre-existing pattern, worsened by this commit

The commit adds `\n`/`\r` escaping to `escAttr()` in `public/app-state.ts`, but the test file maintains its own copy of `escAttr` that is **not updated**. Tests will pass against the old implementation, missing regressions on the new escaping.

**Fix:** Update the test copy to include `.replace(/\n/g, "\\n").replace(/\r/g, "\\r")`, or better — extract `escAttr` to a shared isomorphic module (already flagged in `complexity.md` as test mirroring duplication).

---

### FIND-02: Tailscale CORS origin recovery trust model (HIGH — accepted risk)

**File:** `src/server/index.ts:107-125`
**Status:** New code, documented assumption

Reconstructs `Origin` from `Referer` when `Tailscale-User-Login` header is present. Trust relies on that header being unforgeable — true when traffic flows through `tailscale serve`, false if wolfpack is ever behind a different reverse proxy.

**Mitigations present:**
- HTTPS-only referer (`refUrl.protocol === "https:"`)
- Tailnet suffix match on hostname
- Explicit trust model comment in code

**Gaps:**
- No integration tests for this path (flagged as ISS-24)
- WS upgrade path does NOT apply recovery (may be intentional — stricter for WS)
- No startup warning when TAILNET_SUFFIX is configured

**Verdict:** Acceptable given current deployment model (127.0.0.1 bind + tailscale serve). Would become a CORS bypass under different proxy topologies.

---

### FIND-03: Search highlight XSS fix — correct (HIGH, fixed)

**File:** `public/app.ts:3810-3823`
**Status:** Pre-existing vuln, now fixed

Old code: `esc(pane).replace(re, m => ...)` — regex on escaped HTML could split entities. New code: regex on raw text, `esc()` applied per-segment before innerHTML insertion. Correct fix.

---

### FIND-04: PTY exit callback name-reuse race — correct (MEDIUM, fixed)

**File:** `src/server/pty-backend.ts:129`
**Status:** Pre-existing race, now guarded

Guard `session.proc === proc` prevents stale exit callback from deleting a replacement session with the same name. Closure captures `proc` identity at spawn time.

---

### FIND-05: Event listener cleanup — correct (MEDIUM, fixed)

**Files:** `public/app.ts:956-976, 1119-1128`, `public/app-grid.ts:389-393, 529-534`

Two changes:
1. `dispose()` now removes `_scrollLockKeydownHandler` and `_browserShortcutKeydownHandler` via stored references
2. Grid dispose order changed: controller before DOM (dispose needs container for `removeEventListener`)

All `addEventListener` calls in app.ts and app-grid.ts verified — no remaining leaks.

---

### FIND-06: execSync → execFileSync — correct (MEDIUM, fixed)

**File:** `src/cli/service.ts:351-352`

Eliminates shell interpolation of `config.port` in curl command. All 17 remaining `execSync` calls verified — all use hardcoded constants or pre-validated inputs.

---

### FIND-07: Scroll-lock false positive in mouse mode — correct (MEDIUM, fixed)

**File:** `public/app.ts:908-909`

New guard: `_term.viewportY > 0` prevents `_userScrolledUp = true` when wheel events are consumed by terminal mouse reporting (viewportY stays 0). All 6 sites that set `_userScrolledUp` verified — all properly guarded.

---

### FIND-08: WS prefill/resize reorder — correct (MEDIUM, fixed)

**File:** `src/server/websocket.ts:418-459`

New order: prefill → subscribe → resize. Resize may trigger PTY redraw; subscribing before resize ensures redraw output is forwarded. Also fixes full-mode prefill: viewport marker now sent before chunked scrollback data.

---

### FIND-09: PTY-wins ownership reconciliation — correct (LOW)

**File:** `src/server/backend.ts:160-173`

When same session name exists in both backends, PTY wins (in-process = authoritative, tmux may be stale). Clean implementation with `ptySet` guard.

---

### FIND-10: Backend toggle API — internal-only breaking change (LOW)

**File:** `public/app.ts:3702-3714`

Changed from implicit POST to explicit `method: "POST"` with JSON body. Not a public API — client and server are co-deployed. No backward compatibility concern.

---

### FIND-11: CMD_REGEX defense-in-depth — good practice (INFO)

**File:** `src/server/pty-backend.ts:86-91`

Re-validates `agentCmd` before shell interpolation. Primary validation is in routes.ts; this is secondary. CMD_REGEX verified at 6 call sites across routes.ts — complete coverage.

---

### FIND-12: Tmux uninstall handling — correct (INFO)

**File:** `src/server/backend.ts:120-135`

`recheckTmux()` now handles tmux removal: logs orphaned sessions, deletes ownership, reverts default to pty. Doesn't kill tmux processes (correct — they're independent).

---

## Fix-Completeness Check

| Pattern | Sites Found | Sites Fixed | Gap |
|---------|------------|------------|-----|
| escAttr \n/\r escape | 1 impl + 1 test copy | 1/2 | **Test copy out of sync** |
| execSync → execFileSync | 1 vulnerable + 17 safe | 1/1 | None (others use hardcoded args) |
| CMD_REGEX validation | 6 route validators + 1 pty-backend | 7/7 | None |
| removeEventListener | 2 keydown + 1 resize | 3/3 | None |
| stripAnsi DCS | 1 definition, 0 duplicates | 1/1 | None |
| \_userScrolledUp guards | 6 set-sites | 6/6 | None |

---

## Context Inputs & Compliance

### Context files consulted
| File | Used for |
|------|----------|
| `.context/context.md` | Invariant verification, trust boundary cross-check |
| `.context/server.md` | Backend router, websocket, pty-backend function-level detail |
| `.context/client.md` | Terminal controller lifecycle, escAttr contract |
| `.context/cli.md` | Service template rendering, serviceStop |
| `.context/tests.md` | Test coverage gap identification |
| `.context/issues.md` | Cross-reference ISS-21 (CORS), ISS-22 (scroll-lock cleanup) |
| `.context/complexity.md` | Test mirroring duplication (escAttr) |

### Invariants checked

| # | Invariant | Pass/Fail |
|---|-----------|-----------|
| 1 | Sessions listed only by owning backend | PASS — PTY-wins reconciliation maintains this |
| 2 | Session names unique across both backends | PASS — createSession checks both lists |
| 3 | Project paths validated via realpathSync + isUnderDevDir | N/A — not touched |
| 4 | Server-supplied strings HTML-escaped via esc()/escAttr() | PASS — search highlight fix + escAttr hardening |
| 5 | Terminal input flows as binary WS frames | N/A — not touched |
| 6 | One PTY viewer per session | N/A — not touched |
| 7 | Grid sessions array empty or >= 2 | N/A — not touched |
| 8 | backendFor() defaults to PTY for unknown sessions | PASS — verified with debug logging addition |
| 9 | WS handler captures backendType at connect time | N/A — not touched |

### Issues cross-referenced

| Issue | Status after commit |
|-------|-------------------|
| ISS-21 (CORS behind tailscale) | **FIXED** — origin recovery from Referer |
| ISS-22 (scroll-lock cleanup) | **FIXED** — explicit removeEventListener in dispose |
| ISS-03 (machine URL concat) | Not touched — still present |
| ISS-04 (triage as CSS class) | Not touched — still present |
| ISS-23 (Tailscale CORS trust) | **NEW** — documented trust assumption |
| ISS-24 (no CORS recovery tests) | **NEW** — test gap identified |

### Search scope
- All `*.ts` files under `src/` and `public/` searched for pattern completeness
- `tests/` searched for test copy sync
- grep coverage: escAttr (19 callers), execSync (25 calls), CMD_REGEX (7 sites), addEventListener (28 sites), stripAnsi (1 definition), _userScrolledUp (6 set-sites)

---

## Action Items

| Priority | Item |
|----------|------|
| **P1** | Update escAttr copy in `tests/unit/escaping.test.ts` to include \n/\r escaping |
| **P2** | Add integration test for Tailscale CORS origin recovery (ISS-24) |
| **P3** | Consider extracting escAttr to shared isomorphic module (eliminates test mirroring) |
