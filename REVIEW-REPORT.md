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

---

# Function-Level Audit — ralph-macchio and routes

> Deep function-level security audit of `src/ralph-macchio.ts` and `src/server/routes.ts`. Performed 2026-03-20.

## A. ralph-macchio.ts — Function-Level Findings

### A.1 Command Injection

**RM-CI1: `runIteration()` — agent binary spawned with prompt as CLI arg (line 459)**

```ts
const child = nodeSpawn(agent.bin, agent.args(prompt), { cwd: workingDir, ... });
```

The entire prompt (which includes raw plan file content via `buildPrompt()`) is passed as a CLI argument. This is safe from *shell* injection because `nodeSpawn` uses `execve` directly — no shell interpolation. However, the prompt content flows directly into the agent's instruction set, making prompt injection the primary risk (already documented as SEC-H4). No additional command injection risk here beyond what's inherent to the design.

**RM-CI2: `worktreeBranchName()` — branch names derived from plan content (line 390-395)**

```ts
function worktreeBranchName(taskHeader: string, iterationIndex: number): string {
  const numMatch = taskHeader.match(/^##\s*(\d+[a-z]?)\./);
  const num = numMatch ? numMatch[1] : String(iterationIndex);
  const slug = slugifyTaskName(taskHeader);
  return `ralph/${num}-${slug}`;
}
```

`slugifyTaskName()` strips non-`[a-z0-9]` chars, lowercases, and caps at 40 chars. The `ralph/` prefix prevents `--`-prefixed output. **Mitigated.** However, this branch name is later used in:

- `execFileSync("git", ["branch", "-D", branchName])` (line 669, 746)
- `execFileSync("git", ["merge", taskBranch, ...])` (line 608)
- `createWorktree(PROJECT_DIR, branchName, baseBranch)` (line 851)

The `ralph/` prefix ensures the name can never start with `--`, so git flag injection is not possible here. The earlier SEC-C2 finding about orphan branch names at lines 669 and 746 is **valid for orphan branches from `listWorktrees()`** — those branch names come from git's worktree listing, not from `worktreeBranchName()`, and could theoretically contain `--` if someone created such a branch manually. Adding `--` separators remains the correct fix.

**RM-CI3: `numberPlanTasks()` — PLAN_FILE interpolated into prompt (line 273-288)**

```ts
const prompt = `...Read @${PLAN_FILE}...Write the result back to @${PLAN_FILE}...`;
```

`PLAN_FILE` comes from `--plan` CLI arg (ultimately from route validation via `isValidPlanFile`). The `PLAN_FILE_REGEX` (`/^[a-zA-Z0-9._\- ]+\.md$/`) prevents shell metacharacters, but this is a *prompt*, not a shell command — the concern is prompt injection via filename. A file named `IGNORE-ABOVE.md` is technically valid and could be used to manipulate the agent. **Severity: LOW** — requires control of the plan file name AND the agent interpreting the filename as an instruction.

**RM-CI4: `buildRecoveryPrompt()` — injects full plan content into prompt (line 293-316)**

```ts
return `...Here is the ORIGINAL plan content before corruption:\n\`\`\`\n${originalContent}\n\`\`\`\n...`;
```

`originalContent` is the raw plan file content embedded in a code fence. If the plan file contains `` ``` `` followed by prompt-override instructions, the agent could break out of the code fence context. **Severity: MEDIUM** — the plan file is user-authored, so this is a self-injection risk rather than a cross-boundary attack.

### A.2 Path Traversal

**RM-PT1: `PLAN_FILE` and `PROGRESS_FILE` not re-validated in worker (lines 44-45, 73-74)**

```ts
const PLAN_FILE = args.plan!;
const PROGRESS_FILE = args.progress!;
// ...
let PLAN_PATH = join(PROJECT_DIR, PLAN_FILE);
let PROGRESS_PATH = join(PROJECT_DIR, PROGRESS_FILE);
```

The server validates `planFile` via `isValidPlanFile()` before spawning the worker, but the worker does NOT independently validate these args. If the worker is invoked directly (bypassing the server), `--plan ../../etc/passwd` would resolve outside PROJECT_DIR. `join()` does not reject `..` components.

**Defense gap:** The worker trusts the server to have validated these values. No defense-in-depth.

**Severity: MEDIUM** — the worker CLI is not user-facing (spawned internally), but the binary exists on disk and could be invoked by other automation. Also noted in prior report as SEC-M7.

**RM-PT2: `appendSubtasksToPlan()` writes to PLAN_PATH without path re-check (line 403-408)**

```ts
function appendSubtasksToPlan(subtasks: string[]): void {
  const safe = subtasks.map(t => t.replace(/^#+\s*/, "").replace(/~~/g, "").trim()).filter(Boolean);
  const lines = safe.map(t => `- [ ] ${t}`).join("\n");
  appendFileSync(PLAN_PATH, "\n" + lines + "\n");
}
```

`PLAN_PATH` was already set at startup. The subtask *content* comes from agent output (`parseSubtasks(output)`), which is LLM-generated text. The sanitization strips markdown headers and strikethrough but not path components. Since this is appended as checkbox text (not used as a filename), no path traversal risk exists here. **Not vulnerable.**

**RM-PT3: `syncFilesToWorktree()`, `syncProgressBack()`, `syncPlanToProject()` — file copy between directories (lines 571-603)**

These functions use `copyFileSync` with paths derived from `PLAN_FILE`/`PROGRESS_FILE` joined to various directories. If RM-PT1 is exploited, these copies could read/write outside project boundaries. **Same root cause as RM-PT1.**

### A.3 TOCTOU Races

**RM-TOCTOU1: Plan file read-modify-write race in `dedupCheckboxes()` (lines 410-442)**

```ts
function dedupCheckboxes(): void {
  const plan = readPlan();       // read
  // ... filter logic ...
  if (out.length !== lines.length) {
    writeFileSync(PLAN_PATH, out.join("\n"));  // write
  }
}
```

Between `readPlan()` and `writeFileSync()`, another process could modify the plan file. Since ralph holds the lock file and is the only writer, this is safe during normal operation. However, a user manually editing the plan file during a ralph run would lose their changes. **Severity: LOW** — accepted operational constraint.

**RM-TOCTOU2: Plan corruption detection — snapshot vs. re-read (lines 876-906)**

```ts
const planSnapshot = readPlan();                    // read #1
const { total: totalBefore } = countTasksInContent(planSnapshot);
const { exitCode, output } = await runIteration(prompt);  // agent may modify plan
const afterCounts = countTasksInContent(readPlan());  // read #2
```

Sound design: takes a snapshot before iteration, compares against live state after. The recovery path restores the snapshot if corruption is detected. **No TOCTOU vulnerability** — the gap between reads is intentional (the agent runs between them).

**RM-TOCTOU3: Lock file lifecycle — `removeLock()` registered on `exit` AND called explicitly (lines 152-156, 495-518)**

```ts
process.on("exit", removeLock);
// also called in SIGTERM handler, main().catch(), and main().then()
```

Multiple codepaths call `removeLock()` and the `exit` handler also calls it. `unlinkSync` with ENOENT catch makes this idempotent. **Not vulnerable.**

### A.4 Other Findings

**RM-MISC1: SIGTERM handler continues main loop (line 498-518)**

The SIGTERM handler kills the active child, cleans up worktrees, and schedules `process.exit(0)` after 3500ms. However, **no flag is set to stop the main loop**. Between SIGTERM and the delayed exit, `main()` could advance to the next iteration: call `extractCurrentTask()`, `readPlan()`, and potentially `runIteration()` with a new agent spawn. The new child process would be orphaned since the parent exits shortly after.

```ts
process.on("SIGTERM", () => {
  // kills child, cleans worktrees... but doesn't set a "stopping" flag
  setTimeout(() => process.exit(0), 3500);
});
```

**Severity: MEDIUM** — could spawn an orphan agent process that runs without supervision.

**RM-MISC2: `activeChild` not protected against concurrent access (line 454)**

`activeChild` is a module-level mutable variable set in `runIteration()` and read in the SIGTERM handler. Since Node.js is single-threaded, there's no race condition risk. However, if `runIteration` is ever called concurrently (currently it's not — the loop is sequential), the variable would be clobbered. **Severity: INFO** — no current risk.

**RM-MISC3: `main().catch()` uses `err.message` directly (line 1045)**

```ts
.catch((err) => {
  appendFileSync(LOG_FILE, `\nFATAL: ${err.message}\n`);
```

If the rejection value is not an Error (e.g., a string), `err.message` is `undefined`. Should use `errMsg(err)`. **Severity: LOW.**

**RM-MISC4: `killProcessTree` result ignored in timeout handler (line 467)**

