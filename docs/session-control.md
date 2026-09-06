# Session Control CLI/API

Wolfpack exposes a scriptable session surface for agents and operators. The server remains authoritative for auth, project selection and path validation, session naming, stable broker identity, and PTY operations. Commands use Wolfpack's ordinary global API auth policy and add no inter-session authorization layer.

## Target a configured Tailnet machine

```bash
wolfpack --machine <short-name-or-fqdn> <control-command> ...
```

The global selector supports `list`/`ls`, `session create`, deprecated `session open`, `agent spawn`, `session status`, `session read`, `session send`, `session wait`, `session prompt`, and `kill`. Other commands reject it.

A short name is expanded using the exact Tailnet suffix from configured `tailscaleHostname`. A full name must be a canonical HTTPS Tailnet hostname in that suffix; URLs, ports, paths, foreign suffixes, malformed or duplicate selectors, and missing configuration fail closed without a localhost fallback. Before any control request, the CLI sends an exact, bounded `GET /api/machine` probe with redirects disabled, a bounded timeout, and the normal Wolfpack JWT `Authorization` header when configured. The structured handshake must report the selected canonical origin and session-control capability.

Subsequent requests go directly to that verified HTTPS origin. Remote JSON successes retain every server field and add the verified identity as `"machine": { "tailnetNodeId": string, "installationId": string, "displayName": string, "origin": string }`; server-owned `sessionId` values are unchanged. Without `--machine`, request routing and JSON output remain local and unchanged.

`agent spawn` still uses `POST /api/session-open` and resolves its parent on the selected machine. It does not create cross-machine lineage: a parent absent from the selected machine fails through the existing structured response.

## Create a top-level session

```bash
wolfpack session create <project> [--harness <agent>] [--prompt|--prompt-file|--plan <value>] [--json]
wolfpack session create --project-dir <path> [--harness <agent>] [--prompt|--prompt-file|--plan <value>] [--json]
```

- performs one `POST /api/session-create` request.
- accepts exactly one project selector: an exact direct-child name under `WOLFPACK_DEV_DIR`, or `--project-dir` for an existing directory anywhere on the server host.
- resolves a relative CLI `--project-dir` against the CLI process working directory before sending it. The HTTP API accepts absolute paths only.
- rejects missing paths, files, final-component symlinks, overlong paths, and ambiguous requests containing both selectors. The server canonicalizes accepted paths before launch.
- selects the configured default command when `--harness` is omitted.
- accepts `shell`, `pi`, `claude`, `codex`, `gemini`, or `cursor` as explicit harnesses.
- allocates `<project>`, then `<project>-2`, `<project>-3`, and so on with bounded collision retries.
- passes one explicit prompt as an opaque argv value when the harness starts; no terminal-readiness send race is involved.
- `--prompt-file <file>` reads instruction text from disk to avoid shell heredoc/quoting failures.
- `--plan <file>` verifies the file exists and generates a compact "read and implement this plan" startup prompt without copying plan contents.
- rejects prompts when the effective command is a plain shell.
- json success: `{ "ok": true, "session": string, "sessionId": string, "project": string, "harness": string }`.

## Opt into Pi task-worker readiness

Add `--task-worker` to `session create` or `agent spawn` only with `--project-dir <absolute-existing-worktree>`. It requires the Pi harness, accepts optional `--model` only for child Pi sessions, and rejects named-only project selection, `--prompt`, `--prompt-file`, `--plan`, and `--notify-parent`. `--readiness-timeout-ms <1..60000>` bounds the server gate (default 30000 ms); the CLI request deadline includes a small response grace period.

Before creating anything, Wolfpack resolves and validates only the resources it will launch: `WOLFPACK_TASK_WORKER_PI_EXECUTABLE` (otherwise `pi` from `PATH`) and `WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION` (otherwise `$PI_CODING_AGENT_DIR/npm/node_modules/@sgtbeatdown/pi-tasks/src/extension.ts`, or `~/.pi/agent/...` when the Pi config directory is unset). Both configured paths must be absolute; the executable must be a regular executable file (working package-manager symlinks are accepted), and the extension must be a readable regular file.

The child launches Pi with the explicit extension and `PI_TASK_WORKER=1`; no startup assignment prompt runs. Success waits only for the exact live broker `sessionId`, exact canonical project root, Pi harness, and a lease-valid opaque relay v2 endpoint. It does not infer model readiness, task execution, or state from terminal output. A ready success additionally returns `taskEndpoint: { relay, id }`.

After creation, a failed root/identity/liveness/endpoint check or deadline kills only the exact created stable ID. Failure responses use `TASK_WORKER_NOT_READY`; they retain `createdSession` plus `cleanup: "completed" | "unconfirmed"`. Resource preflight failure returns `TASK_WORKER_PREFLIGHT_FAILED` without creating a session.

## Spawn a child agent

```bash
wolfpack agent spawn <project> [--name <session>] [--model <provider/model>] [--prompt|--prompt-file|--plan <value>] [--notify-parent] [--json]
wolfpack agent spawn --project-dir <path> [--name <session>] [--model <provider/model>] [--prompt|--prompt-file|--plan <value>] [--notify-parent] [--json]
```

- performs one `POST /api/session-open` request.
- uses the same mutually exclusive name/`--project-dir` selection and server validation as top-level creation.
- requires `WOLFPACK_SESSION_NAME` and `WOLFPACK_AGENT_KIND` from the current parent agent.
- resolves the parent through structured broker identity and launches the same supported harness.
- accepts `--name <session>` for meaningful child names such as `200-security-review`; if omitted, derives `<parent>-sub-agent`, then numbered names.
- for Pi parents only, accepts a bounded nonblank `--model <provider/model>` value and passes it unchanged to Pi's native `--model` option. Non-Pi parents reject model selection; omission preserves their existing same-harness launch behavior.
- passes only explicit startup instructions; it does not inherit the parent transcript, model context, or summary.
- supports `--plan <file>` and `--prompt-file <file>` like top-level creation.
- `--notify-parent` adds a compact child instruction to call `wolfpack agent notify-parent` when done or blocked.
- stores structured parent ID/name metadata and sends a best-effort typed browser notification when opened.
- json success has the same fields as top-level creation, including stable `sessionId`.

