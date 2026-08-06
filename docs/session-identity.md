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
- optional structured parent Wolfpack session id/name for sub-agent grouping
- optional external agent id, only when exposed through structured env metadata

For `POST /api/session-open`, the server derives the child harness from the active parent's structured `agentKind`; the client cannot override the harness or command. A client may request a child name, but the server validates it and allocates the canonical name, adding a bounded numeric suffix on collisions. `POST /api/session-create` creates top-level sessions and likewise keeps naming and stable broker identity server-owned. These operations follow the ordinary global API auth policy when configured and add no inter-session authorization layer. Tailnet/global Wolfpack access remains the trust boundary.

Create, spawn, list, and status responses expose the stable broker session id as `sessionId`. Scriptable status/read/send/wait/prompt/kill routes accept either that id or the active visible name, resolve it against structured identity, and fail closed when a selector is ambiguous. Atomic prompt-and-wait resolves once and uses only the pinned broker ID after that boundary, so a reused visible name cannot retarget input or satisfy the output wait.

External agent ids are never scraped from terminal prose. Wolfpack captures them only from structured launch/discovery metadata such as `WOLFPACK_EXTERNAL_AGENT_ID` and returns a redacted value from public APIs.

Public session APIs intentionally expose `projectPath` as part of the `identity`
object so local/Tailscale clients can restore context without scraping terminal
text. Treat this as local filesystem metadata disclosure: any client authorized
to call `/api/sessions` can see the absolute project path for each session.

Launched sessions receive these context variables:

- `WOLFPACK_SESSION_NAME`
- `WOLFPACK_PROJECT_DIR`
- `WOLFPACK_AGENT_KIND`
- `WOLFPACK_PARENT_SESSION_ID` and `WOLFPACK_PARENT_SESSION_NAME` for child sessions
- `WOLFPACK_EXTERNAL_AGENT_ID_FILE`

Delete `$WOLFPACK_DEV_DIR/.wolfpack/session-identities.json` to remove stored identity metadata. This does not delete broker sessions, terminal snapshots, or projects.


## Persistence privacy

Session identities use owner-only (`0600`) atomic storage under `.wolfpack` by default. Set
`WOLFPACK_SESSION_IDENTITY_MODE=memory` before starting the server to keep identity and
external-agent metadata in process memory only. Memory mode trades restart restoration for
privacy and writes no session-identity file.
