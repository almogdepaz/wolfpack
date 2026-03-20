# Code Review — Quality and Security

> Full repo-wide review performed 2026-03-20. Covers security, code quality, error handling, type safety, dead code, API design, and test coverage.

## Executive Summary

| Severity | Count | Key Themes |
|----------|-------|------------|
| CRITICAL | 2 | XSS via innerHTML in search, git argument injection in ralph worker |
| HIGH | 14 | onclick attribute injection, prompt injection, shell injection patterns, pervasive `any` types, uncaught errors, `--yolo` agent flags |
| MEDIUM | 30 | TOCTOU races, error info leakage, missing null checks, duplicated patterns, unvalidated URLs, mutable globals |
| LOW | 18 | Dead code, inconsistent naming, missing timeouts, `var` usage |
| INFO | 8 | Clean files, minor style notes |

---

## 1. Security Issues

### 1.1 CRITICAL

**SEC-C1: XSS via `innerHTML` in search highlight** — `public/app.ts:3052`

`applySearchHighlights()` HTML-escapes terminal content then runs a regex replace to inject `<mark>` tags. The matched text from already-escaped content is inserted back without re-escaping. Crafted terminal output that survives the escape/unescape round-trip (e.g., `&lt;script&gt;`) could produce executable HTML after regex substitution. The `innerHTML` write is the highest-risk DOM sink in the client.

**SEC-C2: Git argument injection via unsanitized branch names** — `src/ralph-macchio.ts:608,669,746,846`

Branch names derived from plan file content via `slugifyTaskName()` are passed to `execFileSync("git", ["branch", "-D", branchName])`. While `execFileSync` avoids shell injection, a plan header producing a branch starting with `--` turns it into a git flag (e.g., `--force`). All git commands accepting branch args should use `--` separator: `["branch", "-D", "--", branchName]`.

### 1.2 HIGH

**SEC-H1: XSS risk in onclick attribute construction** — `public/app.ts:1382-1384,1393,1399,1471,1633,1685,1691,1694,2294,2930,3283-3316`

Machine URLs and versions from remote peers are placed into `onclick` attribute strings using `escAttr()`. This is a double-encoding context (HTML attribute containing JS string literal). If `escAttr` only does HTML entity encoding but not JS string escaping, a peer could craft a URL like `');alert(1);//` to break out. ~20 occurrences across `renderMachineGroupHtml`, `sidebarCardHtml`, etc.

**SEC-H2: onclick parsing for data extraction** — `public/app.ts:3160-3163`

Swipe gesture engine extracts session name and machine URL by regex-parsing the `onclick` attribute. A crafted session name from a remote peer could inject values that bypass the regex, leading to fetching arbitrary URLs as the `sMachine` variable becomes the fetch base URL with no validation.

**SEC-H3: Unvalidated `machineUrl` used as fetch base** — `public/app.ts:1117`

`machineUrl` flows from peer discovery, localStorage, and onclick handlers. A malicious peer advertising `https://evil.com` routes all API calls for that machine to the attacker's server. No URL allowlisting or origin validation exists.

**SEC-H4: Prompt injection via plan file content** — `src/ralph-macchio.ts:321-354`

`buildPrompt(taskDesc)` embeds raw task content (from user-editable plan files) directly into agent prompts without sanitization. A malicious plan file could contain instructions that override the system prompt.

**SEC-H5: Prompt injection via file paths in skill prompts** — `src/ralph-skill-audit.ts:13`, `src/ralph-skill-cleanup.ts:13`

`projectDir`, `planFile`, `progressFile`, and `diffBase` are interpolated directly into prompt strings containing shell command templates. `diffBase` is especially dangerous as it appears in `git diff` command templates the agent will execute.

**SEC-H6: `--dangerously-skip-permissions` with broad tool allowlist** — `src/ralph-macchio.ts:128`

Allowed tools include `Bash(rm *)`, `Bash(mv *)`, `Bash(cp *)`, `Bash(git *)`. An LLM that goes off-rails can execute destructive operations within the allowed patterns. By design, but a standing risk.

