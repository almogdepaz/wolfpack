# Wolfpack Audit Context

> Structured architectural context for security review. Generated 2026-03-20.

## 1. System Overview

**Wolfpack** is a mobile command center for tmux-based AI agent sessions. It runs as a local HTTP+WS server (default `:18790`) that exposes a web UI for managing tmux sessions, spawning AI agents (Claude, Codex, Gemini, Cursor), and running automated task loops ("Ralph").

**Tech stack:** Bun runtime, Node.js stdlib, `ws` library, Ghostty-web terminal emulator (client-side), no framework (raw `http.createServer`).

**Deployment model:** Runs as a LaunchAgent/systemd service on the developer's machine. Accessible locally and over Tailscale (HTTPS).

---

## 2. Entry Points

### 2.1 HTTP Routes (`src/server/routes.ts`)

| Method + Path | Auth | Description |
|---|---|---|
| `GET /` | No | Serves index.html (CSP-protected) |
| `GET /manifest.json` | No | PWA manifest with dynamic name from query param |
| `GET /sw.js` | No | Returns 404 (no service worker) |
| `GET /api/info` | **No** (public) | Returns hostname + version |
| `GET /api/sessions` | JWT | Lists tmux sessions with triage status |
| `POST /api/send` | JWT | Sends text to tmux session via `send-keys -l` |
| `POST /api/key` | JWT | Sends a key (from allowlist) to tmux session |
| `GET /api/projects` | JWT | Lists directories under `~/Dev` |
| `GET /api/next-session-name` | JWT | Generates unique tmux session name |
| `POST /api/create` | JWT | Creates tmux session, optionally runs agent cmd |
| `GET /api/settings` | JWT | Returns bridge settings |
| `POST /api/settings` | JWT | Updates agent command, custom commands |
| `POST /api/kill` | JWT | Kills tmux session |
| `POST /api/resize` | JWT | Resizes tmux pane |
| `GET /api/discover` | JWT | Discovers Tailscale peers running wolfpack |
| `GET /api/poll` | JWT | Captures tmux pane content |
| `GET /api/git-status` | JWT | Runs `git status` in session's project dir |
| `GET /api/ralph` | JWT | Returns Ralph loop statuses (local + aggregated peers) |
| `GET /api/ralph/branches` | JWT | Lists git branches for project |
| `GET /api/ralph/plans` | JWT | Lists .md files in project dir |
| `GET /api/ralph/log` | JWT | Tail of `.ralph.log` file |
| `POST /api/ralph/start` | JWT | Spawns Ralph worker subprocess |
| `GET /api/ralph/task-count` | JWT | Counts tasks in plan file |
| `POST /api/ralph/cancel` | JWT | Sends SIGTERM to Ralph process |
| `POST /api/ralph/dismiss` | JWT | Cleans up Ralph log/lock/progress files |

### 2.2 WebSocket Endpoints (`src/server/index.ts`, `src/server/websocket.ts`)

| Path | Auth | Description |
|---|---|---|
| `/ws/terminal` (alias `/ws/mobile`) | JWT (query `token` allowed) | Mobile terminal: capture-pane polling, sends input/keys to tmux |
| `/ws/pty` | JWT (query `token` allowed) | Desktop terminal: PTY attach via `tmux attach-session`, binary data passthrough |

### 2.3 CLI Commands (`src/cli/index.ts`)

| Command | Description |
|---|---|
| `wolfpack` (no args) | Starts service, prints QR code for mobile |
| `wolfpack setup` | Interactive setup (tailscale hostname, dev dir, port) |
| `wolfpack service [install\|uninstall\|start\|stop\|status]` | Manage LaunchAgent/systemd service |
| `wolfpack uninstall` | Full uninstall |
| `wolfpack migrate-plan <file>` | Migrates old plan format to new |
| `wolfpack worker --plan ... --iterations ...` | Ralph worker (spawned by server, not user-facing) |

