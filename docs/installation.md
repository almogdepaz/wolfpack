# installation and first success

Wolfpack runs selected agent commands with your local user permissions. Install it only on machines and Tailnets you control.

## choose an install path

### curl installer: persistent CLI

Use curl when you want `wolfpack` available on your `PATH`:

```bash
curl -fsSL https://raw.githubusercontent.com/almogdepaz/wolfpack/main/install.sh | bash
wolfpack
```

The installer downloads the matching `wolfpack` and `wolfpack-broker` releases, verifies them, then runs setup. Once configured, a bare `wolfpack` stages the current server binary, ensures the managed server is running, and prints the local URL, verified remote URL when available, and a QR code. It restarts only the server when updating; broker-owned sessions remain alive.

### Bunx or npm: no persistent CLI

Use a package runner when you do not want a global `wolfpack` command. Pin `@latest` so the runner does not reuse an older cached release:

```bash
bunx wolfpack-bridge@latest
# or
npx --yes wolfpack-bridge@latest
```

These commands resolve the same matching prebuilt `wolfpack` and `wolfpack-broker` pair and run the same setup wizard, but do **not** add `wolfpack` to your `PATH`. Repeat the runner prefix for every later command.

## setup choices

Setup asks you to choose or confirm:

- the projects directory that contains sessions you want to create;
- the Wolfpack port;
- Tailscale sign-in and private HTTPS remote access, when available;
- optional Pi integration, when Pi is detected; and
- whether Wolfpack should start automatically at login.

On first setup, Wolfpack enables `shell` and supported agent CLIs detected on `PATH`; it does not overwrite existing agent settings. Tailscale is used for private phone and remote access. Without it, setup continues with local-only access.

## what success looks like

A successful setup prints a local URL. When Tailscale is signed in and `tailscale serve` is verified, it also prints a private Tailnet HTTPS URL and QR code. Open the local URL on the host machine, or scan only the verified remote QR code from a trusted Tailnet device.

Run the matching diagnosis command after setup:

| install path | diagnosis |
| --- | --- |
| curl | `wolfpack doctor` |
| Bunx | `bunx wolfpack-bridge@latest doctor` |
| npm/npx | `npx --yes wolfpack-bridge@latest doctor` |

`doctor` checks the server, broker, binaries, JWT configuration, Tailscale, and common service problems. Resolve any reported failures; see [troubleshooting](troubleshooting.md) for recovery steps.

## service and platform behavior

The installer supports macOS arm64/x64 and Linux x64/arm64. The bundled broker includes its Ghostty VT engine; release installs do not require Zig, Ghostty, or extra system libraries.

On macOS, Wolfpack can install a login service. On Linux, managed services use `systemd --user`; persistence after reboot needs `sudo loginctl enable-linger $USER`. Automatic Tailscale installation on Linux requires `apt`; otherwise install Tailscale yourself. You can always run Wolfpack in the foreground instead of installing a service.

Use `wolfpack service status` after a curl installation to inspect the managed service. Package-runner users should use the matching Bunx or npm prefix.

## uninstall

Uninstall removes Wolfpack-managed files and the installer-created `/usr/local/bin/wolfpack` symlink, but never an unrelated command with the same name:

| install path | uninstall |
| --- | --- |
| curl | `wolfpack uninstall --yes` |
| Bunx | `bunx wolfpack-bridge@latest uninstall --yes` |
| npm/npx | `npx --yes wolfpack-bridge@latest uninstall --yes` |

## security and trust

Wolfpack has no inter-session authorization layer. Anyone who can access its Tailnet/global endpoint can list and control visible sessions, and those sessions execute commands as the local user in selected project directories. Treat Wolfpack access as shell access to that machine.

Keep Wolfpack private to a trusted Tailnet. If other people share the Tailnet, use Tailscale device/user ACLs and consider optional JWT authentication. Wolfpack has no hosted relay or managed account; Tailscale normally provides remote HTTPS access.

For architecture and terminal ownership details, see the [README](../README.md). For failures after installation, use [troubleshooting](troubleshooting.md).
