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
