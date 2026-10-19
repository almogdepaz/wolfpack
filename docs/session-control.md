# Session Control CLI/API

Wolfpack exposes a scriptable session surface for agents and operators. The server remains authoritative for auth, project selection and path validation, session naming, stable broker identity, and PTY operations. Commands use Wolfpack's ordinary global API auth policy and add no inter-session authorization layer.

## Target a configured Tailnet machine

```bash
wolfpack --machine <short-name-or-fqdn> <control-command> ...
```

The global selector supports `list`/`ls`, `session create`, deprecated `session open`, `agent spawn`, `agent inbox`, `session status`, `session inbox`, `session read`, `session send`, `session wait`, `session prompt`, `kill`, and `events`. Other commands reject it.

A short name is expanded using the exact Tailnet suffix from configured `tailscaleHostname`. A full name must be a canonical HTTPS Tailnet hostname in that suffix; URLs, ports, paths, foreign suffixes, malformed or duplicate selectors, and missing configuration fail closed without a localhost fallback. Before any control request, the CLI sends an exact, bounded `GET /api/machine` probe with redirects disabled, a bounded timeout, and the normal Wolfpack JWT `Authorization` header when configured. The structured handshake must report the selected canonical origin and session-control capability.

Subsequent requests go directly to that verified HTTPS origin. Remote JSON successes retain server fields (except the task endpoint projection described below) and add the verified identity as `"machine": { "tailnetNodeId": string, "installationId": string, "displayName": string, "origin": string }`; server-owned `sessionId` values are unchanged. Without `--machine`, request routing and JSON output remain local and unchanged.

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
- `--plan <file>` sends the path to the server that runs the child. That server resolves a relative path against the selected project directory (absolute paths are unchanged), verifies it is a readable file there, and launches with a compact "read and implement this plan" prompt naming the resolved path, without copying plan contents. The prompt tells the child to follow the plan's commit/push boundary and, when the plan states none, not to commit, push, merge, or deploy. A missing, unreadable, or non-file path fails with `PLAN_FILE_UNREADABLE` and the resolved path (`planPath` in `--json` output).
- rejects prompts when the effective command is a plain shell.
- json success: `{ "ok": true, "session": string, "sessionId": string, "project": string, "harness": string }`.

## Opt into Pi task-worker readiness

Add `--task-worker` to `session create` or `agent spawn` only with `--project-dir <absolute-existing-worktree>`. It requires the child (or top-level session) to use the Pi harness; a child may select it with `--harness pi` regardless of the parent's supported harness. It accepts optional `--model` only for child Pi sessions, and rejects named-only project selection, `--prompt`, `--prompt-file`, `--plan`, and `--notify-parent`. `--readiness-timeout-ms <1..60000>` bounds the server gate (default 30000 ms); the CLI request deadline includes a small response grace period.

Before creating anything, Wolfpack resolves and validates only the resources it will launch: `WOLFPACK_TASK_WORKER_PI_EXECUTABLE` (otherwise `pi` from `PATH`) and `WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION` (otherwise `$PI_CODING_AGENT_DIR/npm/node_modules/@sgtbeatdown/pi-tasks/src/extension.ts`, or `~/.pi/agent/...` when the Pi config directory is unset). Both configured paths must be absolute; the executable must be a regular executable file (working package-manager symlinks are accepted), and the extension must be a readable regular file.

### host-owned launch policy

Workers inherit normal Pi extension discovery by default while retaining the mandatory Pi Tasks extension. Set `extensionPolicy: "isolated"` to disable discovery, or add readable absolute local extension files. The private host file is `~/.wolfpack/task-worker-policy.json`; services/tests may set the absolute `WOLFPACK_TASK_WORKER_POLICY_PATH` override. The dashboard's host-wide Agents & tools control changes only `defaults.extensionPolicy` in that private file; it never exposes or edits environment, project, extension-path, or Pi-option overrides. The policy is deliberately not a repository file: an untrusted checkout cannot select executable extensions or inject environment before Pi makes its own project-trust decision.

