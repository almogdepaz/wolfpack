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
