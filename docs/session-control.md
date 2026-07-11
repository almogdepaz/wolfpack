# Session Control CLI/API

Wolfpack exposes a small scriptable surface for agent automation. The server
stays authoritative for auth, session validation, and broker access; the CLI
only calls the local authenticated HTTP API except for `current-context`, which
reads Wolfpack-provided environment variables in an agent process.

## Command Surface

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
  - it never guesses a target from terminal text or process ancestry.

`split` is deliberately not part of this surface. Wolfpack grid/layout state is
browser-owned today, and adding a CLI layout command would create a second
authority path.

## Exit Codes

- `0`: success
- `1`: unexpected server/API failure
- `2`: command usage error
- `3`: missing or unknown session/context
- `4`: wait timeout
- `5`: auth failure
- `6`: backend/broker unavailable

