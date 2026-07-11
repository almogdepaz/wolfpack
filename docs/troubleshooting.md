# Troubleshooting

Start here:

```bash
wolfpack doctor
```

`doctor` checks the server, broker, binaries, JWT settings, Tailscale, and common service problems.

## `wolfpack: command not found`

The installer puts the binary at `~/.wolfpack/bin/wolfpack` and tries to symlink it to `/usr/local/bin/wolfpack`.

Fix:

```bash
export PATH="$HOME/.wolfpack/bin:$PATH"
wolfpack doctor
```

If that works, add the `PATH` line to your shell profile.

## Phone cannot open Wolfpack

Use the Tailscale hostname URL printed by `wolfpack`, not the machine's LAN IP.

Check:

```bash
tailscale status
wolfpack doctor
```

If Tailscale is not installed or not logged in, install/login first, then rerun:

```bash
wolfpack setup
```

Local-only browser access should still work at `http://localhost:<port>/` on the same machine.

## Tailscale HTTPS / `tailscale serve` is not working

Rerun setup:

```bash
wolfpack setup
```

Then check that Tailscale sees the machine and serve is configured:

```bash
tailscale status
tailscale serve status
```

If your tailnet policy blocks serve, fix that in Tailscale admin settings or use local-only access.

## Port is already in use

Pick another port:

```bash
wolfpack setup
```

Or edit `~/.wolfpack/config.json` and restart:

```bash
wolfpack service restart
```

## Service is installed but the app is not reachable

Check status and restart the server service:

```bash
wolfpack service status
wolfpack service restart
```

If the broker also needs a restart, be deliberate: broker restarts terminate broker-owned sessions.

```bash
wolfpack service restart --broker
```

## Sessions disappeared after broker restart

The broker owns PTYs. Restarting the server preserves sessions; restarting/stopping the broker is destructive.
See [`live-update-handoff.md`](live-update-handoff.md) for the current restart blast radius and broker handoff design gate.

Use server-only lifecycle commands unless you intentionally want to kill all broker-owned sessions:

```bash
wolfpack service restart
```

Avoid `--broker` unless you mean it.

## Agent command does not start

Wolfpack runs the selected command in the project directory. Confirm the command exists on the service `PATH`:

```bash
which claude
which codex
which gemini
```

If the command needs shell setup, create a wrapper script on `PATH` and add that wrapper in **Settings → Agents**.
Wolfpack intentionally rejects shell metacharacters in agent commands.

## Browser shows stale UI after upgrade

Restart the service and reload the PWA/browser tab:

```bash
wolfpack service restart
```

If you installed Wolfpack to your phone home screen, fully close and reopen the PWA after major upgrades.

## Full reset

This removes Wolfpack config, service files, and binaries:

```bash
wolfpack uninstall --yes
```

Then reinstall:

```bash
curl -fsSL https://raw.githubusercontent.com/almogdepaz/wolfpack/main/install.sh | bash
```
