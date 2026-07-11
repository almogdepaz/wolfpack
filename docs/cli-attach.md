# CLI Attach

`wolfpack attach` connects your local terminal to an existing Wolfpack broker session through the server `/ws/pty` path.

Use it when you want real terminal controls without opening the browser. Attach does not create a new session and detaching does not kill the session.

## Usage

```bash
wolfpack attach [session] [--take-control] [--prefill full|none]
```

- `session` — target session name. If omitted, Wolfpack auto-selects only when exactly one session is active.
- `--take-control` / `--force` — displace the current controlling viewer after an explicit viewer-conflict response.
- `--prefill full` — request the current terminal snapshot before streaming live output. This is the default.
- `--prefill none` / `--no-prefill` — attach without replaying the current snapshot.

Detach with `Ctrl-]`. This closes the CLI viewer and leaves the broker session running.

## Requirements

- stdin and stdout must be interactive TTYs. Piped input/output is rejected because attach uses raw terminal IO.
- The Wolfpack server must be reachable using the normal CLI config.
- If the server requires JWT auth, run the CLI with the same `WOLFPACK_JWT_SECRET` so it can sign the WebSocket token.

## Viewer ownership

Attach uses the same viewer-control model as the browser terminal. If another viewer currently controls the session, the CLI reports a viewer conflict and exits unless `--take-control` is provided.

Do not use `--take-control` as a default. It is an operator action for intentionally taking input ownership from another browser/CLI viewer.

## Remote use

The safe remote pattern is SSHing to the Wolfpack host and running attach there:

```bash
ssh your-host
wolfpack attach my-session
```

Direct attach over a remotely reachable Wolfpack server should only be used with real authentication and trusted transport. Attach is terminal input control, so treat remote attach access like shell access to the machine.