```ts
const timeout = setTimeout(() => {
  if (child.pid) killProcessTree(child.pid);  // async, not awaited
}, ITERATION_TIMEOUT_MS);
```

`killProcessTree` is async but called without `await` or `.catch()` in a `setTimeout` callback. If it rejects, the error is unhandled. **Severity: LOW** — the function has internal try/catch on each kill call, so rejection is unlikely.

---

## B. routes.ts — Function-Level Findings

### B.1 Input Validation Completeness

**RT-IV1: `POST /api/send` — no length or content validation on `text` (line 305-314)**

```ts
const { session, text, noEnter } = body;
if (!session || !text) return json(res, { error: "missing session or text" }, 400);
await tmuxSend(session, text, !!noEnter);
```

`text` is checked for truthiness only. No max length validation beyond the 64KB body limit. No control character filtering. The text is passed to `tmux send-keys -l` which types it literally into the active pane. This is by design (it's a terminal tool), but:

- No rate limiting on this endpoint specifically (relies on global 120/s limiter)
- A 64KB paste into a shell prompt is effectively arbitrary command execution
- ANSI escape sequences could manipulate terminal state

**Severity: MEDIUM** (by-design, but worth documenting guardrail gaps). Auth is the only barrier.

**RT-IV2: `POST /api/key` — strict allowlist, well-validated (lines 317-333)**

Key must be in a hardcoded 13-element allowlist. `isAllowedSession` validates the session. **Well-implemented.** Note the allowlist here is narrower than `WS_ALLOWED_KEYS` (13 vs 26 keys), which is intentional (HTTP endpoint is more restrictive).

**RT-IV3: `POST /api/create` — `newProject` can create directories (lines 348-389)**

```ts
const folderName = newProject?.trim() || project?.trim();
if (!validateProject(res, folderName)) return;
// ...
if (newProject) {
  try { mkdirSync(projectDir, { recursive: true }); } catch ...
}
if (!validateProjectDir(res, projectDir)) return;
```

`folderName` is validated by `isValidProjectName` (`/^[a-zA-Z0-9._-]+$/`), which rejects path separators, `..`, and `.`. Then `projectDir = join(DEV_DIR, folderName)` is validated via `validateProjectDir` (symlink + realpath + isUnderDevDir). **Well-defended.** The `mkdirSync` happens before `validateProjectDir`, so a directory matching the regex is created under DEV_DIR even if validation later fails. This is benign — the directory name is already validated.

**RT-IV4: `POST /api/settings` — `deleteCustomCmd` not validated (lines 396-429)**

```ts
if (body.deleteCustomCmd != null) {
  settings.customCmds = (settings.customCmds || []).filter(c => c !== body.deleteCustomCmd);
  if (settings.agentCmd === body.deleteCustomCmd) {
    settings.agentCmd = "claude";
  }
}
```

`deleteCustomCmd` is used only for string comparison (`filter` and `===`), not for file operations or command execution. No validation needed — it's a non-exploitable comparison. **Not vulnerable.**

**RT-IV5: `POST /api/ralph/start` — comprehensive validation (lines 620-803)**

This is the most complex route handler. Validation coverage:

| Field | Validation | Adequate? |
|-------|-----------|-----------|
| `project` | `resolveProjectDir` (name regex + symlink + realpath) | Yes |
| `iterations` | Clamped to `[1, 500]` | Yes |
| `planFile` | `isValidPlanFile` (PLAN_FILE_REGEX) + exists on disk | Yes |
| `agent` | Checked against `RALPH_AGENTS` set, defaults to "claude" | Yes |
| `newBranch` | `BRANCH_REGEX` | Yes |
| `sourceBranch` | `BRANCH_REGEX` | Yes |
| `format` | Used as boolean (truthy/falsy) | Yes |
| `cleanup` | Explicit `typeof` check | Yes |
| `auditFix` | Explicit `typeof` check | Yes |
| `worktree` | Checked against valid modes list | Yes |
| `worktreeBranch` | `typeof` + `BRANCH_REGEX` | Yes |
| `worktreeBase` | `typeof` + `BRANCH_REGEX` | Yes |

**Well-defended.** One observation: the lock file handling on validation failure has many `removeLock()` calls — if any early return forgets it, the lock is leaked. A `try/finally` pattern would be more robust.

**RT-IV6: `POST /api/ralph/cancel` — PID validation (lines 821-853)**

```ts
if (!status?.active || !status.pid || status.pid <= 1) {
  return json(res, { error: "no active ralph loop found" }, 404);
}
const { stdout: cmdline } = await exec("ps", ["-p", String(status.pid), "-o", "command="]);
if (!cmdline.includes("ralph-macchio") && !cmdline.includes("worker")) {
  return json(res, { error: "PID does not belong to a ralph process" }, 400);
}
process.kill(status.pid, "SIGTERM");
```

Good: `pid <= 1` guard prevents killing init. `ps` verification ensures the PID belongs to a ralph process (not a recycled PID). **Well-defended.**

However: the `-status.pid` group kill on line 841 does NOT have the `pid <= 1` guard repeated:
```ts
try { process.kill(-status.pid, "SIGTERM"); } catch ...
```
Since `status.pid <= 1` is already rejected above, `-status.pid` can never be `-1` (which would signal all user processes). **Safe by precondition.** But fragile — if the guard check changes, this becomes dangerous.

**RT-IV7: `POST /api/ralph/dismiss` — file deletion with SAFE_FILENAME guard (lines 855-908)**

```ts
if (status.progressFile && SAFE_FILENAME.test(status.progressFile) && !status.progressFile.includes("..")) {
  tryDelete(join(projectDir, status.progressFile), status.progressFile);
}
```

`status.progressFile` comes from parsing `.ralph.log` (written by the worker). The `SAFE_FILENAME` regex (`/^[a-zA-Z0-9._\- ]+$/`) rejects path separators, and `..` is explicitly checked. Combined with the fact that `projectDir` is already validated, this is safe. **Well-defended.**

### B.2 Auth Middleware Coverage

All routes except these are behind JWT middleware (from `src/server/index.ts`):

| Route | Auth | Justification |
|-------|------|---------------|
| `GET /` | No | Static file |
| `GET /manifest.json` | No | PWA manifest |
| `GET /sw.js` | No | Returns 404 |
| `GET /api/info` | No | Public endpoint, intentionally exposed |

All `/api/*` routes (except `/api/info`) go through `shouldAuthenticateApiPath()` which returns true for any path starting with `/api/` not in the `PUBLIC_API_PATHS` set. **Complete coverage verified.**

### B.3 Response Data Leaks

**RT-DL1: `GET /api/git-status` — raw stderr in error response (line 498)**

```ts
json(res, { error: e.message || "git status failed" }, 500);
```

`e.message` may contain `stderr` from git, which includes filesystem paths. **Severity: LOW** — behind auth, but exposes internal paths.

**RT-DL2: `GET /api/ralph/branches` — raw stderr in error response (line 568)**

```ts
json(res, { error: e.stderr || e.message || "git not available" }, 500);
```

Same issue. **Severity: LOW.**

**RT-DL3: `POST /api/ralph/start` — raw git stderr returned to client (lines 749, 758)**

```ts
return json(res, { error: `failed to fetch source branch '${source}': ${stderr}` }, 400);
// ...
return json(res, { error: stderr }, 400);
```

Git stderr can contain full filesystem paths, remote URLs, and sometimes credentials from git config. **Severity: MEDIUM** — source branch errors could leak internal infrastructure details.

**RT-DL4: `GET /api/ralph/log` — full agent output exposed (lines 589-618)**

Returns up to 128KB / 500 lines of `.ralph.log`, which contains full agent stdout. If the agent processes code containing secrets (API keys, tokens in `.env` files, etc.), those appear in the log. **Severity: MEDIUM** — behind auth, but log content is unrestricted.

**RT-DL5: `GET /api/sessions` — session triage exposes last terminal line (line 264-303)**

Returns the last non-junk line from each tmux pane. If a pane displays secrets (e.g., `echo $API_KEY`), those appear in the response. **Severity: LOW** — behind auth, single line only.

### B.4 Error Handling

**RT-EH1: `validateProjectDir` catch block assumes stat failure = not found (line 152-155)**

```ts
} catch { /* expected: stat fails when project dir doesn't exist */
  json(res, { error: "project directory not found" }, 404);
  return false;
}
```

`lstatSync`, `statSync`, or `realpathSync` could throw for permission errors, not just "not found". Returning 404 for EPERM is misleading but not a security issue. **Severity: INFO.**

**RT-EH2: `GET /api/ralph/plans` — TOCTOU between readdir and stat (line 580)**

```ts
.filter((f) => { try { return statSync(join(projectDir, f)).isFile(); } catch { return false; } })
```

File could be deleted between `readdirSync` and `statSync`. The `catch { return false }` handles this gracefully. **Not vulnerable.**

### B.5 Cross-Reference with validation.ts

| Validation Function | Used In routes.ts | Adequate |
|--------------------|--------------------|----------|
| `isValidProjectName` | `validateProject()` (lines 132-138) | Yes — rejects `.`, `..`, path separators |
| `isValidSessionName` | `POST /api/create` (line 364) | Yes — `[a-zA-Z0-9_-]+`, length 1-100 |
| `isValidPlanFile` | `POST /api/ralph/start` (line 690), `GET /api/ralph/task-count` (line 811) | Yes — `PLAN_FILE_REGEX` + rejects `.`/`..` |
| `CMD_REGEX` | `POST /api/create` (line 359), `POST /api/settings` (lines 406, 413), `loadSettings` (lines 207-208) | Yes — `[a-zA-Z0-9 \-._/=]+` blocks shell metacharacters |
| `BRANCH_REGEX` | `POST /api/ralph/start` (lines 712, 720, 728, 733) | Yes — blocks `..` sequences, `//` |
| `SAFE_FILENAME` | `POST /api/ralph/cancel` (line 845), `POST /api/ralph/dismiss` (lines 881, 886) | Yes — `[a-zA-Z0-9._\- ]+` |
| `clampCols`/`clampRows` | `POST /api/resize` (line 459) | Yes — bounded to `[20,300]`/`[5,100]` |

**Notable gap:** `POST /api/poll` uses `session` from query params but only validates via `isAllowedSession()` (checks if session exists in tmux). It does NOT validate the session name format. If tmux somehow had a session with shell metacharacters in the name, `capturePane` would pass it to `tmux capture-pane -t <session>`. Since tmux session names are validated at creation time (`isValidSessionName`), and `isAllowedSession` checks against the live tmux list, this is safe in practice but lacks defense-in-depth.

### B.6 Credential Forwarding

**RT-CF1: Authorization header forwarded to peers (line 521-524)**

```ts
const authHeader = Array.isArray(req.headers.authorization)
  ? req.headers.authorization[0]
  : req.headers.authorization;
const headers = authHeader ? { Authorization: authHeader } : undefined;
const r = await fetch(peer.url + "/api/ralph", { signal: ctrl.signal, headers });
```

The caller's JWT is forwarded verbatim to Tailscale peers. If a peer is compromised, it receives a valid JWT that can authenticate to the caller's machine. **Severity: MEDIUM** — already documented as SEC-M2. Mitigation: use peer-specific tokens or strip authorization for peer calls.

---

## C. Summary of New Findings

| ID | Severity | Component | Finding |
|----|----------|-----------|---------|
| RM-CI4 | MEDIUM | ralph-macchio | Recovery prompt embeds raw plan content in code fence — breakout possible via crafted plan |
| RM-MISC1 | MEDIUM | ralph-macchio | SIGTERM handler doesn't stop main loop — can spawn orphan agents |
| RT-IV1 | MEDIUM | routes | `POST /api/send` has no text length/content validation (64KB via body limit only) |
| RT-DL3 | MEDIUM | routes | Git stderr in ralph/start responses may leak paths/credentials |
| RT-DL4 | MEDIUM | routes | Ralph log endpoint exposes full agent output including potential secrets |
| RM-PT1 | MEDIUM | ralph-macchio | Worker doesn't re-validate `--plan`/`--progress` args (no defense-in-depth) |
| RM-CI3 | LOW | ralph-macchio | Plan filename interpolated into agent prompt — minimal prompt injection via filename |
| RM-MISC3 | LOW | ralph-macchio | `main().catch()` uses `err.message` without null safety |
| RM-MISC4 | LOW | ralph-macchio | `killProcessTree` not awaited in timeout callback |
| RT-DL1/2 | LOW | routes | Git stderr leaked in error responses |
| RT-DL5 | LOW | routes | Session triage exposes last terminal line (could contain secrets) |
| RT-EH1 | INFO | routes | `validateProjectDir` catch treats all errors as 404 |

**No new CRITICAL findings.** The existing CRITICAL (SEC-C2) and HIGH findings from the prior review are confirmed. The codebase demonstrates strong input validation discipline at the route layer, with validation.ts providing a consistent set of safe regex patterns.

---

# Function-Level Audit — websocket, auth, worktree

> Deep function-level security audit of `src/server/websocket.ts`, `src/validation.ts`, `src/auth.ts`, and `src/worktree.ts`. Performed 2026-03-20.

## D. websocket.ts — Function-Level Findings

### D.1 WS Message Dispatch & tmux Injection

**WS-INJ1: Terminal WS `input` message → `tmuxSend()` — no session name format validation (line 177)**

```ts
ws.on("message", async (raw) => {
  // ...
  if (msg.type === "input" && typeof msg.data === "string") {
    await tmuxSend(session, msg.data, true);
  }
```

The `session` parameter arrives from the WS upgrade URL query param (`?session=`), validated at upgrade time by `isAllowedSession()` in `src/server/index.ts:188`. This checks that the session exists in `tmux list-sessions` AND that its `pane_current_path` is under `DEV_DIR`.

However, `isAllowedSession()` does **not** validate the session name format — it only checks membership in the live session list. The session name is passed directly to `tmux send-keys -t <session>`. Since tmux session names are created via `tmuxNewSession()` which validates with `isValidSessionName` (`/^[a-zA-Z0-9_-]+$/`), the live session list should only contain safe names. But if a tmux session were created outside wolfpack with metacharacters in the name, `isAllowedSession` would accept it.

**Severity: LOW** — requires an external actor to create a tmux session with a malicious name AND that session's cwd being under DEV_DIR. Defense-in-depth gap: no format validation on the WS session param at the upgrade handler.

**WS-INJ2: Terminal WS `input` data has no length restriction independent of message size (line 176-177)**

```ts
if (str.length > MAX_WS_MESSAGE_BYTES) return;  // 65536 bytes
const msg = JSON.parse(str);
if (msg.type === "input" && typeof msg.data === "string") {
  await tmuxSend(session, msg.data, true);
```

`msg.data` can be up to ~65KB (JSON overhead aside). This is passed to `tmux send-keys -l` which types it verbatim into the pane. A 64KB paste is effectively arbitrary command execution if the pane has a shell prompt. **By design** for a terminal tool, but no per-field length limit exists (the 65KB limit covers the entire JSON envelope).

**Severity: INFO** — consistent with the HTTP `POST /api/send` behavior documented in RT-IV1. Auth is the barrier.

**WS-INJ3: Terminal WS `key` message — `WS_ALLOWED_KEYS` is broader than HTTP allowlist (line 179-183)**

The WS handler allows 26 keys (`WS_ALLOWED_KEYS` in `validation.ts:8-14`) while the HTTP `POST /api/key` allows only 13. The WS set includes `C-a` through `C-z` minus `C-i`, `C-j`, `C-m`, `C-o`, `C-q`, `C-s`, `C-t`, `C-v`, `C-x`, `C-y`. Notable inclusions:

- `C-c` (SIGINT), `C-d` (EOF), `C-z` (SIGTSTP) — process control
- `C-w` (word delete), `C-u` (line kill), `C-k` (kill to EOL) — editing

These are intentional for a terminal, but `C-c` and `C-z` are powerful primitives — an attacker with WS access can kill or suspend any foreground process in the target pane.

**Severity: INFO** — by design, but worth documenting the signal-sending capability.

### D.2 PTY Access Control

**WS-PTY1: PTY binary data → `proc.terminal.write()` — direct stdin passthrough (line 509-511)**

```ts
} else if (entry.proc) {
  if (Buffer.isBuffer(raw) && raw.length > MAX_PTY_BINARY_BYTES) return;  // 16384
  entry.proc.terminal!.write(raw as Buffer);
}
```

Binary WS messages are written directly to the PTY's stdin. The only guard is the 16KB size limit and the rate limiter (60/s). This is the **most direct command execution path** in the application — raw bytes flow from the WebSocket directly to a shell's stdin. No key validation, no filtering. This is the design intent (desktop terminal emulation), but it means any authenticated WS client has full shell access.

**Security properties in place:**
- Auth (JWT) required at WS upgrade
- CORS origin check at WS upgrade
- Session must exist and be under DEV_DIR
- Rate limit: 60 messages/sec
- Size limit: 16KB per message

**Severity: BY DESIGN** — PTY passthrough is the core feature. Auth is the sole access control.

**WS-PTY2: `spawnPty()` spawns `tmux attach-session` as a child process (line 406)**

```ts
entry.proc = Bun.spawn([TMUX, "attach-session", "-t", session], {
  env: { ...process.env, TERM: "xterm-256color", LANG: "en_US.UTF-8" },
  terminal: { cols, rows, ... }
});
```

The `session` name was validated at upgrade time. The spawn uses `Bun.spawn` (array args, no shell interpolation). `process.env` is spread into the child — this includes `PATH`, `HOME`, and any secrets in the server's environment. The child process inherits the server's full environment.

**Severity: LOW** — the PTY child gets the server's env vars. If `WOLFPACK_JWT_SECRET` or other secrets are in the environment, they're accessible from within the tmux session (via `env` or `/proc/self/environ`). Mitigated by the fact that the user already has shell access via the terminal.

**WS-PTY3: No re-validation of session after PTY spawn (lines 406-461)**

Once the PTY is spawned, the session name is never re-checked against `isAllowedSession()`. If the tmux session's `pane_current_path` changes to outside `DEV_DIR` after PTY attach, the connection remains active. The Terminal WS handler (`handleTerminalWs`) does periodic re-checks (every 1s via `nextSessionCheckAt`), but the PTY handler does not.

**Severity: LOW** — the PTY is attached to the tmux session; the user can `cd` anywhere regardless. Re-validation would be security theater since the user controls the shell.

**WS-PTY4: `take_control` message has no rate limiting on the pending viewer path (line 264-299)**

The `pendingMessage` handler for the pending viewer does not use the rate limiter. A malicious client could rapidly send `take_control` messages. However, the handler is idempotent after the first successful takeover (the entry is deleted from `activePtySessions` and `setupNewPtyEntry` is called once), so repeated messages would hit the `JSON.parse` on a disconnected state.

**Severity: INFO** — no practical exploit, but inconsistent with the rate limiting on the primary message path.

### D.3 Resource & State Management

**WS-RES1: `activePtySessions` map not bounded — potential memory leak (line 26-31)**

No upper limit on the number of concurrent PTY sessions. Each session holds a process handle, two WebSocket references, and buffers. In practice, bounded by the number of tmux sessions, but no explicit guard.

**Severity: LOW** — tmux sessions are the natural bound.

**WS-RES2: `ptySpawnAttempts` map only populated in test mode but never cleared (line 33)**

```ts
const ptySpawnAttempts = new Map<string, number>();
```

Populated when `WOLFPACK_TEST` is set, never pruned. Minor memory leak in test mode only. **Severity: INFO.**

**WS-RES3: Prefill buffer retained in closure scope (lines 347-348, 417)**

```ts
let prefill = Buffer.alloc(0);
let pendingAttach = Buffer.alloc(0);
```

The `prefill` buffer (up to 256KB) is captured in the `data` callback closure and retained for the lifetime of the PTY session. After `shouldDedupeInitialAttach` becomes false, the buffer is never used again but cannot be GC'd until the PTY exits.

**Severity: LOW** — 256KB per session is manageable, but could be zeroed after dedup is complete.

---

## E. validation.ts — Validation Completeness Audit

### E.1 Regex Pattern Analysis

**VAL-RE1: `CMD_REGEX` allows `/` and `=` — sufficient for path traversal in commands (line 18)**

```ts
export const CMD_REGEX = /^[a-zA-Z0-9 \-._/=]+$/;
```

This permits paths like `../../../../bin/sh` as a command. However, the regex is used in conjunction with `validateProjectDir()` for the project path — the command itself is intentionally flexible to support commands like `claude --model opus`. The `/` enables paths, and `=` enables flag values. No shell metacharacters (`$`, `` ` ``, `|`, `;`, `&`, `(`, `)`) are permitted.

**Severity: INFO** — intentionally permissive for command paths, no shell injection possible.

**VAL-RE2: `BRANCH_REGEX` prevents `..` and `//` but allows long names (line 19)**

```ts
export const BRANCH_REGEX = /^(?!.*\.\.)(?!.*\/\/)[a-zA-Z0-9._\-/]+$/;
```

No length limit. An extremely long branch name (>4096 chars) could cause issues with git or filesystem limits. **Severity: INFO** — git itself enforces ref name length limits.

**VAL-RE3: `PLAN_FILE_REGEX` allows spaces in filenames (line 20)**

```ts
export const PLAN_FILE_REGEX = /^[a-zA-Z0-9._\- ]+\.md$/;
```

Spaces in filenames are handled correctly by `join()` and `execFileSync` array args, so no injection risk. **Severity: INFO.**

**VAL-RE4: `isValidPlanFile()` redundantly checks `.` and `..` (line 33-35)**

```ts
export function isValidPlanFile(name: string): boolean {
  return PLAN_FILE_REGEX.test(name) && name !== ".." && name !== ".";
}
```

`PLAN_FILE_REGEX` requires the name to end with `.md`, so `..` and `.` can never match. The extra checks are harmless belt-and-suspenders. **Not vulnerable.**

### E.2 Validation Coverage Gaps

**VAL-GAP1: No `isValidSessionName()` check on WS upgrade session param**

As noted in WS-INJ1, the WS upgrade handler validates sessions via `isAllowedSession()` (live tmux check) but NOT via `isValidSessionName()` (format check). The session name from `?session=` is passed directly to tmux commands. Adding `isValidSessionName(session)` as a pre-check would provide defense-in-depth.

**Severity: LOW** — `isAllowedSession` is effective because tmux session names are controlled at creation time, but a format check would be more robust.

**VAL-GAP2: No validation function for `POST /api/poll` session query param**

`GET /api/poll` extracts `session` from query params and passes it to `isAllowedSession()` then `capturePane()`. Same gap as VAL-GAP1 — no format validation. Noted in prior review (B.5 cross-reference), confirmed here.

**VAL-GAP3: `shellEscape()` is correct but has no protection against NUL bytes (line 69-71)**

```ts
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
```

A string containing `\0` would be escaped as `'...\0...'`. Most shells truncate at NUL, but this is a theoretical concern. The function's callers (`injectAgentContext`, `tmuxNewSession`) pass strings that don't contain NUL bytes. **Severity: INFO.**

---

## F. auth.ts — Authentication Audit

### F.1 JWT Implementation Review

**AUTH-JWT1: HS256 implementation is sound (lines 119-179)**

The JWT validation:
- Pins algorithm to HS256 (rejects all others)
- Uses `timingSafeEqual` for signature comparison
- Checks length equality before `timingSafeEqual` (required — `timingSafeEqual` throws on mismatched lengths)
- Validates `exp`, `nbf`, `iat` with configurable clock tolerance
- Supports optional `iss` and `aud` claims
- Catches all exceptions and returns structured error

**No vulnerabilities found.** This is a well-implemented JWT validator.

**AUTH-JWT2: Auth disabled path returns `{ ok: true, payload: {} }` (line 205)**

```ts
if (!cfg.enabled) return { ok: true, payload: {} };
```

When `WOLFPACK_JWT_SECRET` is unset or too short, ALL requests pass auth. The empty payload `{}` means no claims are available, but no code checks claims for authorization (single-user tool). This is the documented SEC-M1 finding — **confirmed, no new risk.**

**AUTH-JWT3: Secret length check uses `>= MIN_SECRET_LENGTH` (32 chars) (line 98)**

```ts
enabled: enabled && secret.length >= MIN_SECRET_LENGTH,
```

A 32-char secret provides ~192 bits of entropy for HS256 (assuming good randomness). NIST recommends at minimum 112 bits. **Well-implemented.**

### F.2 Token Extraction

**AUTH-TOK1: `extractBearerToken()` regex is strict (line 75)**

```ts
const match = value.trim().match(/^Bearer\s+([^\s]+)$/i);
```

The regex:
- Case-insensitive `Bearer` prefix (per RFC 6750)
- Requires exactly one whitespace-delimited token
- Rejects tokens with embedded whitespace
- Trims the header value

**Well-implemented.** One minor note: the `i` flag makes `bearer`, `BEARER`, etc. all valid. RFC 6750 specifies `Bearer` (case-sensitive), but most implementations are lenient. Not a security issue.

**AUTH-TOK2: `getRequestToken()` — query token only when `allowQueryToken=true` (lines 107-117)**

```ts
if (!allowQueryToken) return null;
const token = (url.searchParams.get("token") ?? "").trim();
```

HTTP routes call `validateRequestJwt(headers, url, false)` — no query token.
WS routes call `validateRequestJwt(headers, url, true)` — query token allowed.

This is correct. WS upgrades can't set custom headers from browsers, so `?token=` is the standard pattern. The token is visible in URL (server logs, browser history) as documented in AA-4.

**Severity: INFO** — standard WS auth pattern.

### F.3 Auth Middleware Coverage Audit

**AUTH-MW1: All `/api/*` routes (except `/api/info`) are authenticated**

Verified in `src/server/index.ts:126-131`:

```ts
if (shouldAuthenticateApiPath(url.pathname)) {
  const auth = validateRequestJwt(req.headers, url, false);
  if (!auth.ok) { writeUnauthorized(res); return; }
}
```

`shouldAuthenticateApiPath` returns `true` for any path starting with `/api/` not in `PUBLIC_API_PATHS` (only `/api/info`). **Complete HTTP coverage confirmed.**

**AUTH-MW2: All WS routes are authenticated**

Verified in `src/server/index.ts:177-183`:

```ts
if (isWsRoute) {
  const auth = validateRequestJwt(req.headers, url, true);
  if (!auth.ok) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
}
```

`isWsRoute` covers `/ws/terminal`, `/ws/mobile`, `/ws/pty`. Non-WS upgrade requests to unknown paths get 404. **Complete WS coverage confirmed.**

**AUTH-MW3: No routes bypass auth unintentionally**

Public routes:
- `GET /` — static file (no auth needed)
- `GET /manifest.json` — PWA manifest (no auth needed)
- `GET /sw.js` — returns 404 (no auth needed)
- `GET /api/info` — intentionally public (hostname + version only)
- Static file catch-all — embedded asset lookup, no filesystem access

All other routes require JWT. **No gaps found.**

### F.4 Cached Config

**AUTH-CACHE1: JWT config cached forever after first read (lines 182-192)**

```ts
let _cachedConfig: JwtAuthConfig | null = null;
export function getCachedJwtAuthConfig(): JwtAuthConfig {
  if (!_cachedConfig) { _cachedConfig = getJwtAuthConfig(); }
  return _cachedConfig;
}
```

If `WOLFPACK_JWT_SECRET` is changed after server start, the old value is used until restart. This is documented behavior. **Severity: INFO** — server restart is required for env changes.

---

## G. worktree.ts — Path Traversal & Race Condition Audit

### G.1 Path Traversal

**WT-PT1: `createWorktree()` — `branchName` flows into filesystem path (line 48-50)**

```ts
const slug = branchName.replace(/^ralph\//, "").replace(/[^a-z0-9-]/g, "-");
const realProjectDir = realpathSync(projectDir);
const worktreePath = join(realProjectDir, WORKTREE_DIR, slug);
```

The `slug` derivation strips all non-`[a-z0-9-]` characters, making path traversal via `..` impossible (dots are replaced with `-`). The slug can only contain lowercase letters, digits, and hyphens. **Well-defended.**

However, `branchName` is passed to git as-is:

```ts
execFileSync("git", ["worktree", "add", worktreePath, "-b", branchName, baseBranch], ...);
```

If `branchName` starts with `--`, it becomes a git flag. Callers use `worktreeBranchName()` in ralph-macchio which prefixes with `ralph/`, preventing `--` injection. But `createWorktree()` itself doesn't validate the branch name — it trusts the caller.

**Severity: LOW** — all current callers produce safe branch names (prefixed with `ralph/`). Adding `--` separator before positional args would be defense-in-depth.

**WT-PT2: `createWorktree()` — `baseBranch` passed to git without `--` separator (line 53)**

```ts
execFileSync("git", ["worktree", "add", worktreePath, "-b", branchName, baseBranch], ...);
```

`baseBranch` comes from `POST /api/ralph/start` where it's validated against `BRANCH_REGEX`. The regex prevents `..` but allows names containing `/` and `.`. A branch named `--force` would pass `BRANCH_REGEX` validation... wait, no: `BRANCH_REGEX` is `/^(?!.*\.\.)(?!.*\/\/)[a-zA-Z0-9._\-/]+$/` which allows `-` so `--force` would match. However, git's `worktree add` expects the base branch as the last positional argument, and git would interpret `--force` as a ref name in this position (after `-b branchName`).

Actually, git argument parsing: `git worktree add <path> -b <branch> <base>` — the `<base>` is positional after the `-b <branch>` option. Git may still interpret `--force` as a flag if it appears where a flag is expected. Adding `--` before `baseBranch` would be safer.

**Severity: LOW** — `BRANCH_REGEX` allows `--`-prefixed strings. Fix: `["worktree", "add", worktreePath, "-b", branchName, "--", baseBranch]`.

**WT-PT3: `removeWorktree()` — `worktreePath` not validated against project boundary (line 71-86)**

```ts
export function removeWorktree(worktreePath: string, projectDir?: string): void {
  execFileSync("git", ["worktree", "remove", worktreePath], opts);
```

`worktreePath` comes from `listWorktrees()` (git's own output) or from `createWorktree()` (constructed from `WORKTREE_DIR`). There's no validation that `worktreePath` is under the project directory. If `listWorktrees()` returns a path outside the project (e.g., a manually created worktree), `removeWorktree` would remove it.

**Severity: LOW** — git `worktree remove` only removes worktrees that git tracks, so it can't delete arbitrary directories. But it could remove worktrees from other projects if they share the same git repo.

### G.2 Orphan Branch Cleanup Races

**WT-RACE1: `cleanupAllExceptFinal()` — TOCTOU between `listWorktrees()` and `removeWorktree()` (lines 129-182)**

```ts
const worktrees = listWorktrees(realProjectDir);
// ... sort, identify toRemove ...
for (const wt of toRemove) {
  removeWorktree(wt.path, realProjectDir);  // could fail if worktree was removed between list and remove
}
```

Between `listWorktrees()` and `removeWorktree()`, another process (e.g., a concurrent ralph worker) could remove or modify a worktree. The `removeWorktree` call would throw, and as documented in ERR-M4, this aborts cleanup of remaining worktrees since there's no per-iteration try/catch.

**Severity: MEDIUM** — a concurrent ralph run or manual `git worktree remove` could cause partial cleanup. The `for` loop should wrap each `removeWorktree` in try/catch (already noted in ERR-M4, confirmed here with specific race scenario).

**WT-RACE2: ralph-macchio orphan branch cleanup — race between `rev-parse --verify` and `branch -D` (ralph-macchio.ts:665-670)**

```ts
try {
  execFileSync("git", ["rev-parse", "--verify", branchName], { cwd: PROJECT_DIR, stdio: "pipe" });
  execFileSync("git", ["branch", "-D", branchName], { cwd: PROJECT_DIR, stdio: "pipe" });
} catch { /* branch doesn't exist — good */ }
```

Between `rev-parse --verify` (check exists) and `branch -D` (delete), another process could:
1. Create a worktree on that branch → `branch -D` fails (branch is checked out)
2. Delete the branch → `branch -D` fails (already gone, caught by outer catch)

Case 1 is the problematic one — it leaves the branch alive and `createWorktree` on the next line would fail with "branch already exists". The catch block would then cause the ralph worker to exit.

**Severity: LOW** — only occurs if two ralph workers target the same plan simultaneously, which is prevented by the lock file. The TOCTOU window is between two sequential `execFileSync` calls (microseconds).

### G.3 Lock File TOCTOU

**WT-LOCK1: Worktree order file not locked — concurrent appends could interleave (line 57-63)**

```ts
const orderFile = join(realProjectDir, WORKTREE_ORDER_FILE);
appendFileSync(orderFile, `${worktreePath}\n`);
```

`appendFileSync` on most filesystems is not atomic for multi-line appends. If two processes append simultaneously, lines could interleave. Since each append is a single line (path + newline), and `appendFileSync` with small writes is typically atomic on ext4/APFS, this is unlikely to cause corruption in practice.

**Severity: INFO** — theoretical interleave risk, mitigated by ralph lock file preventing concurrent runs and by the atomic nature of small `appendFileSync` calls on modern filesystems.

**WT-LOCK2: `cleanupAllExceptFinal()` rewrites order file without locking (line 177)**

```ts
try { writeFileSync(orderFile, `${final.path}\n`); } catch ...
```

If called concurrently (e.g., two cleanup processes), one write could overwrite the other. Mitigated by the ralph lock file preventing concurrent runs. **Severity: INFO.**

### G.4 Other Findings

**WT-MISC1: `listWorktrees()` trusts git output format (lines 91-123)**

```ts
for (const line of output.split("\n")) {
  if (line.startsWith("worktree ")) {
    current.path = line.slice("worktree ".length);
```

The parser trusts `git worktree list --porcelain` output format. This is a reasonable trust boundary — git is a local trusted binary. No injection possible since the data comes from git, not from user input. **Severity: INFO.**

**WT-MISC2: `removeWorktree()` uses `--force` as fallback (line 79)**

```ts
try {
  execFileSync("git", ["worktree", "remove", worktreePath], opts);
} catch (gracefulErr: any) {
  try {
    execFileSync("git", ["worktree", "remove", worktreePath, "--force"], opts);
```

The `--force` flag discards uncommitted changes. This is documented in the JSDoc. If the user has uncommitted work in a worktree, it will be lost. **Severity: INFO** — documented behavior, caller's responsibility.

**WT-MISC3: `slugifyTaskName()` collision potential (line 28-37)**

```ts
export function slugifyTaskName(header: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}
```

Two different headers could produce the same slug (e.g., "Fix: auth bug" and "Fix auth! bug" both → "fix-auth-bug"). `createWorktree` would fail when git tries to create a branch that already exists. Ralph-macchio handles this via the `rev-parse --verify` + `branch -D` pattern before creation. **Severity: INFO** — handled by caller.

---

## H. Cross-Cutting Summary — websocket, auth, worktree

| ID | Severity | Component | Finding |
|----|----------|-----------|---------|
| WS-INJ1 | LOW | websocket | No session name format validation on WS upgrade — relies solely on `isAllowedSession()` live check |
| WS-PTY3 | LOW | websocket | No re-validation of session after PTY spawn (terminal WS does periodic re-checks, PTY does not) |
| WT-PT2 | LOW | worktree | `baseBranch` in `createWorktree` passed to git without `--` separator — `BRANCH_REGEX` allows `--`-prefixed strings |
| WT-RACE1 | MEDIUM | worktree | `cleanupAllExceptFinal` has no per-iteration try/catch — concurrent worktree removal aborts remaining cleanup |
| VAL-GAP1 | LOW | validation | WS upgrade and `POST /api/poll` accept session names without format validation |
| AUTH-JWT1 | INFO | auth | JWT implementation is sound — HS256, timing-safe, proper claim validation |
| AUTH-MW3 | INFO | auth | No routes bypass auth unintentionally — complete coverage confirmed |

### Defense-in-Depth Recommendations

1. **Add `isValidSessionName()` check at WS upgrade** — `src/server/index.ts:187-188` and `:195-196` should validate `session` format before calling `isAllowedSession()`. Low effort, closes VAL-GAP1.

2. **Add `--` separator in `createWorktree()` git commands** — `["worktree", "add", worktreePath, "-b", branchName, "--", baseBranch]`. Prevents theoretical git flag injection via `baseBranch`.

3. **Wrap `removeWorktree` calls in try/catch within `cleanupAllExceptFinal` loop** — prevents one failed removal from aborting cleanup of remaining worktrees (WT-RACE1).

4. **Zero prefill buffer after dedup completes** — `prefill = Buffer.alloc(0)` after `shouldDedupeInitialAttach = false` in the PTY data handler. Frees ~256KB per session.

### Positive Security Properties Confirmed

1. **WS auth is enforced at upgrade time** for all three WS routes — cannot be bypassed by connecting without auth.
2. **CORS check on WS upgrade** prevents cross-origin WS connections.
3. **Rate limiting per-connection** (60/s) on both terminal and PTY WS handlers.
4. **Binary message size limit** (16KB) on PTY passthrough prevents large payload injection.
5. **`tmux send-keys -l`** literal mode used consistently — prevents tmux key-name injection.
6. **JWT implementation** is textbook correct — timing-safe comparison, algorithm pinning, claim validation.
7. **Auth coverage is complete** — no authenticated route found without JWT middleware, no WS route without auth.
8. **Worktree paths are slug-sanitized** — only `[a-z0-9-]` in directory names, eliminating path traversal.
9. **`realpathSync` used in worktree creation** — resolves symlinks before constructing paths.

---

# Function-Level Audit — frontend XSS

## Scope

Files audited: `public/app.ts` (3618 LOC), `public/app-grid.ts`, `public/app-ralph.ts`, `public/app-state.ts`.

Focus: DOM injection vectors — `innerHTML`, `insertAdjacentHTML`, `document.write`, template string interpolation into DOM, terminal output sanitization, escape sequence handling.

## Escaping Infrastructure

### `esc()` — `app-state.ts:6-11`

```ts
function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML.replace(/'/g, "&#39;").replace(/"/g, "&quot;");
}
```

**Verdict: SAFE.** Uses the browser's own `textContent → innerHTML` roundtrip for HTML-entity encoding, then adds single/double quote escaping. This is a well-known pattern that handles `<`, `>`, `&`, `"`, `'` correctly. Suitable for both HTML content and attribute contexts.

### `escAttr()` — `app-state.ts:16-20`

```ts
function escAttr(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"')
    .replace(/</g, "\\x3c").replace(/>/g, "\\x3e").replace(/&/g, "\\x26");
}
```

**Verdict: SAFE for `onclick="func('...')"` contexts.** Escapes JS string delimiters and HTML-significant chars. Used consistently in all inline `onclick` attribute interpolations. The replacement order is correct (backslash first).

## innerHTML Usage Analysis

Total `innerHTML` assignments found: **~50** across the four files. Categorized below.

### Category 1: Static content only (no dynamic data) — SAFE

Assignments like `el.innerHTML = ""`, `el.innerHTML = '<div class="empty">Loading...</div>'`, `el.innerHTML = '<span class="ralph-status failed">ERROR</span>'`.

Locations: `app-grid.ts:362,365,548,552`, `app.ts:121,207,1622,1627,1641,1649,1670,1699,1824,1923,1947,1953,1961,2916`, `app-ralph.ts:93,95,137,176,299,355,360,365,403,409,415,420,428`.

**No risk** — all hardcoded strings.

### Category 2: Dynamic data escaped with `esc()`/`escAttr()` — SAFE

All dynamic values interpolated into innerHTML are wrapped in `esc()` or `escAttr()`:

| Location | Dynamic data | Escaping |
|---|---|---|
| `app-grid.ts:112` | `gs.session` | `esc()` |
| `app.ts:124-125` | quick cmd labels | `esc()` |
| `app.ts:149-151` | quick cmd labels/cmds | `esc()` |
| `app.ts:211,213` | git status, error msg | `esc()` |
| `app.ts:960` | viewer conflict message | `esc()` |
| `app.ts:1382-1399` | session names, machine URLs, versions, lastLine, triage | `esc()`/`escAttr()` |
| `app.ts:1630-1636` | project names | `esc()`/`escAttr()` |
| `app.ts:1684-1694` | agent labels, commands | `esc()`/`escAttr()` |
| `app.ts:2290-2298` | drawer items (session names, machine names) | `esc()`/`escAttr()` |
| `app.ts:2924-2931` | machine names, URLs | `esc()`/`escAttr()` |
| `app.ts:3280-3284` | sidebar machine names, URLs | `esc()`/`escAttr()` |
| `app.ts:3304-3326` | sidebar session cards | `esc()`/`escAttr()` |
| `app-ralph.ts:43-63` | ralph card (project, planFile, lastOutput) | `esc()`/`escAttr()` |
| `app-ralph.ts:65-73` | sidebar ralph card | `esc()`/`escAttr()` |
| `app-ralph.ts:104-118` | ralph detail header (planFile, started, finished) | `esc()`/`escAttr()` |
| `app-ralph.ts:122-128` | ralph actions (planFile, agent, worktree params) | `escAttr()` |
| `app-ralph.ts:184-200` | ralph iteration cards (title, task, body) | `esc()` |
| `app-ralph.ts:278,281` | machine picker names | `esc()` |
| `app-ralph.ts:294,362,407,422` | project/plan/branch option lists | `esc()`/`escAttr()` |

### Category 3: CSS class interpolation from hardcoded sources — SAFE

Several locations interpolate CSS classes from `triageUi()`, `getRalphStatus()`, or local variables into `class="..."`:

- `triageUi()` returns values only from `TRIAGE_MAP` (hardcoded at `app.ts:1365-1369`) — `s.triage` lookups fall back to `idle` for unknown values.
- `getRalphStatus()` returns hardcoded strings: `"running"`, `"done"`, `"audit"`, `"cleanup"`, `"limit"`, `"idle"` — `app-ralph.ts:30-39`.
- Status dots: `"green"`, `"red"`, `"gray"`, `"purple"` — all hardcoded conditionals.

**No class injection vector** — even if server data contained unexpected triage values, the `TRIAGE_MAP` lookup defaults to `"idle"`.

**Note:** `s.triage` is also interpolated via `esc()` at `app.ts:1396`: `class="triage-badge ${esc(s.triage || "idle")}"`. While `esc()` prevents HTML injection, a malicious triage value like `idle" onclick="alert(1)` would be entity-encoded to `idle&quot; onclick=&quot;alert(1)` — no breakout. However, this is a CSS class context where `esc()` is technically overkill but harmless. The triage value comes from server-side classification, not raw user input.

### Category 4: Search highlighting — `app.ts:3035-3054` — **REQUIRES SCRUTINY**

```ts
function applySearchHighlights() {
  const escaped = state.lastRawPane.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escapedTerm = state.searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escapedTerm.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), "gi");
  const html = escaped.replace(re, (m) => `<mark class="${cls}">${m}</mark>`);
  term.innerHTML = html;
}
```

**Verdict: SAFE.** The pane content is HTML-escaped first (`&`, `<`, `>` replaced with entities), then the search term regex operates on the *escaped* string. The `<mark>` tags wrap matches from the already-escaped content. The search term itself comes from user keyboard input (not from the URL or external source), and is regex-escaped before use. The matched content `m` is a substring of the already-HTML-escaped pane text.

**Edge case considered:** Could `escapedTerm` contain entity sequences that match across escape boundaries? No — the search term is also entity-escaped with the same replacements, so it can only match entity-encoded forms, preserving alignment.

## Terminal Output Rendering

### Mobile terminal (capture-pane polling) — `app.ts:1971-1993`

```ts
function applyTerminalPane(pane) {
  term.textContent = pane;  // line 1985
}
```

**Verdict: SAFE.** Uses `textContent`, not `innerHTML`. The raw pane content (from `tmux capture-pane`) is assigned as text, so no HTML parsing occurs. ANSI escape sequences and terminal control characters are rendered as literal text (visible as garbage chars on mobile — this is intentional for the mobile polling UI).

**Snapshot restore also uses `textContent`**: `app.ts:1584` — `term.textContent = cached || ""`.

### Desktop terminal (Ghostty-web PTY)

The desktop terminal uses Ghostty-web (`ghostty-web.bundle.js`), a compiled WebAssembly terminal emulator. PTY data flows through a WebSocket as binary data directly to the WASM renderer. The terminal emulator handles escape sequence parsing internally — there is no DOM innerHTML injection from PTY data. XSS via terminal escape sequences is not applicable here because Ghostty renders to a Canvas/WebGL surface, not to the DOM.

### Terminal escape sequence attacks

**Attack vector considered:** A malicious process in a tmux session outputs crafted terminal escape sequences (e.g., OSC title-setting sequences, hyperlink escapes) hoping to inject into the DOM.

- **Mobile path:** `textContent` assignment — completely immune. Escape sequences render as literal characters.
- **Desktop path:** Ghostty WASM renderer — escape sequences are interpreted by the terminal emulator, not the DOM. Standard terminal emulators handle OSC/CSI sequences in their own state machine. No DOM injection vector.
- **Search path:** Pane content is HTML-entity-escaped before `innerHTML` assignment — escape sequences become visible entity-encoded text.

**Verdict: NOT VULNERABLE.**

## Content Security Policy

CSP is enforced on HTML responses (`src/server/http.ts:137-144`):

```
default-src 'self'; script-src 'self' 'nonce-{random}'; style-src 'self' 'unsafe-inline';
connect-src 'self' wss: https:; img-src 'self' data:
```

**Script execution is nonce-gated** — even if an innerHTML injection were found, injected `<script>` tags would be blocked by CSP. The `'unsafe-inline'` on `style-src` means CSS injection via `<style>` tags could theoretically work, but this requires an innerHTML injection first (none found).

**Note:** Inline event handlers (`onclick`) in the existing HTML are allowed because they're in the nonce'd script's DOM mutations, not in the initial HTML. However, CSP `script-src` without `'unsafe-inline'` means injected `onclick` attributes via innerHTML would also be blocked by CSP in modern browsers. This provides defense-in-depth.

## Peer Data Trust Boundary

Remote peer data (from Tailscale peer machines) flows through `validatePeerLoops()` (`src/server/routes.ts:98-129`), which:

1. Validates top-level structure (`loops` array of objects).
2. Requires `project` to be a string.
3. Allowlists keys via `RALPH_LOOP_SCHEMA` — only known keys with correct types pass through.

String fields from peers (`project`, `planFile`, `agent`, `lastOutput`, `started`, `finished`, `worktreeMode`, `worktreeBranch`) are passed to the client and rendered. All are escaped with `esc()` or `escAttr()` before DOM insertion (verified in Category 2 above).

**Verdict: SAFE.** A malicious peer could send `project: "<img onerror=alert(1) src=x>"` — this gets escaped to `&lt;img onerror=alert(1) src=x&gt;` by `esc()`.

## Other Patterns Checked

| Pattern | Found | Assessment |
|---|---|---|
| `document.write()` | No | Not used anywhere |
| `insertAdjacentHTML()` | No | Not used anywhere |
| `eval()` / `new Function()` | No | Not used in app code (only in Ghostty bundle) |
| `setTimeout(string)` | No | Only `setTimeout(() => ..., N)` form used |
| URL-controlled DOM content | No | No `location.hash`/`location.search` parsed into DOM |
| `srcdoc` on iframes | No | No iframes used |
| `DOMParser` | No | Not used |

## Findings Summary

### Vulnerabilities Found: **0**

No XSS vulnerabilities identified. The codebase demonstrates consistent, correct escaping discipline:

1. **All** dynamic values going into `innerHTML` are wrapped in `esc()` (for HTML content) or `escAttr()` (for JS string contexts inside inline event handlers).
2. Terminal output uses `textContent` (mobile) or WASM rendering (desktop) — no DOM injection surface.
3. Search highlighting pre-escapes pane content before `innerHTML` assignment.
4. CSP with script nonces provides defense-in-depth against any hypothetical injection.
5. Peer data is schema-validated server-side and escaped client-side.

### Informational Notes

1. **INF-XSS1: `unsafe-inline` in `style-src`** — `src/server/http.ts:141`. Allows CSS injection if an innerHTML vulnerability were ever introduced. Consider migrating inline styles to classes and removing `'unsafe-inline'` from `style-src`. **Low priority** — no injection vector exists currently.

2. **INF-XSS2: Heavy reliance on string-template HTML construction** — The codebase builds HTML via string concatenation/template literals rather than using DOM APIs (`createElement`/`appendChild`). While all interpolations are currently escaped, this pattern is more error-prone for future changes. A single forgotten `esc()` call on a new field would introduce XSS. Consider documenting the escaping convention prominently for contributors.

3. **INF-XSS3: `escAttr()` does not escape backticks** — `app-state.ts:18`. If `escAttr()` were ever used inside a template literal context (`` ` ``), a backtick in user data could break out. Currently all `escAttr()` usage is inside single-quoted JS string literals in `onclick` attributes, where backticks are harmless. **No current risk**, but worth noting for future use.

