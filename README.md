# Wolfpack

```
        ...:.
           :=+=:
       . .-*####+-
      .- :++**####*=.
       -  :+***#####*=:.
       :   .+**######*+==++++++=:..
       ..   .=*#######*++++====+=--=-.
       .:.-    -+**######**+*#*+=-:-===:
     -.  ..     -++++***#**++*#*--:---===:
     -.:--==+=--=*++*+**********+==------++-
     .:----=++*++##########******+=====--=+#=-.
       .::-----=++*#%%%%%%#***###*+===--==+*=++=:.
         ...::::-=+*#%%############*+-----===+****+=:.
          :--=-====+******++****##***-.::--++*######**
         .++-+++++***********#*+*#***=.:---=+**=--=+==
         -**++*++****+***##*++*****++=. ----=+=.  ..:-
        .+##***+*+*****##*#=-=**=-=-::. -**-::-==+++++
        :*%%*+=+=+****##**++****+**+-.. -*=-   .::::-=
        .-#%#*+*+**#***+++**+****+*++=--+=::-:..:...-+
         =###***=*+++++-=*=+++++-====-=:-=--:=---==---
        .:-+***+=*+++**+++===*++++=--:=  ::=::-=----++
          .+****+++++*##+***++=+*-.:--:..-===---=-:-++
          .-+###**+++*#****+=---:--==.--=:==-==:::-=++
            :####*****+++======:.. :...:::---:.=------
            .=###***+++*++++--:.:::.   :-=::.:..-:---:
             :+**++++++*++*+=-:: .. ...... ..   .:..::
```

Mobile command center for your AI coding agents. Control tmux-based agent sessions (Claude, Codex, Gemini, etc.) from your phone via a PWA.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/almogdepaz/wolfpack/master/install.sh | bash
```

This checks prerequisites, clones the repo, installs dependencies, and runs the setup wizard.

## Manual Install

```bash
git clone https://github.com/almogdepaz/wolfpack.git ~/.wolfpack/app
cd ~/.wolfpack/app
npm install
npm link
wolfpack
```

## Prerequisites

- **Node.js** (v18+)
- **tmux**
- **Tailscale** (for remote access from phone)

## Usage

```bash
wolfpack                    # Start the server (runs setup on first launch)
wolfpack setup              # Re-run the setup wizard
wolfpack service install    # Auto-start on login (macOS launchd)
wolfpack service stop       # Stop the background service
wolfpack service start      # Start the background service
wolfpack service status     # Check if running
wolfpack service uninstall  # Remove the launch agent
wolfpack uninstall          # Remove everything (service, config, global command)
```

## Setup Wizard

On first run, `wolfpack` walks you through:

1. Checking prerequisites (Node.js, tmux, Tailscale)
2. Setting your projects directory (default: `~/Dev`)
3. Choosing a port (default: `18790`)
4. Enabling Tailscale HTTPS access
5. Optionally installing as a login service
6. Displaying a QR code to scan with your phone

## Features

- **Session management** — View, create, and kill tmux agent sessions
- **Live terminal** — Capture-pane polling gives you a real-time terminal view
- **Project picker** — Start new sessions from any folder in your projects directory
- **Agent presets** — Quick-switch between Claude, Codex, Gemini, or custom commands
- **Terminal controls** — Tab, Enter, Escape, arrow keys, y/n, Ctrl-C buttons for TUI interaction
- **Auto-resize** — Tmux pane resizes to match your phone screen
- **PWA** — Install as an app on your phone's home screen
- **Reconnect handling** — Shows status when connection drops, auto-recovers

## How It Works

```
Phone (PWA) ←→ Tailscale HTTPS ←→ wolfpack server (HTTP) ←→ tmux sessions
```

- Server uses `tmux capture-pane` to snapshot terminal output (clean, no ANSI codes)
- Client polls every 1s for updates
- Text input and key presses are sent via `tmux send-keys`
- Tailscale provides encrypted transport and DNS — no port forwarding needed
- **The server has no built-in authentication.** Tailscale is the security layer — only devices on your tailnet can reach it. Do not expose the server to the public internet without adding your own auth.

## Config

Stored in `~/.wolfpack/config.json`:

```json
{
  "devDir": "/Users/you/Dev",
  "port": 18790,
  "tailscaleHostname": "your-machine.tailnet-name.ts.net"
}
```

Agent command preset stored in `bridge-settings.json` in the app directory.

## License

MIT
