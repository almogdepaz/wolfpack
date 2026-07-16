---
name: wolfpack-tailnet-control
description: Use when an agent needs to open or create a Wolfpack sub-agent session, or safely inspect/control Wolfpack terminal sessions on local or Tailscale-reachable hosts. Always use this skill for requests like "open a new <project> Wolfpack session" so the agent uses the canonical CLI instead of discovering the UI or HTTP API.
---

# Wolfpack Tailnet Session Control

Use this skill for safe Wolfpack session inspection and control. Wolfpack access
is shell access to the target machine; prefer read-only inspection until the
user explicitly asks for input/control.

## Existing References

- User setup, Tailscale, and JWT auth model: `README.md`
- Scriptable session commands: `docs/session-control.md`
- Broker/session authority and server-broker wire protocol: `docs/broker-protocol.md`
- Ralph runner response and sandbox caveats: `skills/wolfpack-ralph/SKILL.md`
- Troubleshooting local service/config failures: `docs/troubleshooting.md`

Do not copy protocol details from those docs into task output. Link or cite the
doc and use the structured CLI/API commands below.

## Current Context

Prefer explicit context from the user, runner, or environment over discovery.
Treat session selectors as opaque handles; do not parse human-readable terminal
text, card labels, previews, or UI prose to infer protocol state.

Supported current-context variables:

```bash
WOLFPACK_SESSION_NAME="pi-main"
WOLFPACK_AGENT_KIND="pi"
WOLFPACK_PROJECT_DIR="/path/to/project"
WOLFPACK_BASE_URL="http://127.0.0.1:18790"
WOLFPACK_CURRENT_MACHINE_URL="https://machine.tailnet.ts.net"
WOLFPACK_CURRENT_SESSION_ID="session-handle"
WOLFPACK_AUTH_TOKEN="optional-jwt"
```

`wolfpack session open` requires `WOLFPACK_SESSION_NAME` and
`WOLFPACK_AGENT_KIND`. Wolfpack injects them into agent sessions; do not infer
them from process names or terminal output.

Use `WOLFPACK_CURRENT_MACHINE_URL` when the task is explicitly about a remote
machine; otherwise use `WOLFPACK_BASE_URL`. If neither is present, inspect local
config only enough to build a base URL.

## Allowed Workflows

Allowed without additional confirmation when the user asks you to inspect:

- Inspect current context: identify base URL, auth token presence, and current
  session handle.
- Discover/list sessions with the HTTP API or `wolfpack ls`.
- Read a session pane or copy-text output.
- Check session git status.
- Wait/poll for state changes by repeating read-only API calls.
- Ask for attach/control guidance when the task requires live interaction.

Requires explicit user intent for the exact target/session/action:

- Send input to a session.
- Take control from another viewer.
- Create, kill, resize, or otherwise change sessions.
- Open remote hosts or expose service/network configuration.
- Trigger user-visible notifications.

Forbidden:

- Scraping browser UI prose, terminal prompts, logs, or error text as a
  protocol when structured CLI/API data exists.
- Guessing auth tokens, reading unrelated secret files, or bypassing JWT auth.
- Treating a display name as stable identity if an opaque current-context
  handle is available.
- Killing or taking over sessions as cleanup unless the user asked.

## Auth and Base URL

Build helpers in shell examples:

```bash
BASE="${WOLFPACK_CURRENT_MACHINE_URL:-${WOLFPACK_BASE_URL:-http://127.0.0.1:18790}}"
SESSION="${WOLFPACK_CURRENT_SESSION_ID:-}"
AUTH_ARGS=()
if [ -n "${WOLFPACK_AUTH_TOKEN:-}" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${WOLFPACK_AUTH_TOKEN}")
fi
```

Missing context handling:

- Missing `BASE`: read `~/.wolfpack/config.json` for `port` and
  `tailscaleHostname`; if the file is absent, ask the user which host to use.
- Missing `SESSION`: list sessions and ask the user which one to target unless
  the task already names one.
- HTTP 401/403: stop and ask for `WOLFPACK_AUTH_TOKEN` or user-side auth setup.
- Tailscale/DNS failure: ask the user to verify Tailscale and `tailscale serve`;
  do not fall back to public-network exposure.

## Read-Only Examples

List sessions:

```bash
curl -fsS "${AUTH_ARGS[@]}" "$BASE/api/sessions" | jq .
```

Read the current session pane:

```bash
test -n "$SESSION" || { echo "missing WOLFPACK_CURRENT_SESSION_ID" >&2; exit 2; }
curl -fsS "${AUTH_ARGS[@]}" \
  "$BASE/api/poll?session=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$SESSION")" \
  | jq -r .pane
```

Fetch plain text for copy/debugging:

```bash
test -n "$SESSION" || { echo "missing WOLFPACK_CURRENT_SESSION_ID" >&2; exit 2; }
curl -fsS "${AUTH_ARGS[@]}" \
  "$BASE/api/copy-text?session=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$SESSION")"
```

Check git status for the session project:

```bash
test -n "$SESSION" || { echo "missing WOLFPACK_CURRENT_SESSION_ID" >&2; exit 2; }
curl -fsS "${AUTH_ARGS[@]}" \
  "$BASE/api/git-status?session=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$SESSION")" \
  | jq -r .status
```

Wait for idle-ish stability with structured polling:

```bash
for _ in 1 2 3 4 5; do
  curl -fsS "${AUTH_ARGS[@]}" "$BASE/api/sessions" | jq .
  sleep 2
done
```

## User-Visible Control Examples

Only run these after the user asked for the exact action.

When the user asks to open or create a Wolfpack sub-agent session, use the
canonical local command directly:

```bash
wolfpack session open <project> --prompt '<instruction>' --json
```

This launches the same harness as the parent (`pi` opens Pi, `claude` opens
Claude), passes only the explicit `--prompt` instruction without inheriting the
parent transcript or model context, derives `<parent>-sub-agent` with numbered
children such as `wolfpack-sub-agent-2`, persists structured parent identity
for session-list grouping, and asks the active single-session browser to add the
child to grid view. Omit `--prompt` only when the user requested an empty child.
Do not inspect the browser UI or reconstruct `/api/create` locally.

Kill a session:

```bash
test -n "$SESSION" || { echo "missing WOLFPACK_CURRENT_SESSION_ID" >&2; exit 2; }
curl -fsS "${AUTH_ARGS[@]}" "$BASE/api/kill" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg session "$SESSION" '{session:$session}')" | jq .
```

For interactive attach/take-control automation, prefer the Wolfpack UI first.
Do not use `docs/broker-protocol.md` as a browser attach contract; it documents
the server-broker wire protocol, not `/ws/pty` viewer conflict, take-control,
prefill, or browser token-query behavior. If low-level browser attach automation
is explicitly required, inspect the current server/client implementation and
attach tests instead of guessing from the broker protocol. Browser-style
WebSocket clients that cannot set headers may pass `token=<jwt>` in the query
string; keep tokens out of logs.

## Notify the User

Only notify when the user asked or when the active task cannot proceed without
human input:

```bash
curl -fsS "${AUTH_ARGS[@]}" "$BASE/api/notify" \
  -H 'Content-Type: application/json' \
  -d '{"message":"agent needs input"}'
```
