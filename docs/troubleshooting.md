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

## A Tailnet machine does not appear in the dashboard or sidebar

This is expected for offline devices and devices that are not running a compatible, reachable Wolfpack instance. Tailnet membership alone never creates a machine card.

For a peer that should be available:

1. run `tailscale status` on both machines and confirm the peer is online;
2. run `wolfpack doctor` on the peer;
3. open the peer's canonical Tailnet HTTPS Wolfpack URL and resolve any authentication or ACL failure; and
4. use **Settings → Machines → Discover Tailnet** to inspect its bounded diagnostic.

The peer appears automatically only after its Wolfpack handshake and sessions request both succeed. Do not add an arbitrary URL or use a Tailnet node ID as a workaround. See [multi-machine control room](multi-machine-control-room.md) for the full visibility and identity boundary.

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

For macOS deployments from a source checkout, broker intent is mandatory:

```bash
./scripts/deploy-local.sh --broker=no   # server/CLI/browser changes; preserve sessions
./scripts/deploy-local.sh --broker=yes  # broker/native/Ghostty VT changes; restart the broker intentionally
```

Source deployments that rebuild the broker need the verified Ghostty VT bundle first:

```bash
scripts/setup-zig-0.16.0.sh
bun run scripts/build-ghostty-vt.ts --target "$(rustc -vV | awk '/host:/ {print $2}')"
./scripts/deploy-local.sh --broker=yes
```

Release installs and managed services support macOS and Linux. `scripts/deploy-local.sh` is macOS-only; Linux source deployments need a separate manual workflow. Release installs already include Ghostty VT inside the prebuilt `wolfpack-broker`; installing Wolfpack does not require Zig, Ghostty, or extra system libraries.

Run `--broker=yes` once, from an interactive external terminal — not from a Wolfpack session owned by the broker being replaced and not through respawning wrappers such as `launchctl submit`. The script rejects broker replacement from structured Wolfpack session context before building or mutating the installation. It also rejects noninteractive `--broker=yes` runs unless `WOLFPACK_DEPLOY_ALLOW_NONINTERACTIVE=1` is set for a known one-shot supervisor.

The deployment script uses `~/.wolfpack/deploy.lock` to prevent concurrent or respawned deploys. If a deploy fails before mutation, the lock is cleaned up. If it fails after artifacts/services have started mutating, the lock is kept so retries fail before another restart; remove it only after verifying no deploy is active.

The deployment script builds and atomically installs signed artifacts. It then verifies service PID transitions, the served browser bundle, API health, and installed CLI help. `--broker=no` additionally requires the broker PID and all pre-existing session identities to remain unchanged. A failed verification exits nonzero; the final output line is a JSON deployment summary.

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

This removes Wolfpack config, service files, and binaries. It also removes `/usr/local/bin/wolfpack` only when that symlink points to Wolfpack's managed binary; unrelated `wolfpack` commands are left untouched:

```bash
wolfpack uninstall --yes
```

Then reinstall:

```bash
curl -fsSL https://raw.githubusercontent.com/almogdepaz/wolfpack/main/install.sh | bash
```
