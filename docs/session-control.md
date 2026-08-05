# Session Control CLI/API

Wolfpack exposes a scriptable session surface for agents and operators. The server remains authoritative for auth, project containment, session naming, stable broker identity, and PTY operations. Commands use Wolfpack's ordinary global API auth policy and add no inter-session authorization layer.

## Create a top-level session

```bash
wolfpack session create <project> [--harness <agent>] [--prompt|--prompt-file|--plan <value>] [--json]
```

- performs one `POST /api/session-create` request.
- requires an exact existing project under `WOLFPACK_DEV_DIR`.
- selects the configured default command when `--harness` is omitted.
- accepts `shell`, `pi`, `claude`, `codex`, `gemini`, or `cursor` as explicit harnesses.
- allocates `<project>`, then `<project>-2`, `<project>-3`, and so on with bounded collision retries.
- passes one explicit prompt as an opaque argv value when the harness starts; no terminal-readiness send race is involved.
- `--prompt-file <file>` reads instruction text from disk to avoid shell heredoc/quoting failures.
- `--plan <file>` verifies the file exists and generates a compact "read and implement this plan" startup prompt without copying plan contents.
- rejects prompts when the effective command is a plain shell.
- json success: `{ "ok": true, "session": string, "sessionId": string, "project": string, "harness": string }`.

## Spawn a child agent

```bash
wolfpack agent spawn <project> [--name <session>] [--prompt|--prompt-file|--plan <value>] [--notify-parent] [--json]
```

- performs one `POST /api/session-open` request.
- requires `WOLFPACK_SESSION_NAME` and `WOLFPACK_AGENT_KIND` from the current parent agent.
- resolves the parent through structured broker identity and launches the same supported harness.
- accepts `--name <session>` for meaningful child names such as `200-security-review`; if omitted, derives `<parent>-sub-agent`, then numbered names.
- passes only explicit startup instructions; it does not inherit the parent transcript, model context, or summary.
- supports `--plan <file>` and `--prompt-file <file>` like top-level creation.
- `--notify-parent` adds a compact child instruction to call `wolfpack agent notify-parent` when done or blocked.
- stores structured parent ID/name metadata and sends a best-effort typed browser notification when opened.
- json success has the same fields as top-level creation, including stable `sessionId`.

`wolfpack session open` remains a deprecated compatibility alias for `wolfpack agent spawn`. It never means top-level creation.

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
