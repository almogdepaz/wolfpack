# Pi / Coding-Agent Quickstart

Use this when your main agent command is `pi` and you want to supervise it from your phone.

## 1. Install Wolfpack

```bash
curl -fsSL https://raw.githubusercontent.com/almogdepaz/wolfpack/main/install.sh | bash
wolfpack
```

During setup:

1. choose the directory that contains your projects, for example `~/Dev`.
2. keep the default port unless it conflicts.
3. let Wolfpack configure Tailscale remote access if prompted.
4. install the service if you want Wolfpack to keep running after login/reboot.

## 2. Confirm `pi` is available

Wolfpack runs agent commands from the machine where the session starts. Confirm `pi` works there:

```bash
which pi
pi --help
```

If `pi` needs shell setup that is not available to login services, create a small wrapper script on `PATH` and use that wrapper as the Wolfpack command.

Example:

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/pi-agent <<'EOF'
#!/usr/bin/env bash
exec pi "$@"
EOF
chmod +x ~/.local/bin/pi-agent
```

Then add `pi-agent` in **Settings → Agents**.

## 3. Start your first Pi session

1. Open Wolfpack.
2. Pick a project.
3. Pick `pi` from the agent command list.
4. Start the session.
5. Leave it running and open the same Wolfpack URL from your phone.

Useful naming convention for sessions:

```text
<project>-<task>-<agent>
```

Examples:

```text
wolfpack-docs-pi
api-tests-pi
mobile-ui-pi
```

## 4. Add Wolfpack to your phone

Open the Tailscale HTTPS URL printed by `wolfpack`, then add it to your home screen.

On iOS:

1. open the URL in Safari.
2. tap Share.
3. tap **Add to Home Screen**.

On Android:

1. open the URL in Chrome.
2. open the browser menu.
3. tap **Add to Home screen** or **Install app**.

## 5. Add a second machine

Install Wolfpack on each machine you want to control. Use the same Tailscale tailnet.

After both machines are reachable, Wolfpack can discover peers or you can add machine URLs in **Settings → Machines**.

Common setup:

- laptop: run UI/agent sessions.
- workstation/cloud VM: run tests/builds/long jobs.
- phone: watch triage cards and jump into whichever session needs input.

## 6. Recovery checklist

If something does not show up:

```bash
wolfpack doctor
wolfpack service status
tailscale status
```

More detail: [troubleshooting.md](troubleshooting.md).
