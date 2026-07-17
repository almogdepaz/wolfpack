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
wolfpack agent spawn <project> --prompt '<instruction>' --json
```

`wolfpack session open` is only a deprecated child-spawn alias. Never use it for a top-level request.
Both creation commands perform one server-owned request and pass the prompt at process startup.

Use one short prompt that references the source-of-truth plan instead of repeating it:

```text
execute .plans/000-task.md. verify assumptions first. stop before irreversible publication or cleanup.
```

## Structured inspection and control

```bash
wolfpack list --json
wolfpack session status <session-or-id> --json
wolfpack session read <session-or-id> --json
wolfpack session send <session-or-id> '<text>' --json
wolfpack session wait <session-or-id> '<text>' --json
```

Treat session selectors as opaque handles. Prefer the stable `sessionId` returned by create/spawn/list/status. If the user already supplied an exact target, do not list first.

Read-only inspection is allowed when requested. Creation, sending input, killing, taking control, remote-host access, and notifications require explicit user intent for that action and target. Never scrape terminal/UI prose as protocol, bypass auth, guess tokens, or kill a mistaken session as cleanup without permission.

## References — load only when needed

- command/API behavior: `docs/session-control.md`
- setup, auth, and Tailscale: `README.md`
- troubleshooting: `docs/troubleshooting.md`
- broker internals only when changing transport: `docs/broker-protocol.md`
- Ralph automation: `skills/wolfpack-ralph/SKILL.md`
