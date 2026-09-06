---
name: wolfpack-tailnet-control
description: Create top-level Wolfpack sessions, spawn child agents, and inspect or control local/Tailscale sessions through the canonical CLI.
---

# Wolfpack Session Control

Use the canonical CLI. Do not discover or reconstruct browser/private HTTP flows.
Wolfpack uses its ordinary global API auth policy and adds no inter-session authorization layer.

## Fast path

A **top-level** project session:

```bash
wolfpack session create <project> --harness <pi|claude|codex|gemini|cursor> --prompt '<instruction>' --json
```

A same-harness **child** of the current agent (full-startup assignment):

```bash
# Pi parent: resolve the role model explicitly; use the reviewer setting for review.
IMPLEMENTER_MODEL="${WOLFPACK_IMPLEMENTER_MODEL:-openai-codex/gpt-5.6-terra}"
REVIEWER_MODEL="${WOLFPACK_REVIEWER_MODEL:-openai-codex/gpt-5.6-sol}"
wolfpack agent spawn <project> --name 200-implementation --model "$IMPLEMENTER_MODEL" --plan .plans/000-task.md --notify-parent --json
# Non-Pi parent: --model is unsupported; omit it.
```

`wolfpack session open` is only a deprecated child-spawn alias. Never use it for a top-level request.
Replace `<project>` with `--project-dir <path>` when the user selects an existing directory outside the configured projects root; never pass both selectors. The CLI resolves relative paths and the server validates/canonicalizes the directory.
Both creation commands perform one server-owned request and pass startup instructions without inheriting parent transcript/context. `--model` is child-only and Pi-parent-only; an explicit user/project model overrides the role environment/default.

Use `--name <session>` for child agents and choose a short meaningful issue/role slug, for example `200-implementation`, `200-delivery-review`, or `auth-boundary-audit`. Avoid generic `*-sub-agent` names when the task purpose is known; Wolfpack will allocate a numbered suffix if the requested name is already taken. Prefer `--plan <file>` for plan work: Wolfpack generates the compact handoff prompt and verifies the file exists without copying plan contents into the parent transcript. Use `--prompt-file <file>` for long bespoke instructions. Use raw `--prompt` only for one short prompt sentence. Do NOT paste repository policy, architecture context, or full plans into the launch command.

Choose exactly one initial-assignment mode:

- full-startup mode: pass the complete assignment through `--plan`, `--prompt-file`, or one concise `--prompt`; do not also send an endpoint task for that work.
- endpoint mode: use explicit-root Pi task-worker readiness without startup assignment flags, then send the complete assignment once with `agent_task_send`. Use a timeout of at least one hour for coding work.

```bash
wolfpack agent spawn --project-dir /absolute/worktree --name task-implementation --model "$IMPLEMENTER_MODEL" --task-worker --readiness-timeout-ms 30000 --json
```

`--task-worker` requires Pi and explicit `--project-dir`; it rejects prompts/plans and `--notify-parent`. Success returns opaque `taskEndpoint` only after exact live session identity, canonical root, and relay v2 registration are verified. This is not model/task execution evidence. `TASK_WORKER_PREFLIGHT_FAILED` is before creation; `TASK_WORKER_NOT_READY` retains `createdSession` and cleanup disposition. `cleanup: "unconfirmed"` is not deletion evidence: inspect the returned stable ID before retrying, never resolve a reusable name. Do not silently downgrade to ordinary spawn when readiness is unsupported.

Prefer one cohesive implementation handoff per approved PR or phase, not one per issue, commit, or checkpoint.

## Structured inspection and control

To explicitly target a configured Tailnet peer, prefix supported commands:

```bash
wolfpack --machine <short-name-or-fqdn> list --json
```

Short names use the exact configured `tailscaleHostname` suffix; full names must be canonical hostnames in it. The CLI verifies bounded structured `/api/machine` identity with normal auth and fails closed without localhost fallback. Remote success includes verified `machine` identity and server-owned `sessionId`. Remote spawn resolves its parent on the selected machine, not cross-machine lineage; unsupported commands reject `--machine`. Use the same verified machine selector for owned remote teardown and absence verification.

```bash
wolfpack list --json
wolfpack session status <session-or-id> --json
wolfpack session read <session-or-id> --json
wolfpack session send <session-or-id> '<text>' --json
wolfpack session wait <session-or-id> '<text>' --json
```

`wolfpack session send` is only for explicit interactive steering. Never send `/exit` or `/quit` to clean up a session: those are Pi input, not Wolfpack teardown. Do not guess lifecycle commands.

Treat session selectors as opaque handles. Prefer the stable `sessionId` returned by create/spawn/list/status. If the user already supplied an exact target, do not list first.

Read-only inspection is allowed when requested. Creation, sending input, killing, taking control, remote-host access, and notifications require explicit user intent for that action and target. Interactive attach/takeover is a UI workflow; do not reconstruct it through the CLI or a private API. Inspect current attach source/tests only when explicitly asked for low-level automation.

Spawning a child grants the spawning coordinator cleanup authority for that exact child. Endpoint assignments use `agent_task_done` followed by one parent `agent_task_ack`; only after that task lifecycle may the parent retain or kill the exact stable session ID. Full-startup children have no task ID: use their explicit completion/block notification and parent verification, then deliberately retain or run `wolfpack kill <stable-session-id> --json`. In either mode, verify that exact ID is absent from `wolfpack list --json` after a kill. Never scrape terminal/UI prose as protocol, bypass auth, guess tokens, or kill a mistaken session as cleanup without permission.

## References — load only when needed

- [canonical session, setup, troubleshooting, and broker references](references.md)