```json
{
  "defaults": {
    "extensionPolicy": "isolated",
    "extensions": ["/opt/wolfpack/extensions/worker-tools.ts"],
    "env": { "PI_ASYNC_PREFIX_COMPACTION_START_RATIO": "0.5" },
    "piOptions": { "thinking": "high", "offline": true }
  },
  "projects": {
    "/absolute/canonical/worktree": { "extensionPolicy": "inherit" }
  }
}
```

Precedence is defaults, then host defaults, then the canonical server project key, then the per-spawn override. Scalars replace; `extensions` replaces the optional list (`[]` clears it); `env` and `piOptions` merge by key, and a `null` override explicitly clears one inherited key. Pi Tasks remains mandatory and is canonicalized/deduplicated with optional files. Present malformed, unreadable, oversized, dangling, or unsupported configuration fails before session creation; an absent host file keeps the inherited-discovery default.

Allowed `piOptions` are only `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), `offline`, and `verbose`. Model selection remains the existing child `--model` option. There is no arbitrary argv or shell escape hatch. Worker env names, values, and count are bounded; `WOLFPACK_*`, identity/relay/config/executable-resolution variables, and shell transport values are reserved. Ordinary provider/application values and `PI_ASYNC_PREFIX_COMPACTION_START_RATIO` are allowed. After precedence and null-clearing, the aggregate UTF-8 bytes of environment names and values must not exceed 32 KiB; this cross-field byte rule is enforced at runtime because JSON Schema cannot represent it. Configured values are injected before the worker's normal `SHELL -lic` startup, so shell rc files may override them; values never appear in Pi argv.

Use `--task-worker-policy-file <local-json-file>` to send one parsed per-spawn override to the selected host. It is read locally, never embedded in a shell command. Add `--task-worker-dry-run --json` to either task-worker launch path to validate the same host/project policy without creating a session. Its typed result lists mode, canonical extension paths, safe Pi options, environment **key names only**, and source precedence; it never returns environment values or raw host policy contents.

`inherit` enables Pi's normal global and, after Pi trust, project extension discovery. Extra extensions and inherited extensions execute as the host user; this is resource selection, not a sandbox. Wolfpack never passes `--approve` or mutates Pi trust. A project may therefore prompt for trust, and readiness still proves only the live Pi session/root/relay endpoint—not extension execution, model readiness, or task success. The same policy resolves on the target host for Tailnet launches; local CLI policy-file paths are sent as parsed data, so they must not be assumed to exist remotely.

Common examples:

1. no policy file or flags: normal Pi discovery plus mandatory Pi Tasks.
2. host default `{ "extensionPolicy": "inherit" }`: normal global discovery, with project resources still subject to Pi trust.
3. canonical project override `{ "extensionPolicy": "isolated", "extensions": ["/opt/wolfpack/repo-tools.ts"] }`: discovery disabled while one local allowlisted extension remains loaded.
4. worker override `{ "env": { "PI_ASYNC_PREFIX_COMPACTION_START_RATIO": "0.5" }, "piOptions": { "thinking": "high", "offline": true } }`: safe worker env and bounded native Pi options.
5. Tailnet preview: `wolfpack --machine host.tailnet.ts.net agent spawn --project-dir /absolute/worktree --task-worker --task-worker-dry-run --json`; this evaluates the remote host policy and creates nothing.

The child launches Pi with the explicit extension and `PI_TASK_WORKER=1`; no startup assignment prompt runs. Success waits only for the exact live broker `sessionId`, exact canonical project root, Pi harness, and a lease-valid endpoint in the selected relay profile. The normal memory-owned profile also checks that endpoint and epoch have not changed before returning. It does not infer model readiness, task execution, or state from terminal output. A ready local success additionally returns `taskEndpoint: { relay, id }`.

For a remote launch or exact `session status` selection, the CLI resolves that
endpoint through the coordinator's **local** live registration and host-verified
trusted Tailnet peer route (all visible online peers are assumed honest). `WOLFPACK_SESSION_NAME` must identify the local coordinator;
normal JWT configuration must authorize both control servers. The resulting
`taskEndpoint` is a locally routable opaque alias, with `taskRouting` describing
the source epoch/origin and `remoteTaskTransport` retaining the destination's
registration metadata. Resolution is bounded to 12 seconds after the remote
operation. Remote `list --json` does not allocate routes for the whole fleet: it
prints `remoteTaskEndpoint`/`remoteTaskTransport` and asks you to select an exact
session with `session status`.

If qualification fails, there is **no `taskEndpoint`**: the output retains the
remote `sessionId`, records `taskEndpointError`, and selected launch/status exits
nonzero. The remote session may have been successfully created and is **retained**;
inspect or explicitly kill that exact remote ID rather than blindly retrying
creation. This is not a claim of cleanup, task execution, or delivery.

After creation, a failed root/identity/liveness/endpoint check or deadline kills only the exact created stable ID. Failure responses use `TASK_WORKER_NOT_READY`; they retain `createdSession` plus `cleanup: "completed" | "unconfirmed"`. Resource preflight failure returns `TASK_WORKER_PREFLIGHT_FAILED` without creating a session.

## Spawn a child agent

```bash
wolfpack agent spawn <project> [--harness <agent>] [--name <session>] [--model <provider/model>] [--prompt|--prompt-file|--plan <value>] [--notify-parent] [--json]
wolfpack agent spawn --project-dir <path> [--harness <agent>] [--name <session>] [--model <provider/model>] [--prompt|--prompt-file|--plan <value>] [--notify-parent] [--json]
```

- performs one `POST /api/session-open` request.
- uses the same mutually exclusive name/`--project-dir` selection and server validation as top-level creation.
- requires `WOLFPACK_SESSION_NAME` and `WOLFPACK_AGENT_KIND` from the current parent agent.
- resolves the parent through structured broker identity; the parent must still use a supported agent harness.
- inherits the parent harness by default. `--harness <pi|claude|codex|gemini|cursor>` selects a different child harness without changing parent lineage; `shell` is not accepted for children.
- accepts `--name <session>` for meaningful child names such as `200-security-review`; if omitted, derives `<parent>-sub-agent`, then numbered names.
- for Pi children only, accepts a bounded nonblank `--model <provider/model>` value and passes it unchanged to Pi's native `--model` option. A non-Pi parent can use `--harness pi --model ...`; a non-Pi child rejects `--model` and `--task-worker` before creation.
- passes only explicit startup instructions; it does not inherit the parent transcript, model context, or summary.
- supports `--plan <file>` and `--prompt-file <file>` like top-level creation.
- `--notify-parent` adds a compact child instruction to call `wolfpack agent notify-parent` when done or blocked. That command queues the message in the live parent's inbox and also notifies enrolled human devices (see below).
- stores structured parent ID/name metadata and sends a best-effort typed browser notification when opened.
- json success has the same fields as top-level creation, including stable `sessionId`; `harness` reports the child's harness.

`wolfpack session open` remains a deprecated compatibility alias for `wolfpack agent spawn` and accepts the same selectors, optional `--harness`, and Pi-child model selection. It never means top-level creation.

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
wolfpack session inbox <session-or-id> [--since <seq>] [--json]
wolfpack agent inbox [--since <seq>] [--json]
wolfpack session read <session-or-id> [--json]
```

