# Multi-Machine Setup

Wolfpack can show sessions from multiple machines in one PWA when those machines are reachable over the same Tailscale tailnet.

## Model

Each machine runs its own Wolfpack server and broker:

```text
phone/browser
  ↓ Tailscale HTTPS
machine A: wolfpack server → local broker → local PTYs
machine B: wolfpack server → local broker → local PTYs
machine C: wolfpack server → local broker → local PTYs
```

There is no central Wolfpack coordinator. Your browser stores the machine list and talks to each machine directly.

## Install on every machine

Run this on each macOS/Linux machine:

```bash
curl -fsSL https://raw.githubusercontent.com/almogdepaz/wolfpack/main/install.sh | bash
wolfpack
```

During setup, use the same Tailscale tailnet and let Wolfpack configure the Tailscale HTTPS URL where possible.

Check each machine:

```bash
wolfpack doctor
wolfpack service status
tailscale status
```

## Add machines

Open Wolfpack, then go to **Settings → Machines**.

Use one of these paths:

- **Discover peers** — Wolfpack asks the local server for reachable tailnet peers.
- **Manual add** — add another machine's Wolfpack HTTPS URL.

Machine URLs should look like:

```text
https://your-machine.your-tailnet.ts.net
```

Avoid LAN IPs for phone access. The phone usually cannot reach those once you leave the local network.

## Example workflow

- MacBook: frontend/UI agent session.
- Linux workstation: tests/builds agent session.
- Cloud VM: long-running refactor or benchmark.
- Phone: supervise all sessions and respond when one asks for input.

This is current functionality: you manually control sessions across machines. Direct agent-to-agent messaging is roadmap material, not a current launch claim.

## Failure behavior

Remote machines are best-effort. If one machine is down or slow:

- reachable machines still render.
- failed machines get shorter future timeouts.
- the local machine remains usable.

If a machine disappears:

```bash
wolfpack doctor
wolfpack service restart
tailscale status
```

Then retry **Settings → Machines → Discover peers**.

## Security model

Treat each Wolfpack URL like shell access to that machine.

Recommended baseline:

- keep Wolfpack behind Tailscale.
- do not expose it directly to the public internet.
- use optional JWT auth if your tailnet is shared broadly.
- remember agent commands run with your local user permissions.

JWT docs are in the main [README](../README.md#optional-jwt-auth).