---

# Simplification Opportunities

> Refactoring analysis performed 2026-03-20. Covers file decomposition, route extraction, shared utility consolidation, and dead code identification.

## S1. `public/app.ts` Decomposition (3618 LOC)

The frontend monolith contains ~11 distinct domains in a single file. Three modules have already been extracted (`app-state.ts`, `app-ralph.ts`, `app-grid.ts`). The remaining file is ripe for further decomposition.

### Proposed Module Extractions (by priority)

| Module | Lines | Size | Priority | Rationale |
|--------|-------|------|----------|-----------|
| **app-pty.ts** | 221-968 | ~748 | HIGH | PTY socket client, terminal instance, hydration controller, reconnect engine, conflict overlay. Self-contained factory functions with minimal external deps. Largest single extraction. |
| **app-sidebar.ts** | 3233-3459 | ~227 | HIGH | Desktop-only session sidebar with pinning, drag-resize, refresh polling. Has its own internal state (`sidebarRefreshTimer`, `_sidebarRafId`, `_lastSidebarHtml`). Clean boundary. |
| **app-drawer.ts** | 2256-2550 | ~295 | HIGH | Mobile-only session switcher drawer with drag-to-dismiss animation. Minimal external deps (`state`, `getMachines()`, `haptic()`). |
| **app-terminal-ui.ts** | 1929-2255 | ~327 | MEDIUM | Mobile terminal rendering, connection state, follow mode, WS polling. Depends on `createReconnector()` from app-pty — extract after Phase 1. |
| **app-swipe.ts** | 3081-3232 | ~152 | MEDIUM | Mobile swipe gesture engine (IIFE wrapping touch handlers). Deps: `state`, `showView()`, `isDesktop()`. |
| **app-search.ts** | 2985-3080 | ~96 | MEDIUM | Mobile terminal search with highlight and pagination. Deps: `state`, DOM refs only. |
| **app-project-picker.ts** | 1614-1793 | ~180 | LOW | New session creation flow (project selection -> agent picker -> session creation). Needs `api()` injection. |