**SEC-H7: `--yolo` flags on non-claude agents** — `src/ralph-macchio.ts:131-141`

All non-claude agents (codex, gemini, cursor) use `--yolo` which skips safety confirmations. Combined with prompt injection from plan files (SEC-H4), this is high risk.

**SEC-H8: CORS bypass via `WOLFPACK_TEST` env var** — `src/server/index.ts:76`

When `WOLFPACK_TEST` is set, any `http://127.0.0.1:*` origin is allowed through CORS. If this leaks into production (e.g., left in a launchd plist), it widens CORS to every port on localhost.

**SEC-H9: Shell injection pattern in service management** — `src/cli/service.ts:188,201-202`

`execSync` with template literal interpolation: `` execSync(`launchctl bootout ${LAUNCHD_TARGET}`) ``. Currently safe (constant inputs), but one refactor away from exploitable. Should use `execFileSync` with array args.

**SEC-H10: `POST /api/send` has no content or length validation on text** — `src/server/routes.ts:309-314`, `src/server/tmux.ts:174`

The `text` field is only checked for truthiness. No length limit (body limit is 64KB, generous for keystroke input). No sanitization of control characters, ANSI escapes, or terminal injection payloads. Attacker with JWT can inject arbitrarily long shell commands. By design for a terminal tool, but no guardrail.

### 1.3 MEDIUM

**SEC-M1: Auth disabled when `WOLFPACK_JWT_SECRET` unset** — `src/auth.ts:205`

`validateRequestJwt` returns `{ ok: true }` when auth is disabled. Combined with no CORS enforcement for non-browser clients (no Origin header), a server without JWT has zero authentication. Mitigated by localhost binding, but any local process can hit the API.

**SEC-M2: Credential forwarding to Tailscale peers** — `src/server/routes.ts` (ralph aggregation)

Ralph aggregation forwards the caller's `Authorization` header to Tailscale peers, leaking the JWT to other machines on the tailnet.

**SEC-M3: Path traversal mitigation incomplete in ralph.ts** — `src/server/ralph.ts:196`

Checks `workdirPath.startsWith(projectDir)` without normalizing either path. `/home/user/project-evil` passes the check for `projectDir = /home/user/project`. Should use `path.resolve()` + trailing separator check.

**SEC-M4: Error messages leak internal paths and stderr** — `src/server/routes.ts:498,568,749,758`

Several routes return `e.message`, `e.stderr`, or raw git stderr containing filesystem paths directly to the client.

**SEC-M5: `process.kill(-pid)` with untrusted PID** — `src/shared/process-cleanup.ts:40-41`

If `pid` is 1 (init), `-pid` becomes `-1`, sending signal to ALL processes the user owns. No `pid > 1` guard.

**SEC-M6: CSP `connect-src` allows `wss:` and `https:` broadly** — `src/server/http.ts:143`

`connect-src 'self' wss: https:` allows connections to any host. If an XSS is found, it can exfiltrate to arbitrary endpoints.

**SEC-M7: Path traversal via `PLAN_FILE`/`PROGRESS_FILE` args** — `src/ralph-macchio.ts:44-45,73-74`

CLI args joined with `PROJECT_DIR` via `join()` but never validated. `--plan ../../etc/passwd` resolves outside the project directory. While the server validates before passing, the worker doesn't validate independently.

**SEC-M8: Side effect in parse function** — `src/server/ralph.ts:161-173`

`parseRalphLog` silently deletes `.ralph.lock` when a process is dead. A function named "parse" shouldn't perform file mutations.

---

## 2. Code Smells & Duplication

### 2.1 HIGH

**CS-H1: `public/app.ts` is 3618 lines** — single file containing metrics, quick commands, session management, terminal lifecycle, reconnect logic, project/agent pickers, search, swipe gestures, sidebar, drawer, notifications, settings, and event binding. Should be split into domain modules.