### 2.4 WebSocket Message Types

**Inbound (client → server):**

| Handler | Message Type | Fields | Action |
|---|---|---|---|
| Terminal WS | `input` | `data: string` | `tmuxSend(session, data, noEnter=true)` |
| Terminal WS | `key` | `key: string` | `tmuxSendKey(session, key)` — validated against `WS_ALLOWED_KEYS` |
| Terminal WS | `resize` | `cols, rows: number` | `tmuxResize(session, cols, rows)` |
| PTY WS | `attach` | `cols, rows: number, skipPrefill?: bool` | Spawns PTY subprocess (`tmux attach-session`) |
| PTY WS | `resize` | `cols, rows: number` | Resizes PTY terminal + tmux window |
| PTY WS | `take_control` | (none) | Displaces current viewer, takes over PTY |
| PTY WS | (binary) | raw bytes | Written directly to PTY terminal stdin |

**Outbound (server → client):**

| Message Type | Description |
|---|---|
| `output` | Capture-pane content (terminal WS polling) |
| `viewer_conflict` | Another viewer owns the PTY session |
| `control_granted` | Take-control succeeded |
| `attach_ack` | PTY attach handshake acknowledged |
| `prefill_done` | Scrollback prefill complete |
| (binary) | Raw PTY output data (desktop mode) |

---

## 3. Trust Boundaries

### 3.1 Authentication: JWT (HS256)