### Phased Extraction Plan

**Phase 1** — Extract `app-pty.ts` + `app-drawer.ts` + `app-sidebar.ts` → removes ~1,270 lines (35%)

**Phase 2** — Extract `app-terminal-ui.ts` + `app-swipe.ts` + `app-search.ts` → removes ~575 lines (16%)

**Phase 3** — Extract `app-project-picker.ts` → removes ~180 lines (5%)

**Result:** `app.ts` drops from 3,618 to ~1,363 lines (core orchestration, view switching, event binding, machine registry).

### Critical Dependencies to Manage

- **`api(path, opts, machineUrl)`** (line 1116) — universal fetch wrapper used everywhere. Keep in `app.ts` or extract to `app-api.ts` and import.
- **`state` object** — already in `app-state.ts`, other modules import from there.
- **`showView(name)`** (line 1149) — view orchestration entry point. Keep in `app.ts` as the coordinator.
- **`WP` global** — terminal methods from `wolfpack-lib.js`. Already global, no change needed.

---

## S2. `src/server/routes.ts` Route Group Extraction (909 LOC)

Six logical domains identified. Ralph routes dominate at ~45% of file size.

### Proposed Route Files

| File | Routes | Lines | Size | Priority |
|------|--------|-------|------|----------|
| **routes/ralph.ts** | `/api/ralph`, `/branches`, `/plans`, `/log`, `/start`, `/task-count`, `/cancel`, `/dismiss` | 502-908 + schema/helpers | ~406 | HIGH |
| **routes/session.ts** | `/api/sessions`, `/api/send`, `/api/key`, `/api/kill`, `/api/resize` | 264-333, 432-462 | ~199 | MEDIUM |
| **routes/projects.ts** | `/api/projects`, `/api/next-session-name`, `/api/create` | 335-389 | ~55 | LOW |
| **routes/settings.ts** | `/api/settings` GET/POST | 391-430 + loadSettings/saveSettings | ~80 | LOW |
| **routes/static.ts** | `/`, `/manifest.json`, `/sw.js`, `/api/info` | 231-262 | ~32 | LOW |
| **routes/git.ts** | `/api/poll`, `/api/git-status`, `/api/discover` | 464-501 | ~38 | LOW |