- `list --json` uses the lightweight `/api/session-control/list` route and returns active structured identities as one JSON envelope, without terminal previews.
- `status` returns canonical name, stable ID, active state, project path, `projectDir` alias, project name, harness, optional parent identity, and bounded `terminal` liveness (`ready | dead | unavailable`). Dead targets return `SESSION_DEAD`; unknown, ambiguous, and backend-unavailable targets use the same structured failure envelope. It does not capture terminal output.
- `read` is the explicit full broker-snapshot operation.

### Passive visible-screen snapshots

`GET /api/session-control/snapshot?sessionId=<full UUID>` is the dashboard's read-only inspection surface. When a terminal opens into an occupied-session conflict, its overlay offers **Inspect** beside **Take Control**; ordinary session cards remain compact. The overlay pins the selected session UUID and machine before inspection, captures the current visible screen at the broker's existing geometry, and returns bounded plain text plus capture time, rows, columns, cache freshness, and an explicit truncation flag. It does not attach a PTY websocket, subscribe to output, send input, resize, reflow, or acquire terminal control. Snapshots are not live; clients refresh at most every two seconds and must present capture age. The server bounds active captures, cache entries, text, and encoded responses; busy or unavailable captures are retryable.
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
wolfpack session send <session-or-id> <text...> [--no-enter] [--ensure-submitted] [--observe-ms <1..10000>] [--json]
wolfpack session wait <session-or-id> <text> [--timeout-ms <1..600000>] [--json]
wolfpack session prompt <session-or-id> <prompt...> --until <text> [--no-enter] [--timeout-ms <1..600000>] [--json]
```

- `send` writes through the broker input plane and appends Enter unless `--no-enter` is set. Like `prompt`, the server pins the resolved `sessionId`, subscribes to output, then writes, and reports what it saw within `--observe-ms` (default 1500, max 10000). One deadline bounds each write, including the status reads before and after it and the subscribe; nothing is written once it has run out, and nothing observed after it counts, including a status read answered or stamped after it:
  - `delivery`: `delivered` (output, or a program status change the broker stamped after the write, followed it), `not_delivered` (nothing was written; `reason` is `target_unavailable`, `target_replaced`, `target_exited`, `replay_gap`, `backend_unavailable`, or `timed_out` when the window ran out before the write could start), or `unverified`.
  - `outcome`: `submitted` (the program's OSC 7501 root status was seen `idle` and then moved to another state stamped after the write; a status the broker stamped at or before the write, even if its paced event arrives later, is not evidence, and a busy program going straight to `done` or `blocked` is not submission; records are ordered by that stamp, so a status read that returns a snapshot older than one already pushed, or taken before a clear that already arrived, is ignored, and two records with the same stamp but different states leave the outcome `unverified`), `pasted_not_submitted` (the text arrived but an `idle` status stayed untouched, so Enter was swallowed), `not_delivered`, or `unverified` (no status record, a busy or changed-but-idle status, no observed `idle` before the change, or no evidence). With `--no-enter` nothing is submitted and `outcome` mirrors `delivery`.
  - `ok` is true for `submitted` or `unverified` (`delivered` or `unverified` with `--no-enter`); `observedMs` is the time watched after the write, never more than `--observe-ms` per write.
  - `--ensure-submitted` re-sends one `\r` when the first write reads as `pasted_not_submitted` and adds `retried: true` only when that `\r` was written; if it could not be written, the first result stands. It never retries twice or on any other outcome.
  - Submission needs a program that reports OSC 7501 status (see [broker-protocol.md](broker-protocol.md#program-status-osc-7501)). An `idle` record left by a program that exited without clearing it (no OSC 133 shell integration) can make a shell command read as `pasted_not_submitted`.
  - Exit codes: `0` for `submitted`, `delivered` and `unverified`; `7` for `pasted_not_submitted`; `3` when not delivered because the target is gone or replaced; `6` when not delivered for any other reason. A backend that could not take the input still answers HTTP `503`, now with the outcome fields beside `error`; `--json` prints those validated fields with the generic `BACKEND_UNAVAILABLE` error. Plain output prints the outcome (yellow) unless it is `submitted` or `delivered`; `--json` prints the full response.
  - Servers from before outcome reporting answer `{ok, session, sessionId}` only; the CLI treats that as success (exit `0`).
- `wait` checks the current snapshot, then subscribes from its sequence number with a bounded buffer and timeout.
- `prompt` performs one `POST /api/session-control/prompt` request. The server resolves the selector once, pins the returned `sessionId`, registers broker output observation, waits for subscription readiness, records `outputBoundarySeq`, and only then writes input to that stable ID.
- `prompt --until` is explicitly an `output contains` terminal primitive. It does not infer agent or task completion. Typed agent-state and delegated-task predicates remain deferred to #209 and #211.
- prompt outcomes are `matched`, `timed_out`, `target_exited`, `target_unavailable`, `target_replaced`, `replay_gap`, or `backend_unavailable`. The bounded JSON envelope always includes canonical `session`, stable `sessionId`, `outcome`, and nullable `outputBoundarySeq`.
- `target_replaced` means the pinned stable ID disappeared while its resolved session name now maps to a different stable ID; callers must re-resolve explicitly before retrying.
- typed agent-state/delegated-task predicates and explicit cancellation are still deferred until #211 provides the structured event/cursor substrate; `prompt --until` remains output-contains only.
- JSON responses from standalone `wait` retain their existing shape for backward compatibility; `send` adds the outcome fields above.

### Notify and poll the parent inbox

`wolfpack agent notify-parent [--message <text>] [--json]` wraps `POST /api/notify`; it is intended for full-startup children launched with `--notify-parent`. The CLI sends the parent ID/name from `WOLFPACK_PARENT_SESSION_ID` / `WOLFPACK_PARENT_SESSION_NAME` and an optional informational `from` from `WOLFPACK_SESSION_NAME`. The server queues the message only for that exact live parent ID **and** name, and still sends web push to the human's devices enrolled on this host (see [phone-pwa-notifications.md](phone-pwa-notifications.md)). Nothing is injected into the parent terminal.

- `POST /api/notify` retains `ok: true` for acceptance, `sent`, `failed`, `pruned`, `delivered` (`sent > 0`), and push-only `reason` when not delivered: `no_subscriptions` or `delivery_failed`. Rate limiting and push subscription handling are unchanged.
- It also returns `parentInbox: {queued:true, seq}` or `{queued:false, reason:"no_parent"|"parent_not_found"}`. `no_parent` means no session target; `parent_not_found` means the exact live ID/name could not be confirmed (including backend unavailability). A same-name replacement is never substituted.
- `from` is optional, at most 100 Unicode code points, and **unverified**: it is not authenticated sender identity or task-completion evidence.
- Exit `0` when the inbox is queued, even without push subscriptions or when push fails; plain output reports `parent inbox queued (seq N)` and warns about missing/failed push delivery. Otherwise the existing push exits apply: `0` when delivered (or legacy `ok:true` without `delivered`), `8` for `no_subscriptions`, `6` for `delivery_failed`. Plain output also reports why the inbox was not queued.
- Malformed or contradictory delivery/inbox fields remain protocol errors (exit `1`, `invalid /api/notify response: …`). `--json` prints the full response, including the inbox result, without plain warnings.

Poll without terminal scraping:

```bash
wolfpack agent inbox --json
wolfpack agent inbox --since 12 --json
wolfpack session inbox <parent-session-id> --since 12 --json
# optional live follow (no replay)
wolfpack events --session <parent-session-id> --kinds parent_notified --json
```

Both inbox commands call `GET /api/session-control/inbox?session=<name-or-id>[&since=<seq>]`, using the same selector and not-found/dead/ambiguous/unavailable envelopes as `session status`. `agent inbox` resolves the current agent session from its Wolfpack environment, preferring the injected stable ID; it uses the same missing/unsupported-context error path as spawn. Both support the verified `--machine` selector like status; this reads that host's inbox, not a cross-machine relay.

The response is `{session, sessionId, notifications:[{seq, at, message, from?}]}`. `seq` starts at 1 per parent, `at` is an ISO timestamp, and `since` is a non-negative safe integer returning only entries with `seq > since`. Reads do not consume entries; retain the last sequence to avoid duplicates. Plain output is `seq at [from] message` per entry (sender omitted when absent); line breaks are replaced with spaces in human inbox/event lines, while JSON preserves the original text.

Malformed inbox success replies exit `1`; JSON output is an `ok:false` error envelope with code `INVALID_INBOX_RESPONSE`, while plain output diagnoses the invalid inbox response on stderr. Both aliases validate identity, entries and limits before reporting success, including the exact stable self ID when known.

The inbox is **memory-only**, retains only the newest **100** entries per parent, and is dropped on parent session exit. A server restart loses every inbox and resets sequences; slow/disconnected pollers may miss overwritten entries. It is not a durable task ledger or an acknowledgement protocol. Verify the child's actual work before cleanup. Pi coordinators keep using Pi Tasks `agent_task_done` / `agent_task_ack` for `--task-worker` endpoint children, which reject `--notify-parent`.

### Current session identity

`wolfpack session current-context [--json|--shell]` returns the current session's stable broker UUID after one read-only, exact-ID lookup against the local backend (5-second request deadline):

```json
{"ok":true,"verified":true,"sessionId":"11111111-1111-4111-8111-111111111111","session":"wolfpack","projectDir":"/work/wolfpack","harness":"pi"}
```

The broker assigns `WOLFPACK_SESSION_ID` **before** starting each PTY child, overriding inherited/caller-supplied values. Each new child session therefore receives its own UUID, not its parent's. The CLI validates that UUID, name, project and harness against a live/ready session; `--shell` prints safely quoted identity assignments only after verification. Plain output is UUID, name and project directory, one per line.

This requires a **new session launched by the updated broker** and a reachable local server. Missing, stale, mismatched or unavailable identity fails with nonzero status; JSON failures have `ok: false`. There is no old-session migration, name/list/process-ancestry fallback or `--machine` self-discovery. A same-name replacement is never substituted. Verification checks live identity consistency; environment variables are not an authentication boundary against their owner.

The Agent Context skill can use verified self-identity when asked to update “this session,” without asking the user to copy or confirm a UUID. Explicitly targeting another session still requires its exact UUID. Activating a broker upgrade terminates its existing terminals; schedule that upgrade and then launch fresh sessions.

## Follow live events

```bash
wolfpack events [--kinds <kind,...>] [--session <name-or-id>] [--json]
```

Streams `GET /api/events` (server-sent events, ordinary API auth). Kinds:

- `session.created` — `sessionId`, `session`, `cwd`
- `session.exited` — `sessionId`, `session` (when known), `reason` (`exit` or `killed`), `exitCode?`, `signal?`
- `session.state` — `session`, `sessionId?`, `state`, `label`, `transitionSequence`, plus `inputKind?` and `message?` when the state comes from the program's own OSC 7501 status report; published when an agent's runtime state transitions, including a blocked program switching to a different request (new `inputKind` or `message`) while staying `needs-input`. Observed every ~5s, so expect up to that much latency.
- `parent_notified` — parent `session`, `sessionId`, inbox `seq`, `message`, optional unverified `from`; emitted when a parent inbox entry is queued. `--session` matches the parent name or ID, not the sender.
- `task.updated` — `taskId`, `eventId`, `eventType` (canonical task event, e.g. `task.completed`), `sequence`; emitted by the machine holding the task's sender ledger.

Every event also carries a per-server-process monotonic `id` and an ISO `at`. `--session` matches a name or stable id and excludes task events. `--json` prints one event object per line; otherwise one human line per event.

The stream is live-only: there is no replay, so events published while disconnected are lost. The command exits `1` when the server is unreachable or closes the stream (scripts own reconnection), `2` for an invalid filter (checked before connecting; the server also rejects it with `400`), and `5` on auth failure. At most 32 concurrent streams per server (`429`).

## Exit codes

- `0`: success
- `1`: unexpected API failure or ambiguous selector
- `2`: usage error
- `3`: missing/unknown project, session, or context
- `4`: wait timeout
- `5`: auth failure
- `6`: backend unavailable
- `7`: `send` delivered the text but it was not submitted (`pasted_not_submitted`)
- `8`: `agent notify-parent` did not queue a parent inbox entry and this host has no push subscription to deliver to (`no_subscriptions`)

Grid/layout ownership remains in the browser. Session commands never reconstruct browser state from terminal output.