- **Config:** `WOLFPACK_JWT_SECRET` env var (min 32 chars to enable). Source: `src/auth.ts`.
- **Bypass:** If `WOLFPACK_JWT_SECRET` is unset or too short, auth is **disabled** — `validateRequestJwt()` returns `{ ok: true }`.
- **Public endpoint:** `/api/info` is explicitly exempt from auth.
- **WS auth:** Supports `?token=` query param for WebSocket upgrade (browsers can't set Authorization headers on WS).
- **Token extraction:** `extractBearerToken()` handles `Authorization: Bearer <token>` header.
- **Validation:** Standard HS256 with `exp`/`nbf`/`iat`/`iss`/`aud` claims, timing-safe comparison, 30s clock tolerance.

### 3.2 CORS

- **Allowlist** (`src/server/index.ts:55`): `http://localhost:<PORT>`, `http://127.0.0.1:<PORT>`.
- **Tailnet:** Any `https://*.{tailnet_suffix}` origin is allowed.
- **Test mode:** `WOLFPACK_TEST` allows any `http://127.0.0.1:*` origin.
- **Enforcement:** Both HTTP requests and WS upgrades check origin. Non-matching origins get 403.

### 3.3 Tailscale Assumptions

- Peer discovery uses `tailscale status --json` to find online peers.
- Peer probing fetches `/api/info` over HTTPS to detect wolfpack instances.
- Ralph aggregation forwards the caller's `Authorization` header to peers (credential forwarding).
- **Implicit trust:** Tailscale peers are assumed to be trusted. No additional peer authentication beyond Tailscale's network-level auth.

### 3.4 tmux Session Boundary

- `isAllowedSession()`: Session must exist in `tmux list-sessions` AND its `pane_current_path` must be under `DEV_DIR` (default `~/Dev`).
- Sessions prefixed `wp_` are filtered out (internal PTY helper sessions).
- `isUnderDevDir()`: Uses proper path-boundary check (not just `startsWith`).
- `sessionDirMap`: In-memory cache mapping session → project directory. Populated at session creation, backfilled from tmux env.

### 3.5 File System Boundaries

- `DEV_DIR`: Configurable via `WOLFPACK_DEV_DIR` env or defaults to `~/Dev`.
- `validateProjectDir()`: Rejects symlinks, verifies `realpath()` is under `DEV_DIR`.
- `SAFE_FILENAME` regex: `/^[a-zA-Z0-9._\- ]+$/` — no path separators, no `..`.
- Settings file: `~/.wolfpack/bridge-settings.json` — read/write with CMD_REGEX validation on commands.
- Ralph log/lock/progress: Written inside project directories under DEV_DIR.

---

## 4. Data Flow Graphs

### 4.1 User Input → tmux Shell Execution

```
Client (browser)
  │
  ├─ POST /api/send { session, text, noEnter }
  │   → isAllowedSession(session)
  │   → tmuxSend(session, text, noEnter)
  │     → exec("tmux", ["send-keys", "-l", "-t", session, text])
  │     → exec("tmux", ["send-keys", "-t", session, "Enter"])  // unless noEnter
  │
  ├─ POST /api/key { session, key }
  │   → isAllowedSession(session)
  │   → key ∈ allowlist? (Enter, Tab, Escape, arrows, C-c, C-d, C-z, y, n, BTab)
  │   → tmuxSendKey(session, key)
  │     → exec("tmux", ["send-keys", "-t", session, key])
  │
  ├─ WS /ws/terminal { type: "input", data }
  │   → rate limiter (60/sec)
  │   → msg.length ≤ 65536
  │   → tmuxSend(session, data, noEnter=true)
  │
  ├─ WS /ws/terminal { type: "key", key }
  │   → rate limiter (60/sec)
  │   → key ∈ WS_ALLOWED_KEYS (broader set than HTTP)
  │   → tmuxSendKey(session, key)
  │
  └─ WS /ws/pty (binary data)
      → rate limiter (60/sec)
      → buffer.length ≤ 16384
      → proc.terminal.write(raw)  // direct PTY stdin
```

**CRITICAL PATH:** `POST /api/send` passes `text` directly to `tmux send-keys -l`. The `-l` flag treats input as literal characters (not tmux key names). **No shell escaping** of the text content — it's injected verbatim into the active tmux pane.

### 4.2 Session Creation → Agent Spawn

```
POST /api/create { project, cmd, sessionName, newProject }
  → validateProject(project)  // regex: /^[a-zA-Z0-9._-]+$/
  → cmd validation: CMD_REGEX /^[a-zA-Z0-9 \-._/=]+$/
  → validateProjectDir(projectDir)  // no symlinks, realpath under DEV_DIR
  → tmuxNewSession(name, projectDir, cmd)
    → agentCmd = cmd || settings.agentCmd || "claude"
    → if agentCmd === "shell": spawn shell directly
    → else: injectAgentContext(agentCmd)
      → for claude: appends "--append-system-prompt <context>"
      → for gemini: appends "-i <context>"
    → shellCmd = `env -u CLAUDECODE ... SHELL -lic '${fullCmd}; exec SHELL'`
    → exec("tmux", ["new-session", "-d", "-s", name, "-c", projectDir, shellCmd])
```

### 4.3 Ralph Plan → Shell Execution

```
POST /api/ralph/start { project, iterations, planFile, agent, ... }
  → resolveProjectDir(project)  // validated
  → planFile validated: PLAN_FILE_REGEX, exists on disk
  → acquire .ralph.lock (atomic create, stale-check)
  → spawn detached child: `wolfpack worker --plan <file> --iterations <N> --agent <agent>`
    │
    └─ ralph-macchio.ts (detached process)
        → parseArgs for --plan, --iterations, --agent, --worktree, etc.
        → AGENTS[agent].bin resolved via `which`
        → Per iteration:
          → extractCurrentTask() from plan file
          → buildPrompt(task) — injects RALPH_AGENT_CONTEXT + task + instructions
          → runIteration(prompt):
            → spawn(agent.bin, agent.args(prompt), { cwd: workingDir })
            → e.g. claude --print --dangerously-skip-permissions --allowedTools <list> -p <prompt>
            → stdout/stderr → .ralph.log
          → parse output for <subtasks> → appendSubtasksToPlan()
          → markTaskCompleted() in progress.txt
        → Final phases: audit-fix, cleanup (same agent spawn pattern)
```

### 4.4 Peer Ralph Aggregation

```
GET /api/ralph?aggregate=true
  → local scanRalphLoops()
  → for each cachedPeer:
    → fetch(peer.url + "/api/ralph", { headers: { Authorization: req.headers.authorization } })
    → validatePeerLoops(peerName, data)  // schema-validated, unknown keys stripped
  → merge local + remote loops
```

---

## 5. State Management

### 5.1 In-Memory State

| State | Location | Lifecycle |
|---|---|---|
| `activePtySessions` | `websocket.ts` Map<session, {viewer, proc, alive}> | Per WS connection, cleaned on disconnect |
| `sessionDirMap` | `tmux.ts` Map<session, dir> | Populated at create, backfilled from tmux env |
| `prevPaneContent` | `routes.ts` Map<session, content> | For content-diff triage, per session |
| `cachedPeers` | `http.ts` array | Updated on `/api/discover` call |
| `_backfillCacheMap` | `tmux.ts` Map<session, {dir, ts}> | 30s TTL cache for tmux env lookups |
| `_triageCacheMap` | `tmux.ts` Map<session, {content, ts}> | 500ms TTL for rapid polling |
| `_cachedConfig` (JWT) | `auth.ts` | Read once at import, cached forever |

### 5.2 File-Based State

| File | Location | Purpose |
|---|---|---|
| `~/.wolfpack/config.json` | Home dir | Port, devDir, tailscaleHostname |
| `~/.wolfpack/bridge-settings.json` | Home dir | Agent command, custom commands |
| `<project>/.ralph.log` | Project dir | Ralph iteration log, header metadata |
| `<project>/.ralph.lock` | Project dir | PID-based mutex for ralph runs |
| `<project>/progress.txt` | Project dir | Completed task keys (`DONE: section: ...`) |
| `<project>/.ralph_iter.tmp` | Project dir | Last iteration output (ephemeral) |
| `<project>/.wolfpack/worktrees/` | Project dir | Git worktree directories |
| `<project>/.wolfpack/worktree-order.txt` | Project dir | Creation order for cleanup |

### 5.3 tmux Session State

- Sessions persist across server restarts (tmux is independent).
- `WOLFPACK_PROJECT_DIR` env var stored in tmux session env for backfill.
- Orphan `wp_*` sessions cleaned at server startup.

---

## 6. Attack Surface Inventory

### 6.1 Command Injection Vectors

| ID | Vector | Current Mitigation | Risk |
|---|---|---|---|
| **CI-1** | `POST /api/send` text → `tmux send-keys -l` | `-l` flag (literal mode), session validated | **MEDIUM** — text is typed into whatever shell is active in the tmux pane. If the pane has a shell prompt, this is equivalent to arbitrary command execution. Auth is the only barrier. |
| **CI-2** | `POST /api/create` cmd → shell exec | `CMD_REGEX: /^[a-zA-Z0-9 \-._/=]+$/` | **LOW** — regex is restrictive, no shell metacharacters. |
| **CI-3** | `POST /api/settings` agentCmd → stored, later used in tmux new-session | `CMD_REGEX` validated on store | **LOW** — same regex. But stored value is trusted on read. |
| **CI-4** | `POST /api/ralph/start` → spawns worker with args | Args are validated (BRANCH_REGEX, PLAN_FILE_REGEX, numeric), passed as separate execFile args | **LOW** — no shell interpolation in spawn. |
| **CI-5** | WS binary data → `proc.terminal.write()` | Size limit (16KB), rate limit | **BY DESIGN** — PTY passthrough is the intended function. |
| **CI-6** | `injectAgentContext()` → `shellEscape()` on context string → shell cmd | `shellEscape` uses single-quote wrapping with `'\\''` escaping | **LOW** — well-known safe pattern. |

### 6.2 Path Traversal Vectors

| ID | Vector | Current Mitigation | Risk |
|---|---|---|---|
| **PT-1** | Project name in API calls | `isValidProjectName`: `/^[a-zA-Z0-9._-]+$/`, rejects `.` and `..` | **LOW** |
| **PT-2** | Plan file name | `PLAN_FILE_REGEX`: `/^[a-zA-Z0-9._\- ]+\.md$/`, rejects `..` and `.` | **LOW** |
| **PT-3** | `validateProjectDir()` symlink check | `lstatSync` rejects symlinks, `realpathSync` + `isUnderDevDir` | **LOW** |
| **PT-4** | Static file serving (`serveFile`) | Lookup in `assets` Map (embedded at build time), no filesystem access | **NONE** |
| **PT-5** | Catch-all static file routing | `safePath` rejects `\0` and `/`, looks up in `assets` Map | **LOW** |
| **PT-6** | Ralph log `workdir` path for task counting | Validated: `workdirPath.startsWith(projectDir)` | **LOW** |

### 6.3 Authentication & Authorization

| ID | Issue | Detail | Risk |
|---|---|---|---|
| **AA-1** | Auth disabled by default | No `WOLFPACK_JWT_SECRET` → all endpoints open | **HIGH** (if network-exposed). Mitigated by localhost binding and Tailscale assumption. |
| **AA-2** | No per-user authorization | JWT validated but no role/permission claims checked. Any valid token = full access. | **LOW** (single-user tool) |
| **AA-3** | Credential forwarding to peers | Ralph aggregation forwards `Authorization` header to Tailscale peers | **MEDIUM** — token leaks to other machines on tailnet |
| **AA-4** | WS token in query string | `?token=` for WebSocket auth — visible in server logs, browser history | **LOW** — standard WS pattern, but token could leak |

### 6.4 Denial of Service

| ID | Vector | Current Mitigation | Risk |
|---|---|---|---|
| **DOS-1** | Rapid API polling | Per-IP rate limiters: 120/s global, 10/s for poll-heavy paths | **LOW** |
| **DOS-2** | WS message flooding | Per-connection rate limiter: 60/s | **LOW** |
| **DOS-3** | Large request bodies | `MAX_BODY = 64KB` | **LOW** |
| **DOS-4** | Large WS messages | `MAX_WS_MESSAGE_BYTES = 65536`, `MAX_PTY_BINARY_BYTES = 16384` | **LOW** |
| **DOS-5** | Peer discovery SSRF | Probes only Tailscale peers via DNS, 3s timeout, only `/api/info` | **LOW** |

### 6.5 Cross-Site Scripting

| ID | Vector | Current Mitigation | Risk |
|---|---|---|---|
| **XSS-1** | HTML serving | CSP with per-request nonce: `script-src 'self' 'nonce-...'` | **LOW** |
| **XSS-2** | PWA manifest `name` injection | `customName.replace(/[^\w\s\-().]/g, "").slice(0, 50)` | **LOW** — sanitized |
| **XSS-3** | API JSON responses | All responses are `Content-Type: application/json` | **LOW** |

### 6.6 Process & Resource Management

| ID | Issue | Detail | Risk |
|---|---|---|---|
| **PR-1** | Ralph worker runs detached | `spawn(..., { detached: true, stdio: "ignore" })` + `child.unref()` | **LOW** — PID tracked in `.ralph.lock` |
| **PR-2** | Kill validation | `/api/ralph/cancel` verifies PID belongs to ralph process via `ps -p` | **LOW** — prevents killing arbitrary PIDs |
| **PR-3** | Lock file race | `writeFileSync(lock, "", { flag: "wx" })` for atomic create | **LOW** — proper TOCTOU mitigation |
| **PR-4** | Agent tool permissions | Ralph uses `--dangerously-skip-permissions` with scoped `--allowedTools` | **BY DESIGN** — agents can run commands within project dir |
| **PR-5** | Iteration timeout | 30min per iteration, `killProcessTree()` on timeout | **LOW** |

### 6.7 Information Disclosure

| ID | Vector | Detail | Risk |
|---|---|---|---|
| **ID-1** | `/api/info` (public) | Exposes hostname and version — no auth required | **LOW** |
| **ID-2** | `/api/sessions` triage | Exposes session names and last output line | **LOW** (behind auth) |
| **ID-3** | `/api/ralph/log` | Exposes full agent output (may contain secrets from codebase) | **MEDIUM** (behind auth, but log content is unrestricted) |
| **ID-4** | `/api/poll` capture-pane | Exposes full terminal screen content | **MEDIUM** (behind auth) |
| **ID-5** | Error messages | Some routes return raw `stderr` from git commands | **LOW** |

---

## 7. Component Dependency Map

```
CLI (src/cli/)
  ├── index.ts        — dispatch (setup, service, worker, migrate-plan)
  ├── setup.ts        — interactive setup wizard
  ├── config.ts       — config load/save, port management
  ├── formatting.ts   — terminal colors/formatting
  └── service.ts      — LaunchAgent/systemd management

Server (src/server/)
  ├── index.ts        — HTTP server factory, CORS, auth middleware, WS upgrade
  ├── routes.ts       — all HTTP route handlers
  ├── websocket.ts    — WS handlers (terminal polling + PTY direct)
  ├── tmux.ts         — tmux exec wrappers, session management
  └── ralph.ts        — Ralph log parsing, project scanning
  └── http.ts         — rate limiter, session helpers, body parsing, CSP, peer discovery

Shared (src/)
  ├── auth.ts             — JWT HS256 validation
  ├── validation.ts       — input validation regexes, shell escaping
  ├── wolfpack-context.ts — plan format, task counting, agent context strings
  ├── worktree.ts         — git worktree lifecycle
  ├── ralph-macchio.ts    — Ralph worker (detached process)
  ├── ralph-skill-cleanup.ts — cleanup phase prompt builder
  ├── ralph-skill-audit.ts   — audit+fix phase prompt builder
  ├── triage.ts           — session status classification
  ├── grid-logic.ts       — desktop grid layout logic
  ├── take-control-logic.ts — viewer takeover logic
  ├── terminal-input.ts   — terminal input handling
  ├── terminal-buffer.ts  — terminal output buffering
  ├── public-assets.ts    — embedded static assets
  ├── log.ts              — structured JSON logger
  └── shared/process-cleanup.ts — SIGTERM/SIGKILL process tree cleanup

Client (public/)
  ├── app.ts          — main SPA entry point
  ├── app-ralph.ts    — Ralph management UI
  ├── app-state.ts    — client-side state management
  └── app-grid.ts     — desktop grid terminal view
```

---

## 8. Key Security Properties

1. **All authenticated API endpoints go through JWT middleware** in `src/server/index.ts:126-131`.
2. **Session names are validated against live tmux state** — `isAllowedSession()` checks tmux at runtime.
3. **Project directories are path-bounded** — symlink rejection + realpath + isUnderDevDir.
4. **Shell commands use execFile (not exec)** — args are passed as arrays, not interpolated into shell strings. Exception: `tmuxNewSession` builds a shell command string, but agent command is CMD_REGEX-validated.
5. **Rate limiting is per-IP** — global (120/s) + poll-specific (10/s) + per-WS-connection (60/s).
6. **CSP with per-request nonce** prevents inline script injection.
7. **Peer response validation** — `validatePeerLoops()` schema-checks and strips unknown keys.
8. **Ralph lock file** uses atomic `wx` flag to prevent TOCTOU races.
9. **`tmux send-keys -l`** literal mode prevents key-name injection (e.g., sending "Enter" as literal text, not a keypress).