### Prerequisites

Extract shared validation helpers first:
- `validateProject(res, project)` (line 132-138)
- `validateProjectDir(res, projectDir)` (line 140-157)
- `resolveProjectDir(res, project)` (line 171-176)

These are used by both Projects and Ralph route groups.

### Extraction Priority

Start with `routes/ralph.ts` — it's the largest group (406 lines, 8 endpoints), has self-contained state (lock file management, process spawning, schema validation), and its removal alone cuts the main file by 45%.

---

## S3. `src/ralph-macchio.ts` Separation (1049 LOC)

### Proposed Extractions

| Module | Lines | Size | What |
|--------|-------|------|------|
| **ralph-plan.ts** | 158-270 | ~113 | Plan I/O: `readPlan()`, `readCompletedTasks()`, `markTaskCompleted()`, `extractCurrentTask()`, `taskSectionHeader()`, `extractAllTaskKeys()`, `areAllTasksDone()` |
| **ralph-utils.ts** | 111-148, 380-395, 397-442 | ~100 | `resolveBin()`, `AGENTS` config, `getCurrentBranch()`, `worktreeBranchName()`, `parseSubtasks()`, `appendSubtasksToPlan()`, `dedupCheckboxes()` |
| **ralph-sync.ts** | 570-628 | ~59 | File sync: `syncFilesToWorktree()`, `syncProgressBack()`, `syncPlanToProject()`, `mergeTaskBranch()`, `cleanupTaskWorktree()` |

