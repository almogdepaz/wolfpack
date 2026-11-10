# Session Control CLI/API

Wolfpack exposes a scriptable session surface for agents and operators. The server remains authoritative for auth, project selection and path validation, session naming, stable broker identity, and PTY operations. Commands use Wolfpack's ordinary global API auth policy and add no inter-session authorization layer.

## Target a configured Tailnet machine

```bash
wolfpack --machine <short-name-or-fqdn> <control-command> ...
```

The global selector supports `list`/`ls`, `session create`, deprecated `session open`, `agent spawn`, `agent inbox`, `session status`, `session organization`, `session inbox`, `session read`, `session send`, `session wait`, `session prompt`, `kill`, and `events`. Other commands reject it.

A short name is expanded using the exact Tailnet suffix from configured `tailscaleHostname`. A full name must be a canonical HTTPS Tailnet hostname in that suffix; URLs, ports, paths, foreign suffixes, malformed or duplicate selectors, and missing configuration fail closed without a localhost fallback. Before any control request, the CLI sends an exact, bounded `GET /api/machine` probe with redirects disabled, a bounded timeout, and the normal Wolfpack JWT `Authorization` header when configured. The structured handshake must report the selected canonical origin and session-control capability.

Subsequent requests go directly to that verified HTTPS origin. Remote JSON successes retain server fields (except the task endpoint projection described below) and add the verified identity as `"machine": { "tailnetNodeId": string, "installationId": string, "displayName": string, "origin": string }`; server-owned `sessionId` values are unchanged. Without `--machine`, request routing and JSON output remain local and unchanged.

`agent spawn` still uses `POST /api/session-open` and resolves its parent on the selected machine. It does not create cross-machine lineage: a parent absent from the selected machine fails through the existing structured response.

## Session organization

```bash
wolfpack session organization <session-or-id> --json
wolfpack session organization <session-or-id> --group ops --add-tag urgent
wolfpack session organization <session-or-id> --clear-group --remove-tag waiting --revision 3
```

Organization is host-owned classification: multiple stored tags and one optional flat group label. It does not change parents, runtime state, names or machine ownership, and adds no filters. The CLI resolves a live selector once, then pins all organization requests to its UUID. Normal `--machine` routing applies.

The dashboard, sidebar and mobile drawer show collapsible named groups within each machine, followed by ordinary headerless rows for sessions with no group. Free rows have no separate collapse; existing machine collapse governs them, and obsolete null-group collapse preferences cannot hide them. Named groups display as **Group “label”**, distinct from built-in states and actions without changing stored labels. Labels sort deterministically; urgency and manual sibling order remain intact within each group. The highest present ancestor's group governs its whole tree, resolved from the full machine inventory even during search/status filtering. An orphaned tree uses its highest surviving ancestor's group. Needs-you attention remains visible independently of group collapse.

Use a session's ellipsis **Move to group** action to select an existing group, **New group…**, or **Remove from group** in the picker. Removal clears membership even when no free rows are currently shown. A child-invoked move identifies the whole tree it will move. Desktop mouse dragging onto another group is an optional shortcut using the same guarded operation; touch and keyboard always have the menu path. Moving a tree writes only its authoritative root with one UUID/revision compare-and-swap; child annotations are not rewritten. Collapse preferences are local, not replicated. If an external update moves the focused session into a collapsed group, focus returns to that group's toggle in the same chooser; a local move expands its destination and returns to the session action. Groups exist only while sessions carry their labels; there is no empty-group registry or cross-machine move.

The UI neither displays nor edits tags. Existing stored tags and API/CLI tag support are unchanged; UI group writes omit tags, including after explicit conflict review. Unknown or unsupported metadata retains a static diagnostic, is distinct from known-free membership, and cannot be edited.