**CS-H2: `src/ralph-macchio.ts` `main()` is 285 lines** (lines 695-979) — handles worktree setup, orphan cleanup, iteration loop, task worktree lifecycle, corruption recovery, subtask expansion, final phases, and summary logging. Should decompose into 4-5 functions.

### 2.2 MEDIUM

**CS-M1: Duplicated merge-fail-and-exit pattern (3 occurrences)** — `ralph-macchio.ts:782-796,823-839,951-964`

Same sequence: `syncProgressBack()`, `mergeTaskBranch()` check, log, `syncPlanToProject()`, `logSummary()`, `removeLock()`, `process.exit(1)` — three times with minor variations.

**CS-M2: Duplicated onclick HTML pattern (~20 occurrences)** — `public/app.ts`

Building HTML strings with `onclick="fn('${escAttr(value)}')"` repeated throughout. Should use data-attribute + delegated event listener pattern (which would also eliminate XSS risk SEC-H1).

**CS-M3: Duplicated WebSocket URL construction** — `public/app.ts:521-531` vs `2043-2049`

`buildUrl()` in `createPtySocketClient` and `mobileTerminalWsUrl()` have nearly identical logic.

**CS-M4: Duplicated sidebar collapse/expand logic** — `public/app.ts:1252,1533-1536,1554-1564,2819,3353-3398,3406-3410,3593`

Pattern of `classList.add/remove("collapsed")` + state updates appears in 10+ locations. Should be a single `setSidebarCollapsed(bool)` function.

**CS-M5: `saveQuickCmds` + `renderQuickCmdSettings` + `renderCmdPalette` always called together** — `public/app.ts:167-200`

Identical 3-line sequence repeated 4 times. Extract `persistAndRenderQuickCmds()`.

**CS-M6: Mutable module-level state in ralph worker** — `ralph-macchio.ts:60-74`

`mainWorkDir`, `workingDir`, `PLAN_PATH`, `PROGRESS_PATH` are `let` variables mutated from multiple functions. Named as constants (ALL_CAPS) but reassigned.

---

## 3. Error Handling Gaps

### 3.1 HIGH

**ERR-H1: `killProcessTree` result ignored on timeout** — `ralph-macchio.ts:467`

`killProcessTree(child.pid)` is async but neither awaited nor `.catch()`-ed inside a `setTimeout` callback. Unhandled rejection if it throws.

**ERR-H2: Silent JSON parse failure in `api()`** — `public/app.ts:1122`

`try { data = JSON.parse(body); } catch {}` — if response isn't JSON, `data` stays `{}` and callers get an empty object when they expect structured data.

**ERR-H3: Silent catch in WebSocket message handler** — `public/app.ts:623`

`JSON.parse(ev.data)` failure silently drops the entire message. Control messages like `viewer_conflict` or `control_granted` could be lost.

### 3.2 MEDIUM

**ERR-M1: `main().catch()` uses `err.message` without null check** — `ralph-macchio.ts:1045`

If the rejection value is not an `Error` (e.g., string or undefined), `err.message` is undefined. Should use `errMsg(err)`.

**ERR-M2: No `maxBuffer` on `execFileSync` calls** — `ralph-macchio.ts:114,376,537-544`

Defaults to 1MB. Large git diffs will throw a buffer overflow error caught generically but could mask real issues.

**ERR-M3: SIGTERM handler doesn't stop main loop** — `ralph-macchio.ts:517`

After SIGTERM, `setTimeout(() => process.exit(0), 3500)` fires but main loop continues running. Could start new file operations or spawn child processes before timeout fires. No flag to signal the loop to stop.

**ERR-M4: `removeWorktree` can abort cleanup of remaining worktrees** — `src/worktree.ts:167-169`

Exception inside the for-loop aborts cleanup of remaining worktrees. Should try/catch per iteration.

**ERR-M5: Uncaught promise in auto-discover IIFE** — `public/app.ts:1072-1109`

Async IIFE not awaited or `.catch()`-wrapped at top level.