### Key Deduplication: Merge-Fail-and-Exit Pattern

Three near-identical instances at lines 782-796, 823-839, 951-964. Each performs:
1. `syncProgressBack()`
2. `mergeTaskBranch()` check
3. Log failure message
4. `syncPlanToProject()`
5. `logSummary()`
6. `appendFileSync(LOG_FILE, 'finished: ...')`
7. `removeLock()`
8. `process.exit(1)`

**Proposed consolidation:**

```typescript
function mergeOrFail(branch: string, worktree: string | null, tasksCompleted: number, subtasksAdded: number): void {
  syncProgressBack();
  if (!mergeTaskBranch(branch)) {
    appendFileSync(LOG_FILE, `\n=== Merge failed for ${branch} — stopping ===\n`);
    if (worktree) {
      appendFileSync(LOG_FILE, `Task worktree preserved at: ${worktree}\nMain worktree: ${mainWorkDir}\n`);
    }
    syncPlanToProject();
    logSummary(tasksCompleted, subtasksAdded);
    appendFileSync(LOG_FILE, `finished: ${new Date().toString()}\n`);
    removeLock();
    process.exit(1);
  }
}
```

Reduces ~45 lines of duplication to 3 call sites.

### State Consolidation

Lines 43-74 declare ~15 module-level `let`/`const` variables (some named as constants in ALL_CAPS but actually reassigned: `mainWorkDir`, `workingDir`, `PLAN_PATH`, `PROGRESS_PATH`). Should be consolidated into a `RalphConfig` object and a `RalphState` object to clarify what's immutable vs. mutable.