`wolfpack session open` remains a deprecated compatibility alias for `wolfpack agent spawn` and accepts the same selectors and optional Pi model selection. It never means top-level creation.

The browser project picker keeps the configured-root catalog as its default. **Open existing directory** accepts a server-local absolute path; it does not enumerate the filesystem or create directories outside `WOLFPACK_DEV_DIR`.

## Keep handoffs short

For plan work, prefer the compact generator:

```bash
wolfpack agent spawn <project> --name 200-implementation --plan .plans/000-task.md --notify-parent --json
```

Put durable instructions in the repository plan. Pick a short issue/role slug for `--name` so the delegation graph stays readable. Do not duplicate the plan, source inventory, testing policy, and architecture in every launch prompt. For bespoke long text, write it to a file and use `--prompt-file`.

## List and inspect without terminal scraping

```bash
wolfpack list --json
wolfpack session status <session-or-id> [--json]
wolfpack session read <session-or-id> [--json]
```

- `list --json` uses the lightweight `/api/session-control/list` route and returns active structured identities as one JSON envelope, without terminal previews.
- `status` returns canonical name, stable ID, active state, project path, `projectDir` alias, project name, harness, optional parent identity, and bounded `terminal` liveness (`ready | dead | unavailable`). Dead targets return `SESSION_DEAD`; unknown, ambiguous, and backend-unavailable targets use the same structured failure envelope. It does not capture terminal output.
- `read` is the explicit full broker-snapshot operation.
- names remain accepted for humans; automation should retain and use `sessionId` returned by create, spawn, list, or status.
- selectors that ambiguously match a name and another session's ID fail closed.
- Pi/agent task layers may use `session status <selector> --json` only as Wolfpack-owned target evidence: selector resolution, broker/session existence, stable identity, project path, harness, and terminal liveness. They must not infer Pi model readiness, task completion, or agent state from Wolfpack status.

## Parent-owned teardown

Teardown is parent-owned: when the parent decides a child is no longer needed, it must explicitly tear down that exact session. Completion or blocking alone is not an automatic cleanup trigger; a persistent role session may be retained for follow-up. In Pi, `/quit` exits the harness only; it does not call Wolfpack teardown, so the shell-backed Wolfpack session may remain active.

```bash
# Local
wolfpack kill <session-or-id> --json

# Configured Tailnet peer
wolfpack --machine <short-name-or-fqdn> kill <session-or-id> --json
```

`kill` accepts the same opaque selector rules as inspection. It uses Wolfpack's ordinary global API auth policy; `--machine` first verifies the configured Tailnet target and carries the normal JWT authorization when configured. A local JSON success is `{ "ok": true, "session": string, "sessionId": string }`; a remote JSON success retains those fields and adds verified `machine` identity. After success, verify teardown through the matching target's active-session list:

```bash
wolfpack list --json
wolfpack --machine <short-name-or-fqdn> list --json
```

The killed `sessionId` must be absent. Do not treat `/quit` as a substitute, and do not kill a session without explicit authority for that exact target.

## Send and wait

```bash
wolfpack session send <session-or-id> <text...> [--no-enter] [--json]
wolfpack session wait <session-or-id> <text> [--timeout-ms <1..600000>] [--json]
wolfpack session prompt <session-or-id> <prompt...> --until <text> [--no-enter] [--timeout-ms <1..600000>] [--json]
```

- `send` writes through the broker input plane and appends Enter unless `--no-enter` is set.
- `wait` checks the current snapshot, then subscribes from its sequence number with a bounded buffer and timeout.
- `prompt` performs one `POST /api/session-control/prompt` request. The server resolves the selector once, pins the returned `sessionId`, registers broker output observation, waits for subscription readiness, records `outputBoundarySeq`, and only then writes input to that stable ID.
- `prompt --until` is explicitly an `output contains` terminal primitive. It does not infer agent or task completion. Typed agent-state and delegated-task predicates remain deferred to #209 and #211.
- prompt outcomes are `matched`, `timed_out`, `target_exited`, `target_unavailable`, `target_replaced`, `replay_gap`, or `backend_unavailable`. The bounded JSON envelope always includes canonical `session`, stable `sessionId`, `outcome`, and nullable `outputBoundarySeq`.
- `target_replaced` means the pinned stable ID disappeared while its resolved session name now maps to a different stable ID; callers must re-resolve explicitly before retrying.
- typed agent-state/delegated-task predicates and explicit cancellation are still deferred until #211 provides the structured event/cursor substrate; `prompt --until` remains output-contains only.
- JSON responses from standalone send/wait retain their existing shape for backward compatibility.

`wolfpack agent notify-parent [--message <text>] [--json]` wraps `POST /api/notify`; it is intended for child agents launched with `--notify-parent`.

`wolfpack session current-context [--json|--shell]` reports only Wolfpack-injected name/project context. It never infers identity from process names or terminal prose.

## Exit codes

- `0`: success
- `1`: unexpected API failure or ambiguous selector
- `2`: usage error
- `3`: missing/unknown project, session, or context
- `4`: wait timeout
- `5`: auth failure
- `6`: backend unavailable

Grid/layout ownership remains in the browser. Session commands never reconstruct browser state from terminal output.
