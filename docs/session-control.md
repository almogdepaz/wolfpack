# Session Control CLI/API

Wolfpack exposes a small scriptable surface for agent automation. The server
stays authoritative for auth, session validation, and broker access; the CLI
only calls the local authenticated HTTP API except for `current-context`, which
reads Wolfpack-provided environment variables in an agent process.

## Command Surface

- `wolfpack session open <project> [--prompt <instruction>] [--json]`
  - requires `WOLFPACK_SESSION_NAME` and `WOLFPACK_AGENT_KIND`, injected by Wolfpack into the parent agent session.
  - launches the same supported harness in the exact project name.
  - derives child names from the parent: `<parent>-sub-agent`, then `<parent>-sub-agent-2`, `<parent>-sub-agent-3`, and so on.
  - optionally passes one explicit instruction to the child harness at process launch; no parent transcript, context window, summary, or model state is inherited.
  - stores structured parent session ID/name metadata; session lists visually group children under the parent without parsing names.
  - notifies the active parent viewer after creation; a browser showing that parent in single-terminal mode adds the child through its existing grid flow.
  - session creation still succeeds when no matching browser can apply the best-effort grid notification.
  - json success: `{ "ok": true, "session": string, "project": string, "harness": string }`
  - json failure: `{ "ok": false, "error": { "code": string, "message": string } }` with a nonzero exit code.
- `wolfpack session read <session> [--json]`
  - prints the current broker snapshot for a live session.
  - json: `{ "session": string, "output": string }`
- `wolfpack session send <session> <text...> [--no-enter] [--json]`
  - sends text through the server to the broker input plane.
  - appends Enter unless `--no-enter` is set.
  - json: `{ "ok": true, "session": string }`
- `wolfpack session wait <session> <text> [--timeout-ms <ms>] [--json]`
  - waits for literal UTF-8 output text in the broker output stream.
  - checks the current snapshot first, then subscribes to structured broker
    output frames until timeout.
  - json: `{ "ok": true, "session": string, "matched": true }`
- `wolfpack session current-context [--json|--shell]`
  - reports only context Wolfpack injected into the current process:
    `WOLFPACK_SESSION_NAME` and `WOLFPACK_PROJECT_DIR`.
  - `session open` additionally reads injected `WOLFPACK_AGENT_KIND` but does not expose or infer a harness through `current-context`.
  - it never guesses a target from terminal text or process ancestry.

`split` is deliberately not part of this surface. Wolfpack grid/layout state is
browser-owned. `session open` sends a typed creation notification to the parent
viewer; only the browser decides whether its current single-terminal state can
transition to grid mode.

## Exit Codes

- `0`: success
- `1`: unexpected server/API failure
- `2`: command usage error
- `3`: missing or unknown session/context
- `4`: wait timeout
- `5`: auth failure
- `6`: backend/broker unavailable

