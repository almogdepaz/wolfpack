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