**ERR-M6: `loadSessions().then(renderSidebar)` without `.catch()`** — `public/app.ts:1771,2253,3596`

Multiple call sites with no error handler.

**ERR-M7: Missing null checks on DOM elements** — `public/app.ts:207,218,976,1285,2172` and `app-ralph.ts:93-95,144,173` and `app-grid.ts:90-106`

`getElementById` returns used without null guards. Missing elements crash the app.

**ERR-M8: Empty catch blocks swallowing errors** — `public/app-ralph.ts:136,150,298,378,457`

Multiple API calls with `catch {}` and no logging or user feedback.

---

## 4. Type Safety Issues

### 4.1 HIGH

**TS-H1: Client-side files are effectively untyped** — `public/app.ts`, `public/app-ralph.ts`, `public/app-state.ts`, `public/app-grid.ts`

Nearly every function parameter across all four client files lacks type annotations. These are `.ts` files behaving as `.js`. This is the single biggest code quality issue in the codebase.

### 4.2 MEDIUM

**TS-M1: `this: any` in settings handlers** — `public/app.ts:3503-3511`

9 settings change handlers use `this: any` instead of `HTMLInputElement`.

**TS-M2: No typing on `wpMetrics`** — `public/app.ts:33-66`

`latencySamples` typed as `[]` (never[]), methods have no parameter/return types.

**TS-M3: `any` type on catch clauses** — `src/worktree.ts:77,80`

`gracefulErr: any` and `forceErr: any` should be `unknown` with proper narrowing.

**TS-M4: Unsafe `as NodeJS.ErrnoException` casts** — `ralph-macchio.ts:154,447`

Cast is a lie if `e` is not an object. Better: `e instanceof Error && 'code' in e`.

**TS-M5: Unsafe property access on `HTMLElement`** — `public/app-state.ts:130`, `public/app-grid.ts:114`

`el.type`, `el.checked`, `e.target.classList` used on types that don't have those properties.

**TS-M6: Reference to undeclared global `WP`** — `public/app-grid.ts:146,156,165-168,272,345,380,421,618`

No `declare` statement or import. Relies on implicit global.

### 4.3 LOW

**TS-L1: Non-null assertions on optional `parseArgs` values** — `ralph-macchio.ts:44-47`

`args.plan!`, `args.progress!` — have defaults so always defined, but `!` suppresses type checking.

---

## 5. Dead Code

**DC-1 (MEDIUM): `encodeTerminalBinary`** — `public/app.ts:955`

Assigned from `WP.encodeTerminalBinary` but never used anywhere.

**DC-2 (LOW): Drawer drag state variables** — `public/app.ts:2257-2259`

`drawerDragY`, `drawerDragStartY`, `drawerDragging` declared at module scope but never read or written. Remnants of earlier implementation.

**DC-3 (LOW): Windows codepath** — `ralph-macchio.ts:86-93`

`IS_WIN` / Windows path augmentation exists but the tool targets macOS/Linux only.

---

## 6. API Design Consistency

**API-1 (MEDIUM): Inconsistent session key construction** — `public/app.ts`

Four different functions (`sessionKey`, `terminalSessionKey`, `snapshotKey`, `draftKey`) doing the same thing with different naming and parameter conventions.

**API-2 (MEDIUM): Inconsistent optional machineUrl representation** — `public/app.ts`

Callers inconsistently pass `""`, `undefined`, or omit the parameter to represent "local machine".

**API-3 (LOW): Global function exposure via `Object.assign(window, {...})`** — `public/app.ts:3608`

Functions exposed to `window` for inline onclick handlers. `bindHtmlEventListeners()` was written to replace this pattern but many onclick handlers still reference globals.

---

## 7. Test Coverage Gaps

### 7.1 P0 — Security-Critical, Zero/Minimal Coverage