### `main()` Function Decomposition (285 lines, 695-979)

The main iteration loop handles: worktree setup, formatting, dedup, task extraction, section switching, corruption recovery, iteration execution, subtask expansion, and final merge. Could be split into:
1. `setupWorktrees()` — lines 701-750
2. `runIterationLoop()` — lines 765-948
3. `finalizeWorktrees()` — lines 950-966

---

## S4. Shared Utility Patterns (Copy-Paste)

### S4.1 WebSocket URL Construction (2 copies)

`buildUrl()` inside `createPtySocketClient` (line ~521) and `mobileTerminalWsUrl()` (line ~2042) implement identical logic: resolve protocol (`wss:` vs `ws:`), construct host from machine URL or `location`, append path + query params.

**Fix:** Extract `buildWsUrl(machineUrl: string | null, path: string, session: string): string`.

### S4.2 Sidebar Collapse/Expand (4+ inline copies)

`classList.add/remove("collapsed")` + `state.sidebarCollapsed = true/false` + `state.sidebarAutoExpanded = false` repeated at lines ~1247, ~1530, ~2816, and throughout `initSidebar()` (~3330-3417).

**Fix:** Extract `setSidebarCollapsed(collapsed: boolean)`.

### S4.3 Quick Command Persistence Triple (4 copies)

