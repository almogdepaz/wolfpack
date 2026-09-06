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

A same-harness **child** of the current agent:

```bash
wolfpack agent spawn <project> --name 200-implementation --plan .plans/000-task.md --notify-parent --json
# Pi parent only, when an explicit model is required:
wolfpack agent spawn <project> --name 200-implementation --model <provider/model> --plan .plans/000-task.md --notify-parent --json
```

`wolfpack session open` is only a deprecated child-spawn alias. Never use it for a top-level request.
Replace `<project>` with `--project-dir <path>` when the user explicitly selects an existing directory outside the configured projects root. The CLI resolves relative paths and the server validates/canonicalizes the directory; never send both selectors.
Both creation commands perform one server-owned request and pass startup instructions without inheriting parent transcript/context. `--model` is child-only: for Pi parents it forwards one bounded nonblank opaque value to Pi's native option; non-Pi parents reject it. Omit it to preserve the parent's normal model behavior.

For an opt-in Pi task worker whose endpoint must be ready before creation succeeds, use only an explicit worktree root and no startup instruction:

```bash
wolfpack agent spawn --project-dir /absolute/worktree --name 301-worker --task-worker --readiness-timeout-ms 30000 --json
```

`--task-worker` requires Pi, rejects named-only project selection, prompt/plan files, and `--notify-parent`, and returns opaque `taskEndpoint` only after exact live session identity, canonical root, and relay v2 registration are verified. It does not prove model or task execution. On failure retain the returned `createdSession` and cleanup disposition; do not retry against a name or scrape terminal text.

Use `--name <session>` for child agents and choose a short meaningful issue/role slug, for example `200-implementation`, `200-delivery-review`, or `auth-boundary-audit`. Avoid generic `*-sub-agent` names when the task purpose is known; Wolfpack will allocate a numbered suffix if the requested name is already taken. Prefer `--plan <file>` for plan work: Wolfpack generates the compact handoff prompt and verifies the file exists without copying plan contents into the parent transcript. Use `--prompt-file <file>` for long bespoke instructions. Use raw `--prompt` only for one short prompt sentence. Do NOT paste repository policy, architecture context, or full plans into the launch command.

## Structured inspection and control

To explicitly target a configured Tailnet peer, prefix only supported control commands:

```bash
wolfpack --machine <short-name-or-fqdn> list --json
```

Short names use the exact suffix from configured `tailscaleHostname`; full names must be canonical hostnames in that suffix. The CLI verifies bounded structured `GET /api/machine` identity, uses normal JWT auth, and makes invalid targets fail closed without localhost fallback. Remote JSON success adds verified `machine` identity and preserves server-owned `sessionId`. Remote `agent spawn` resolves the parent on the selected machine; no cross-machine parent lineage is created. Unsupported commands reject `--machine`.

```bash
wolfpack list --json
wolfpack session status <session-or-id> --json
wolfpack session read <session-or-id> --json
wolfpack session send <session-or-id> '<text>' --json
wolfpack session wait <session-or-id> '<text>' --json
```

Treat session selectors as opaque handles. Prefer the stable `sessionId` returned by create/spawn/list/status. If the user already supplied an exact target, do not list first.

## Parent-owned teardown

`/quit` exits the Pi harness only; it does not kill the shell-backed Wolfpack session, which may remain active. When the parent owns cleanup after an explicit task result, kill the exact child ID, then verify it is absent:

```bash
wolfpack kill <session-or-id> --json
wolfpack list --json

wolfpack --machine <short-name-or-fqdn> kill <session-or-id> --json
wolfpack --machine <short-name-or-fqdn> list --json
```

A successful kill returns JSON with `ok: true`, `session`, and `sessionId`; remote output also has verified `machine` identity. The global Wolfpack auth policy remains the boundary. Do not kill a mistaken session or treat `/quit` as teardown.

Read-only inspection is allowed when requested. Creation, sending input, killing, taking control, remote-host access, and notifications require explicit user intent for that action and target. Never scrape terminal/UI prose as protocol, bypass auth, guess tokens, or kill a mistaken session as cleanup without permission.

## References — load only when needed

- [canonical session, setup, troubleshooting, and broker references](references.md)