`GET /api/session-control/organization?sessionId=<uuid>` returns `{ sessionId, organization: { group, tags, revision } }`. `POST` to the same path accepts `{ sessionId, expectedRevision, group?, tags? }` with at least one changed field. `group: null` clears the group; `tags: []` clears all tags. UI/CLI use this shared service; a stale revision returns `409 ORGANIZATION_CONFLICT`. Convenience CLI edits read the revision first; `--revision` supplies an explicit automation precondition. There is no automatic retry of an uncertain save.

Labels are NFC-normalized and trimmed, preserve display case, reject control/format/surrogate characters, and allow 1–64 Unicode code points / 256 UTF-8 bytes each. At most 16 supplied tags are accepted and deduplicated using locale-independent lowercase, retaining first spelling/order. Bodies are bounded to 8192 bytes. Unknown fields are rejected. Canonical no-ops retain the revision; clears retain a revision tombstone.

Records persist privately under `$WOLFPACK_DIR/session-organization/<uuid>.json` (default Wolfpack directory). One server process owns writes; this is not a cross-process transaction. No inventory reconciliation or automatic garbage collection deletes annotations, and a new UUID reusing a name never inherits them.

Dashboard/control projections include the same additive `organization` value. Corrupt/unreadable storage instead yields `{ status: "unavailable" }` without changing terminal liveness. Missing projection on older hosts means unsupported, not empty labels. Direct storage failure is `503 ORGANIZATION_UNAVAILABLE`; backend unavailability remains distinct. CLI failures distinguish unsupported hosts, invalid labels, conflicts and uncertain writes. Read and review before retrying a failed save.

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

## Opt into task-worker readiness

Add `--task-worker` to `session create` or `agent spawn` only with `--project-dir <absolute-existing-worktree>`. It requires the child (or top-level session) to use the Pi or Claude harness; a child may select one with `--harness pi` or `--harness claude` regardless of the parent's supported harness. Claude task workers are described in [Claude task workers](#claude-task-workers); the rest of this section describes Pi task workers. It accepts optional `--model` only for child Pi sessions, and rejects named-only project selection, `--prompt`, `--prompt-file`, `--plan`, and `--notify-parent`. `--readiness-timeout-ms <1..60000>` bounds the server gate (default 30000 ms); the CLI request deadline includes a small response grace period.

Before creating anything, Wolfpack resolves and validates only the resources it will launch: `WOLFPACK_TASK_WORKER_PI_EXECUTABLE` (otherwise `pi` from `PATH`) and `WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION` (otherwise `$PI_CODING_AGENT_DIR/npm/node_modules/@sgtbeatdown/wolfpack-tasks/src/extension.ts`, falling back to the pre-rename `@sgtbeatdown/pi-tasks` install path while it is the only one present, or `~/.pi/agent/...` when the Pi config directory is unset). Both configured paths must be absolute; the executable must be a regular executable file (working package-manager symlinks are accepted), and the extension must be a readable regular file.

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

The child launches Pi with the explicit extension, `PI_TASK_WORKER=1` and `WOLFPACK_TASK_WORKER=1`; no startup assignment prompt runs. Success waits only for the exact live broker `sessionId`, exact canonical project root, Pi harness, and a lease-valid endpoint in the selected relay profile. The normal memory-owned profile also checks that endpoint and epoch have not changed before returning. It does not infer model readiness, task execution, or state from terminal output. A ready local success additionally returns `taskEndpoint: { relay, id }`.

### Claude task workers