`saveQuickCmds()` + `renderQuickCmdSettings()` + `renderCmdPalette()` always called together at lines ~167, ~180, ~187, ~198.

**Fix:** Extract `persistAndRenderQuickCmds()`.

### S4.4 Session Key Construction (4 inconsistent functions)

`sessionKey()`, `terminalSessionKey()`, `snapshotKey()`, `draftKey()` at lines ~223, ~971, ~997, ~1931 all construct `localStorage` keys from machine+session but with inconsistent calling conventions (some take params, some read globals).

**Fix:** Unify into `storageKey(namespace: string, machine: string, session: string): string`.

### S4.5 `shellEscape` Re-implemented in Tests

`tests/unit/shell-escape.test.ts:5` re-implements `shellEscape` locally instead of importing from `src/validation.ts`. The test has a stale comment claiming the function isn't exported — it is.

**Fix:** `import { shellEscape } from "../../src/validation"` in the test file.

---

## S5. Dead Code

### S5.1 Confirmed Dead

| ID | Location | What | Evidence |
|----|----------|------|----------|
| **DC-1** | `public/app.ts:955` | `var encodeTerminalBinary = WP.encodeTerminalBinary` | Assigned, never read. Zero grep hits beyond declaration. |
| **DC-2** | `public/app.ts:2257-2259` | `drawerDragY`, `drawerDragStartY`, `drawerDragging` | Declared at module scope, never read or written. Remnants of abandoned drawer-drag feature. |
| **DC-3** | `src/ralph-macchio.ts:86-93` | `IS_WIN` / Windows path augmentation | Tool targets macOS/Linux only. Dead codepath. |
| **DC-4** | `src/server/index.ts:215` | `export function startServer()` | Exported but never imported by any other module. Only called internally at line 239. Export keyword is noise. |

### S5.2 Candidates Requiring Verification

| ID | Location | What | Status |
|----|----------|------|--------|
| **DC-5** | `public/app.ts:3605-3617` | `Object.assign(window, {...})` global exports | Many of these are referenced by inline `onclick` attributes in HTML strings. As onclick handlers are migrated to delegated listeners (per recommendation 9.3), these exports become dead. Track during migration. |

---

## S6. Recommended Execution Order

1. **Dead code removal** (S5.1) — zero-risk cleanup, immediate size reduction
2. **Dedup merge-fail-and-exit** in ralph-macchio (S3) — reduces bug surface in the most complex loop
3. **Extract `routes/ralph.ts`** (S2) — biggest single-file improvement for server code
4. **Extract `app-pty.ts`** (S1 Phase 1) — largest client extraction, cleanest boundary
5. **Extract remaining app modules** (S1 Phase 2-3) — progressive decomposition
6. **Consolidate shared utilities** (S4) — cross-cutting cleanup, lower priority
