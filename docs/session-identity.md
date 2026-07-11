# Session identity metadata

Wolfpack stores session identity separately from PTY liveness, status triage, and terminal snapshots.

Stored file:

- path: `$WOLFPACK_DEV_DIR/.wolfpack/session-identities.json`
- owner: Wolfpack server
- retention: one entry per live broker session; entries are pruned when broker `list_sessions` no longer reports the session and deleted when the session is killed through Wolfpack

Stored fields:

- Wolfpack broker session id and visible session name
- project path
- agent kind (`shell`, `claude`, `codex`, `pi`, `gemini`, `cursor`, or a command-derived value)
- created/restored/updated timestamps
- optional external agent id, only when exposed through structured env metadata

External agent ids are never scraped from terminal prose. Wolfpack captures them only from structured launch/discovery metadata such as `WOLFPACK_EXTERNAL_AGENT_ID` and returns a redacted value from public APIs.

Public session APIs intentionally expose `projectPath` as part of the `identity`
object so local/Tailscale clients can restore context without scraping terminal
text. Treat this as local filesystem metadata disclosure: any client authorized
to call `/api/sessions` can see the absolute project path for each session.

Launched sessions receive these context variables:

- `WOLFPACK_SESSION_NAME`
- `WOLFPACK_PROJECT_DIR`
- `WOLFPACK_AGENT_KIND`
- `WOLFPACK_EXTERNAL_AGENT_ID_FILE`

Delete `$WOLFPACK_DEV_DIR/.wolfpack/session-identities.json` to remove stored identity metadata. This does not delete broker sessions, terminal snapshots, projects, or Ralph state.
