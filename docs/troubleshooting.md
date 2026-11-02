# Troubleshooting

Start here:

```bash
wolfpack doctor
```

`doctor` checks the server, broker, binaries, JWT settings, Tailscale, common service problems, and storage capacity.

## Storage capacity before exhaustion

```bash
wolfpack doctor --storage
wolfpack doctor --storage --json
```

`--storage` runs only local, on-demand capacity checks: no network/service probes, log excerpts, store initialization, cleanup, permission repair, task replay or retention sweep. It cannot be combined with `--fix`. `WOLFPACK_DIR` selects the local state root as usual; this is not a remote-machine API. No document bodies, receipts, task assignments, session IDs or ledger filenames are printed.

- **Extension documents:** the entire host's extension root shares **256 records / 16 MiB** (serialized records, including retained receipts), not 256 per extension. At 90% of either limit doctor warns `near-full`; at either limit it reports `full` and exits 1. Count exhaustion blocks new keys even when another extension owns the records. Existing-key replacements may still fit. Per-extension count/byte attribution is an observation, not a separate quota, installed-package verification or writable-session authority.
- **Durable tasks:** counts and logical bytes are retained `.jsonl` files under sender, receiver and quarantine directories. These are **not unique tasks**, and include historical or corrupt evidence. There is no configured aggregate task count/byte limit (`null` in JSON), not an invented threshold. Task contents and the unresolved/unacknowledged subset remain unknown: diagnostics do not load history. Caches, tombstones, other files, allocated disk blocks and filesystem free space are outside these totals.
- `absent` means the path was missing and was not created. `unknown` or `unavailable` means counts/bytes are **null**, never zero. Corrupt document records, linked/unexpected entries and crash temporaries require explicit operator review; diagnostics never recover or delete them. Permission failures are unavailable, not empty stores. Warnings can exit 0, so automation must inspect `capacity.state`, not only the exit code.
- Measurements are best-effort observations, not atomic snapshots or permission to publish. JSON `measurement` distinguishes bounded coherent document reads from metadata-only counts; above document quotas, contents/attribution are not validated (`perExtension: null`). Directory work stops after 4,096 entries and reports unknown rather than scanning unlimited history. Retry during a quiet period if a writer changes the store; do not poll these scans on a timer.

Before full capacity, preserve an owner-private backup of the complete state root during a quiet/offline maintenance window (including receipts and unresolved/unacknowledged task evidence), identify the extension attribution, and reduce creation of new document keys while planning maintenance. If usage is unknown/unavailable, investigate permissions or an offline copy without deleting evidence. Do not use whole-extension purge as a capacity quick fix or raise quotas to hide pressure.

**Deferred policy decision:** targeted export/archive/per-session deletion still requires an explicit design for receipt replay, unresolved/unacknowledged history and retention ownership. These diagnostics add no deletion, automatic expiry, archival command or retention change.

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

## Reporting an unresolved problem

Use [support and reporting](../SUPPORT.md) to choose the appropriate public or private route and follow the canonical diagnostic privacy guidance.