Claude task workers need the Claude task integration, which `wolfpack setup` installs and records as `claudeTaskIntegration: true` in `~/.wolfpack/config.json`. The integration is on only while that flag is set and the managed-settings drop-in `wolfpack.json` sets `channelsEnabled: true` and allows the `wolfpack-tasks` channel plugin; Wolfpack reads both files for each launch and request. While it is off, a Claude task-worker launch fails before session creation with `INVALID_REQUEST` (HTTP 400). The error names `claudeTaskIntegration` and `wolfpack setup` when the flag is off, and names the drop-in problem, `wolfpack setup` and `wolfpack doctor` when the drop-in is missing or wrong. Wolfpack resolves `claude` from `PATH` and launches `claude --channels plugin:wolfpack-tasks@wolfpack-tasks` with `PI_TASK_WORKER=1`, `WOLFPACK_TASK_WORKER=1` and `WOLFPACK_PORT`; no startup prompt runs. The task tools come from the `wolfpack-tasks` Claude plugin, so `--model`, the Pi host policy, `--task-worker-policy-file` and `--task-worker-dry-run` do not apply. The CLI rejects them, and the server rejects `model`, `taskWorkerPolicy` and `taskWorkerDryRun` with `INVALID_REQUEST` and the error `model, taskWorkerPolicy and taskWorkerDryRun apply only to Pi task workers`. Readiness checks the same exact session id, project root, Claude harness and lease-valid relay endpoint.

While the integration is on (flag and drop-in), every ordinary session that launches the stock `claude` command also gets `--channels plugin:wolfpack-tasks@wolfpack-tasks` and `WOLFPACK_PORT`, so it can receive task mail. `--channels` takes several values, so Wolfpack puts `--` before a startup prompt (`claude --channels <spec> -- <prompt>`). Wrapper commands that only contain `claude` launch unchanged.

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
- `status` returns canonical name, stable ID, active state, project path, `projectDir` alias, project name, harness, optional parent identity, and bounded `terminal` liveness (`ready | dead | unavailable`). It also adds optional read-only `runtimeState`: the last agent runtime state (`AgentRuntimeState`: `state`, `authority`, `source`, `freshness`, `observedAt`, `changedAt`, and more) that the session observer recorded, about every 5 seconds. `runtimeState` is absent until the first observation of the session. Wolfpack itself treats `working`, `running` and `output` as busy, the same set that holds back quiet alerts for a parent. With `authority: "program"` the state comes from the program's own OSC 7501 report. With `authority: "fallback"` it comes only from rendered terminal changes (`output` or `idle`), which is weak evidence. Claude sessions populate the field like any session; without an OSC 7501 emitter they get only the `fallback` states. Dead targets return `SESSION_DEAD`; unknown, ambiguous, and backend-unavailable targets use the same structured failure envelope. It does not capture terminal output.
- `read` is the explicit full broker-snapshot operation.

### Relay degradation and recovery

Session identity and terminal liveness come from the broker, not the task relay. If optional registration lookup times out, is closed, or cannot be admitted, `/api/session-control/list` and `/api/session-control/status` still return HTTP 200 for live sessions. Each affected session adds `taskRelay: { status: "unavailable", recovery: string }` and omits `taskEndpoint`/`taskTransport`. Inspect these fields in `--json` output: this is a degraded metadata read, **not** task readiness or a retry-safe task result. Successful lookup with no registration simply omits those fields and `taskRelay`; healthy payloads are unchanged. Dead, missing, ambiguous, and genuinely unavailable broker responses retain their existing failure codes. Dead-status and inbox reads do not query the relay.

Registration lookup retains the worker's bounded admission/deadline. A request timeout deliberately stops that worker for the server lifetime; repeated session reads do not replace it, recreate endpoints, or replay tasks. Transient admission pressure can clear without a restart. For a persistently unavailable relay:

1. On a **managed-service host**, explicitly run `wolfpack service restart --server-only`. This restarts only the Wolfpack server and leaves sessions broker-owned; do not use `--broker` for relay recovery.
2. For a **foreground host**, first verify whether the invocation owns the broker; see the [installation lifetime contract](installation.md#curl-installer-persistent-cli). Restart through the existing launch mechanism preserves sessions **only when the broker is verified to be independently owned**. Stopping/restarting a foreground invocation that owns its broker terminates that broker and its sessions; stopping only its server child triggers the same cleanup and is not a preservation workaround. For an invocation-owned broker or unknown ownership, do not restart unless you explicitly accept session loss. The managed-service command is not foreground-process recovery.
3. Explicitly rebind endpoint clients: re-read `/api/task-relay/profile`, `connect` to the new epoch, and re-resolve peer aliases. Verify fresh registration separately from exact-ID terminal liveness.

Restart loses volatile registrations, mailboxes, receipts, and in-flight relay state. An interrupted mutation may already have committed or been delivered; `RELAY_RESET` is not a safe retry signal. Do not automatically replay assignments, mutations, or Pi session history. Reconcile uncertain task outcomes explicitly; server restart does not recover task state.

### Passive visible-screen snapshots

`GET /api/session-control/snapshot?sessionId=<full UUID>` is the dashboard's read-only inspection surface. When a terminal opens into an occupied-session conflict, its overlay offers **Inspect** beside **Take Control**; ordinary session cards remain compact. The overlay pins the selected session UUID and machine before inspection, captures the current visible screen at the broker's existing geometry, and returns bounded plain text plus capture time, rows, columns, cache freshness, and an explicit truncation flag. It does not attach a PTY websocket, subscribe to output, send input, resize, reflow, or acquire terminal control. Snapshots are not live; clients refresh at most every two seconds and must present capture age. The server bounds active captures, cache entries, text, and encoded responses; busy or unavailable captures are retryable.
- names remain accepted for humans; automation should retain and use `sessionId` returned by create, spawn, list, or status.
- selectors that ambiguously match a name and another session's ID fail closed.
- Pi/agent task layers may use `session status <selector> --json` only as Wolfpack-owned target evidence: selector resolution, broker/session existence, stable identity, project path, harness, and terminal liveness. They must not infer Pi model readiness or task completion from Wolfpack status. `runtimeState` is an advisory busy/idle observation, for example to choose a wake mode; it is not readiness or completion evidence.

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

- `send` writes through the broker input plane and appends Enter unless `--no-enter` is set. In a Claude session, Enter after non-empty text is its own write, ~100 ms after the text, because Claude Code reads text and Enter that arrive together as a paste and keeps the Enter as a newline; `--observe-ms` counts from that Enter. Writes to one Claude session wait for each other, so another `send` or `prompt` cannot land between a text and its Enter; that wait counts against the caller's deadline, and other sessions do not wait. Other harnesses get the text and Enter in one write. `prompt` writes the same way. Like `prompt`, the server pins the resolved `sessionId`, subscribes to output, then writes, and reports what it saw within `--observe-ms` (default 1500, max 10000). One deadline bounds each write, including the status reads before and after it and the subscribe; nothing is written once it has run out, and nothing observed after it counts, including a status read answered or stamped after it:
  - `delivery`: `delivered` (output, or a program status change the broker stamped after the write, followed it), `not_delivered` (nothing was written; `reason` is `target_unavailable`, `target_replaced`, `target_exited`, `replay_gap`, `backend_unavailable` (for example, the output subscription never became ready), or `timed_out` when the window ran out before the write could start, including while it waited for earlier writes to the same Claude session), or `unverified`.
  - `outcome`: `submitted` (the program's OSC 7501 root status was seen waiting and then left it with a record stamped after the write: `idle` to any other state, or `done` to `working`, `blocked` or `error`. Claude Code and Pi report `done` between turns, so `done` counts as waiting; `done` to `idle` or to a re-stamped `done` is not a new turn. A status the broker stamped at or before the write, even if its paced event arrives later, is not evidence, and a busy program going straight to `done` or `blocked` is not submission; records are ordered by that stamp, so a status read that returns a snapshot older than one already pushed, or taken before a clear that already arrived, is ignored, and two records with the same stamp but different states leave the outcome `unverified`), `pasted_not_submitted` (the text arrived but an `idle` or `done` status stayed untouched, so Enter was swallowed), `not_delivered`, or `unverified` (no status record, a busy status, a status that changed but stayed waiting, no observed waiting status before the change, or no evidence). With `--no-enter` nothing is submitted and `outcome` mirrors `delivery`.
  - `ok` is true for `submitted` or `unverified` (`delivered` or `unverified` with `--no-enter`); `observedMs` is the time watched after the write, never more than `--observe-ms` per write.
  - `--ensure-submitted` re-sends one `\r` when the first write reads as `pasted_not_submitted` and adds `retried: true` only when that `\r` was written; if it could not be written, the first result stands. It never retries twice or on any other outcome.
  - Submission needs a program that reports OSC 7501 status (see [broker-protocol.md](broker-protocol.md#program-status-osc-7501)). An `idle` record left by a program that exited without clearing it (no OSC 133 shell integration) can make a shell command read as `pasted_not_submitted`. A `done` record survives both exit and OSC 133 prompts, so the shell that an agent session leaves after Claude Code or Pi exits reads the same way, and `--ensure-submitted` then writes one extra `\r` to that shell.
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

`wolfpack agent notify-parent [--message <text>] [--json]` wraps `POST /api/notify`; it is intended for full-startup children launched with `--notify-parent`. The CLI sends the parent ID/name from `WOLFPACK_PARENT_SESSION_ID` / `WOLFPACK_PARENT_SESSION_NAME` and an optional informational `from` from `WOLFPACK_SESSION_NAME`. The server queues the message only for that exact live parent ID **and** name, and still sends web push to the human's devices enrolled on this host (see [phone-pwa-notifications.md](phone-pwa-notifications.md)). The message itself is never typed into the parent terminal; a matching child's message becomes a [child event](#child-events), and only its enumerated fields can reach the parent as a [typed note](#delivery-to-the-parent-agent).

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
wolfpack events --session <parent-session-id> --kinds parent_notified,child_event --json
```

Both inbox commands call `GET /api/session-control/inbox?session=<name-or-id>[&since=<seq>]`, using the same selector and not-found/dead/ambiguous/unavailable envelopes as `session status`. `agent inbox` resolves the current agent session from its Wolfpack environment, preferring the injected stable ID; it uses the same missing/unsupported-context error path as spawn. Both support the verified `--machine` selector like status; this reads that host's inbox, not a cross-machine relay.

Inbox reads are available to any caller with this host's ordinary API access, the same as `session status`. They are not parent-private and must not be treated as private child/parent messaging.

The response is `{session, sessionId, bootId, notifications:[{seq, at, message, from?, childEvent?}]}`. `bootId` identifies the server process that assigned the sequences; when it changes, sequences restarted, so read again without `since`. `seq` starts at 1 per parent, `at` is an ISO timestamp, and `since` is a non-negative safe integer returning only entries with `seq > since`. Reads do not consume entries; retain the last sequence to avoid duplicates. Plain output is `seq at [from] message` per entry (sender omitted when absent); line breaks are replaced with spaces in human inbox/event lines, while JSON preserves the original text.

Malformed inbox success replies exit `1`; JSON output is an `ok:false` error envelope with code `INVALID_INBOX_RESPONSE`, while plain output diagnoses the invalid inbox response on stderr. Both aliases validate identity, entries and limits before reporting success, including the exact stable self ID when known.

The inbox is **memory-only**, retains only the newest **100** entries per parent, and is dropped on parent session exit. A server restart loses every inbox and resets sequences; slow/disconnected pollers may miss overwritten entries. It is not a durable task ledger or an acknowledgement protocol. Verify the child's actual work before cleanup. Pi coordinators keep using Pi Tasks `agent_task_done` / `agent_task_ack` for `--task-worker` endpoint children, which reject `--notify-parent`.

#### Child events

The server also tells a parent what its children did, with no child action. It derives events from the observed runtime state of every live session whose identity names a parent (`agent spawn` children), on this machine only. Each event is a parent inbox entry with a structured `childEvent` (kind `wolfpack.child_event/v1`) and a `child_event` live event:

- `blocked`: the child's own status (OSC 7501 program status or the project status manifest) says it waits for input; carries `inputKind?` and the program's `message?`.
- `error`: the child's own status says it failed.
- `done`: the program reported `done`, or, for a child without program status, it went from busy to `idle` after a `session send` wrote a task with Enter to it. The send arms this when the write succeeds, not when its observation returns, so a child that finishes while the send is still observed is reported. A `--no-enter` send or a failed write does not arm it.
- `exited`: the child session exited or was killed; carries `reason`, `exitCode?`/`signal?` and up to 5 `lastLines` of its last observed screen. The broker exit frame or a successful session table read reports it, whichever comes first, and the child gets one `exited` either way. The server remembers the last 1024 exited child session IDs, so an observation that read the child as live before its exit does not track it again. A table read reports a tracked child that is listed dead or is gone from the list, so an exit missed while the broker was disconnected is still reported. An exit found this way carries no `exitCode` or `signal`. While a kill reply is outstanding the table waits for it, and a successful kill reports `reason: "killed"`. An unavailable table reports nothing.
- `message`: `agent notify-parent` from a sender whose unverified `from` name matches a live child of this parent. The entry keeps the message text; other senders stay plain notifications.

`childEvent` fields: `kind`, `eventId` (child session ID, `bootId` and `seq`), `bootId`, `seq` (the entry's inbox sequence), `childSessionId`, `childName`, `parentSessionId`, `event`, `state` (the child's runtime state), optional `inputKind`, `message` (at most 500 code points), `lastLines`, `authority`, `reason`, `exitCode`, `signal`, and `observedAt`. New optional fields may be added; ignore unknown fields. The entry `message` is a one-line summary (for example `blocked (permission): run rm?`) and `from` is the child name.

A child produces at most one event per entry into a state: repeated reports in the same state do not repeat the event. A child spawned by this server process is tracked from creation, so its first `blocked`, `error` or `done` is reported even when it is the first state observed. A child first seen after a server restart (restart recovery) uses that first observation as a baseline and produces no event, so events that happened while the server was down are lost. Screen heuristics alone never produce `blocked` or `error`. A `blocked` child event (program or manifest status) also starts a "Needs input" web push episode at the moment the child became blocked, so the push needs no screen change (see [phone-pwa-notifications.md](phone-pwa-notifications.md)). When the screen capture failed at that moment, the episode starts at the first observation with a fresh capture while the child is still blocked; a block that already sent its push does not start another episode after a capture gap. It goes through the same quiet-alert policy: it is sent after the quiet interval (30 s by default) if the child is still blocked, never in `disabled` mode, with the usual per-session debounce and retry limit. Recipients are frozen when the alert first becomes due and is emitted, as for every quiet alert: a device enrolled after the child blocked but before then gets the push, and a device enrolled later does not. An episode that a screen change already started is adopted, so one block sends one push. A screen change while the child stays blocked does not start a new push: the block keeps its episode until a fresh status shows the child left needs-input, and a later block pushes again. Child events add no other push.

#### Delivery to the parent agent

The server also delivers each child event to the parent agent. The first available path wins:

1. **Relay envelope.** If the parent session holds a live task-relay registration whose connect `protocolVersions` include `1001` (the child-event capability marker), the server accepts one envelope into that endpoint's inbox. The envelope keeps the relay wire version, comes from a server-owned source endpoint, has `envelopeId` `wolfpack.child_event:<eventId>`, and its `payload` is the `childEvent` object itself (`kind: "wolfpack.child_event/v1"`). Endpoints and peers cannot send a payload of that kind (`SOURCE_MISMATCH`), so one in a local inbox came from this server. Endpoints without the marker receive nothing, because a current adapter rejects a whole inbox page that holds an unknown payload. The server falls back to a typed note only when the relay definitely did not accept the envelope. When acceptance is uncertain (for example the relay worker reset after the request reached it), the event stays in the parent inbox and no note is typed, so the parent never gets the event twice.
2. **Typed note.** Otherwise the server types one tagged line into the parent terminal, for example `[wolfpack] child events: worker-1 done; worker-2 blocked (permission) (details: wolfpack agent inbox --json)`. It types only when all of these hold:
   - the parent's own OSC 7501 program status is fresh and `idle` or `done` (never `blocked`, `working` or `failed`, and never for manifest or screen-heuristic status);
   - no viewer typed into the parent terminal in the last 60 s;
   - at least 15 s passed since the previous note to that parent;
   - `childEventTypedNotes` is not `false` in `~/.wolfpack/config.json` (read on each use; no restart needed).

   Events that wait coalesce into one note: at most 8 are listed and the rest are counted as `+k more`. Events that arrive while a note is being sent wait for the next note. At most 50 events wait per parent; when more arrive, the oldest waiting events are dropped and counted in the next note. A note carries only the child name (reduced to `[A-Za-z0-9._-]`, at most 40 characters), the event, the input kind and exit details. It never carries `message` or `lastLines`, so a child cannot type instructions into its parent. The note uses the observed send path with `ensureSubmitted`. The status, viewer-input and setting guards are checked again right before each write, after the wait for earlier writes to that terminal: before the text, before its separate Enter, and before the `ensureSubmitted` retry Enter. Each check reads the parent's root program status fresh and refuses a parent that the exact-ID read reports as exited. The check uses the newest status from that read and from the status pushes that arrived during the read, ordered by broker stamp; it refuses when two different states carry the same newest stamp. A failed check writes nothing more, so an Enter alone never goes to a parent that stopped waiting. When the check fails before the text, the note stays queued and the attempt is not counted. When the check fails after the text and before its Enter (`partial_write_refused`, logged once as a warning with the parent and event IDs), the note text may remain unsent in the parent's input; the note is not typed again, and the events stay available through `wolfpack agent inbox`. When nothing was written for another reason, the events wait for up to 3 attempts. When the outcome is not `submitted`, the note is not typed again. Queued events are dropped after 30 minutes, when the parent exits, or when the setting turns notes off. The server checks the guards on each observation (about every 5 s), so a note can lag the event by that interval.
3. **Inbox only.** Without either path the event stays in the parent inbox and on the event stream.

Only interactive terminal input counts as viewer input; `session send` and typed notes do not. A viewer's own unsent text that is older than 60 s can be submitted together with a note.

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
- `child_event` — parent `session`, `sessionId`, and the structured `childEvent` described in [Child events](#child-events); emitted with the inbox entry. `--session` matches the parent or the child name or ID.
- `task.updated` — `taskId`, `eventId`, `eventType` (canonical task event, e.g. `task.completed`), `sequence`; emitted by the machine holding the task's sender ledger.

Every event also carries a per-server-process monotonic `id` and an ISO `at`. `--session` matches a name or stable id and excludes task events. `--json` prints one event object per line; otherwise one human line per event.

The stream is live-only: there is no replay, so events published while disconnected are lost. The command exits `1` when the server is unreachable or closes the stream (scripts own reconnection), `2` for an invalid filter (checked before connecting; the server also rejects it with `400`), and `5` on auth failure. At most 32 concurrent streams per server (`429`).

## Exit codes

- `0`: success
- `1`: unexpected API failure or ambiguous selector. When the server could not be reached (a connect error such as `ECONNREFUSED`, `EPERM` or Bun's `FailedToOpenSocket`, or a sandbox network proxy's non-JSON HTTP `403`, reported as `proxy denial (HTTP 403)`), `session`/`agent` commands and `events` name the request URL and the cause and print a hint that a sandboxed agent cannot reach the local server (a reachability hint for `--machine` targets); `--json` adds `url`, `cause` and `hint` to `error` and keeps the command's usual `code` and exit code. A request deadline or an error without a connect code keeps the generic message.
- `2`: usage error
- `3`: missing/unknown project, session, or context
- `4`: wait timeout
- `5`: auth failure
- `6`: backend unavailable
- `7`: `send` delivered the text but it was not submitted (`pasted_not_submitted`)
- `8`: `agent notify-parent` did not queue a parent inbox entry and this host has no push subscription to deliver to (`no_subscriptions`)

Grid/layout ownership remains in the browser. Session commands never reconstruct browser state from terminal output.
