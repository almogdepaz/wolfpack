# Session Control CLI/API

Wolfpack exposes a scriptable session surface for agents and operators. The server remains authoritative for auth, project containment, session naming, stable broker identity, and PTY operations. Commands use Wolfpack's ordinary global API auth policy and add no inter-session authorization layer.

## Create a top-level session

```bash
wolfpack session create <project> [--harness <agent>] [--prompt|--prompt-file|--plan <value>] [--json]
```

- performs one `POST /api/session-create` request.
- requires an exact existing project under `WOLFPACK_DEV_DIR`.
- selects the configured default command when `--harness` is omitted.
- accepts `pi`, `claude`, `codex`, `gemini`, or `cursor` as explicit harnesses.
- allocates `<project>`, then `<project>-2`, `<project>-3`, and so on with bounded collision retries.
- passes one explicit prompt as an opaque argv value when the harness starts; no terminal-readiness send race is involved.
- `--prompt-file <file>` reads instruction text from disk to avoid shell heredoc/quoting failures.
- `--plan <file>` verifies the file exists and generates a compact "read and implement this plan" startup prompt without copying plan contents.
- rejects prompts when the effective command is a plain shell.
- json success: `{ "ok": true, "session": string, "sessionId": string, "project": string, "harness": string }`.

## Spawn a child agent

```bash
wolfpack agent spawn <project> [--prompt|--prompt-file|--plan <value>] [--notify-parent] [--json]
```

- performs one `POST /api/session-open` request.
- requires `WOLFPACK_SESSION_NAME` and `WOLFPACK_AGENT_KIND` from the current parent agent.
- resolves the parent through structured broker identity and launches the same supported harness.
- derives `<parent>-sub-agent`, then numbered names.
- passes only explicit startup instructions; it does not inherit the parent transcript, model context, or summary.
- supports `--plan <file>` and `--prompt-file <file>` like top-level creation.
- `--notify-parent` adds a compact child instruction to call `wolfpack agent notify-parent` when done or blocked.
- stores structured parent ID/name metadata and sends a best-effort typed browser notification when opened.
- json success has the same fields as top-level creation, including stable `sessionId`.

`wolfpack session open` remains a deprecated compatibility alias for `wolfpack agent spawn`. It never means top-level creation.

## Keep handoffs short

For plan work, prefer the compact generator:

```bash
wolfpack agent spawn <project> --plan .plans/000-task.md --notify-parent --json
```

Put durable instructions in the repository plan. Do not duplicate the plan, source inventory, testing policy, and architecture in every launch prompt. For bespoke long text, write it to a file and use `--prompt-file`.

## List and inspect without terminal scraping

```bash
wolfpack list --json
wolfpack session status <session-or-id> [--json]
wolfpack session read <session-or-id> [--json]
```

- `list --json` uses the lightweight `/api/session-control/list` route and returns active structured identities as one JSON envelope, without terminal previews.
- `status` returns canonical name, stable ID, active state, project path, harness, and optional parent identity. It does not capture terminal output.
- `read` is the explicit full broker-snapshot operation.
- names remain accepted for humans; automation should retain and use `sessionId` returned by create, spawn, list, or status.
- selectors that ambiguously match a name and another session's ID fail closed.

## Send and wait

```bash
wolfpack session send <session-or-id> <text...> [--no-enter] [--json]
wolfpack session wait <session-or-id> <text> [--timeout-ms <1..600000>] [--json]
```

- `send` writes through the broker input plane and appends Enter unless `--no-enter` is set.
- `wait` checks the current snapshot, then subscribes from its sequence number with a bounded buffer and timeout.
- JSON responses return the canonical `session` and stable `sessionId`; wait also returns `matched`.

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