| Module | Gap |
|--------|-----|
| **`src/shared/process-cleanup.ts`** | ZERO tests. `killProcessTree()` sends SIGTERM/SIGKILL to process groups (`-pid`). A bug = killing wrong processes. |
| **`src/auth.ts` unit tests** | No unit tests for `validateJwtHs256()`, `extractBearerToken()`, `getJwtAuthConfig()`, `getRequestToken()`, disabled-auth bypass path. All coverage via integration tests only. |
| **`POST /api/ralph/cancel`** | PID validation + `process.kill()` logic UNTESTED. The "is this a ralph process" check via `ps` is unverified. |
| **`POST /api/ralph/start`** | Lock file race conditions, worker spawning, branch creation all UNTESTED at route level. |

### 7.2 P1 — Important Functional Gaps

| Module | Gap |
|--------|-----|
| **`src/ralph-macchio.ts` runtime** | Worker orchestration (spawn child, timeout, SIGTERM handling, worktree switching) has ZERO integration tests. |
| **`src/cli/service.ts`** | Everything beyond `renderPlist`/`renderSystemdUnit` is UNTESTED (install/uninstall/start/stop). |
| **`injectAgentContext()` / `detectAgent()`** in `tmux.ts` | Construct shell commands. UNTESTED. |
| **`readBody()` MAX_BODY enforcement** | 64KB request body size limit UNTESTED. |
| **Binary WS message handling** | `MAX_PTY_BINARY_BYTES` enforcement UNTESTED. |

### 7.3 P2 — Nice to Have

| Module | Gap |
|--------|-----|
| Ralph API routes | `/branches`, `/plans`, `/log`, `/task-count` lack integration tests |
| `discoverPeers()` | Requires tailscale, no test at all |
| `listDevProjects()` / `scanRalphLoops()` | Filesystem scanning UNTESTED |
| `loadSettings()` / `saveSettings()` | Filesystem-dependent, UNTESTED |
| `GET /manifest.json` customization | UNTESTED |

---

## 8. Positive Security Properties

The codebase demonstrates strong security hygiene in several areas:

1. **Consistent `execFile` over `exec`** — no shell injection via argument interpolation
2. **`shellEscape()` used when shell command construction is necessary** — well-known single-quote wrapping pattern
3. **Path traversal defense-in-depth** — symlink rejection + `realpathSync()` + `isUnderDevDir()` with path-boundary check
4. **JWT implementation** — `timingSafeEqual`, exp/nbf/iat checks, minimum secret length, algorithm pinning to HS256
5. **Rate limiting** — global (120/s) + per-endpoint (10/s) + per-WS-connection (60/s)
6. **Body size limits** — HTTP (64KB) and WebSocket (65KB text, 16KB binary)
7. **CSP with per-request nonce** — prevents inline script injection
8. **Peer response validation** — `validatePeerLoops()` schema-checks and strips unknown keys
9. **Atomic lock file** — `wx` flag for ralph lock prevents TOCTOU races
10. **`tmux send-keys -l`** — literal mode prevents key-name injection

---

## 9. Recommended Priority Actions

1. **Fix SEC-C1 (search innerHTML XSS)** — use `textContent` or re-escape after regex substitution
2. **Fix SEC-C2 (git arg injection)** — add `--` separator before branch name args in all git commands
3. **Migrate from onclick attributes to delegated event listeners** — fixes SEC-H1, SEC-H2, CS-M2, API-3 in one pass
4. **Add `--` separator to all git `execFileSync` calls** accepting user-derived branch/ref names
5. **Validate `machineUrl` against an allowlist** — fix SEC-H3 by only allowing known peer URLs
6. **Add unit tests for `process-cleanup.ts`** — highest-risk untested module
7. **Add unit tests for `auth.ts` JWT validation functions** — currently only integration-tested
8. **Add integration tests for `POST /api/ralph/start` and `/cancel`** — security-critical untested routes
9. **Type the client-side codebase** — at minimum, add types to function signatures in all `public/*.ts` files
10. **Split `public/app.ts`** — 3618 LOC monolith should be decomposed into domain modules
