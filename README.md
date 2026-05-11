# Wolfpack

[![CI](https://github.com/almogdepaz/wolfpack/actions/workflows/test.yml/badge.svg)](https://github.com/almogdepaz/wolfpack/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)]()
[![Version](https://img.shields.io/github/v/release/almogdepaz/wolfpack?label=version)](https://github.com/almogdepaz/wolfpack/releases)
[![GitHub stars](https://img.shields.io/github/stars/almogdepaz/wolfpack?style=social)](https://github.com/almogdepaz/wolfpack/stargazers)

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
       .::-----=+*#%%%%%%#***###*+===--==+*=++=:.
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

Mobile & desktop command center for AI coding agents. Control agent sessions (Claude, Codex, Gemini, or any custom command) across multiple machines from your phone or browser. Sessions live in a dedicated Rust PTY broker daemon, so they survive wolfpack server restarts and redeploys. Secured by [Tailscale](https://tailscale.com/) — zero-config encrypted access, no ports to open.

Install on your phone's home screen for a native app experience — scan the QR code after setup and tap **"Add to Home Screen"**.

### Desktop
<p align="center">
  <img src="docs/desktop-terminal.png" width="700" alt="Desktop — terminal with collapsible sidebar" />
</p>
<p align="center">
  <img src="docs/desktop-grid.png" width="700" alt="Desktop — multi-terminal grid view" />
</p>

### Mobile

<p align="center">
  <img src="docs/mobile-sessions.png" width="250" alt="Mobile — session list with multi-machine support" />
</p>
<p align="center">
  <img src="docs/mobile-ghostty.png" width="300" alt="Mobile — ghostty-web terminal" />
</p>

## Architecture

```
┌─────────────┐    ┌───────────┐    ┌──────────────────────────────────────────┐
│   Phone /   │    │ Tailscale │    │              Your Machine                │
│   Browser   │◄──►│  (HTTPS)  │◄──►│                                          │
│   (PWA)     │    │  mesh VPN │    │  ┌──────────┐  unix   ┌──────────────┐  │
└─────────────┘    └───────────┘    │  │ wolfpack │ socket  │  wolfpack-   │  │
                                    │  │  server  │◄───────►│   broker     │  │
                                    │  │ (Bun)    │         │  (Rust, PTY) │  │
                                    │  │ HTTP/WS  │         │  owns agents │  │
                                    │  └──────────┘         └──────────────┘  │
                                    └──────────────────────────────────────────┘
```

**Components:**
- **PWA** — vanilla JS, no framework. ghostty-web (WASM) renders the terminal on both mobile and desktop. Settings + multi-machine list persist in localStorage.
- **Server** — Bun HTTP + WebSocket. Serves embedded assets, exposes `/api/*` and the `/ws/pty` binary stream. Pure broker client — owns no PTYs.
- **Broker** — `wolfpack-broker`, a Rust daemon. Owns every PTY, keeps per-session output rings, and survives wolfpack server restarts. One Unix-domain socket per host (`$XDG_RUNTIME_DIR/wolfpack-broker.sock`, fallback `~/.wolfpack/broker.sock`). Wire format documented in [docs/broker-protocol.md](docs/broker-protocol.md).
- **Ralph** — detached subprocess that iterates through a markdown plan file, invoking agents per-task. See [docs/ralph-macchio.md](docs/ralph-macchio.md).
- **Agents** — Claude, Codex, Gemini, or any shell command. Agent-agnostic by design.

## Quick Install

```bash
bunx wolfpack-bridge
```

Or with npx:

```bash
npx wolfpack-bridge
```

Or via shell script (no Node/Bun required):

```bash
curl -fsSL https://raw.githubusercontent.com/almogdepaz/wolfpack/main/install.sh | bash
```

This will download the pre-built binary for your platform, run the setup wizard, and optionally install as a login service.

Supported platforms: macOS (Apple Silicon, Intel), Linux (x64, arm64). Each platform package ships both `wolfpack` (the Bun binary) and `wolfpack-broker` (the Rust daemon).

### Prerequisites

- **Tailscale** *(optional)* — install from [tailscale.com/download](https://tailscale.com/download), sign in, and make sure both your computer and phone are on the same tailnet. Required for remote access.

No other runtime dependencies. The broker is bundled.

### Session Persistence

The `wolfpack-broker` daemon owns every PTY and runs independently of the wolfpack server. If the server crashes, gets redeployed, or restarts (e.g. `launchctl kickstart`), agent sessions keep running. When the server comes back up, it reconnects to the existing broker over the Unix socket and re-attaches to live sessions automatically.

The broker is started by `wolfpack service install` (alongside the server) and is checked by `wolfpack doctor`.

## Usage

```bash
wolfpack                    # Start the server (runs setup on first launch)
wolfpack setup              # Re-run the setup wizard
wolfpack ls                 # List active broker sessions
wolfpack kill <session>     # Kill a session by name
wolfpack doctor             # Diagnose broker socket, binaries, JWT, Tailscale
wolfpack migrate-plan FILE  # Convert old-format plan headers to ## N. Title
wolfpack service install    # Auto-start on login (launchd / systemd) — installs broker too
wolfpack service stop       # Stop the background service
wolfpack service start      # Start the background service
wolfpack service status     # Check if running
wolfpack service uninstall  # Remove the launch agent
wolfpack uninstall --yes    # Remove everything (service, config, ~/.wolfpack, global command)
```

### Setup Wizard

On first run, `wolfpack` walks you through:

1. Checking prerequisites (Tailscale — optional)
2. Setting your projects directory (default: `~/Dev`)
3. Choosing a port (default: `18790`)
4. Detecting/configuring Tailscale HTTPS access
5. Optionally installing as a login service (which also installs the broker)
6. Displaying a QR code to scan with your phone
7. Printing JWT setup instructions

## Features

### Session Management
- Create, view, and kill agent sessions — all owned by the broker daemon
- Agent picker — Claude, Codex, Gemini, or custom commands per session (configurable in Settings → Agents)
- Session triage — running, idle, and needs-input states with color-coded indicators
- Live terminal output preview on session cards

### Desktop
- **Multi-terminal grid** — view multiple sessions side-by-side in a CSS grid layout. Click `+` on any sidebar card to add it to the grid, `×` to remove. Focused cell highlighted.
- **Collapsible sidebar** — pin or auto-hide. Shows all sessions across machines with status badges, output preview, and grid/kill buttons.
- **ghostty-web terminal** — full WASM terminal emulator with direct binary `/ws/pty` connection. Per-instance isolation lets each grid cell run its own emulator.
- **Keyboard shortcuts:**
  - `Cmd/Ctrl + ArrowUp/Down` — cycle between sessions
  - `Cmd/Ctrl + ArrowLeft/Right` — navigate grid cells
  - `Cmd/Ctrl + T` — new session (project picker)
  - `Cmd/Ctrl + K` — clear focused terminal

### Mobile
- **ghostty-web terminal** — same WASM emulator as desktop, with the on-screen keyboard suppressed until you tap the keyboard button (prevents accidental focus steals).
- **Keyboard accessory** — quick-action bar with Enter, Esc, arrow keys, a `git` shortcut, and copy/keyboard buttons.
- **Quick commands** — user-defined command chips, configurable in Settings.
- **Touch scrolling** — momentum physics, long-press to select text and copy.
- **Haptic feedback** — vibration on key actions (toggleable).
- **PWA** — install as a standalone app on your phone's home screen.

All settings (font size, haptics, enter-sends, snapshot TTL, etc.) persist in localStorage across sessions.

### Multi-Machine
- One phone connects to multiple Wolfpack servers
- Sessions grouped by machine with online/offline status
- Auto-discover Tailscale peers running Wolfpack
- Cross-machine session management from a single UI

### Other
- **Notifications** — browser notifications + vibration when sessions need attention
- **Reconnect handling** — auto-recovers on connection drop with status indicator
- **Auto-resize** — terminal resizes to match your screen/grid cell

### Remote Access

1. Install [Tailscale](https://tailscale.com/download) on both your computer and phone
2. Sign in to the same Tailscale account on both devices
3. Run `wolfpack setup` — it auto-detects your Tailscale hostname and runs `tailscale serve` to expose the port over HTTPS
4. Scan the QR code with your phone
5. Tap **"Add to Home Screen"** for the native app experience

Tailscale's encrypted mesh network handles auth and routing — no ports to open, no DNS to configure.

### Security

**Always use the Tailscale hostname** (e.g. `https://mybox.tail1234.ts.net`) — not raw IPs. The QR code from setup already points to the correct URL. Raw IP access (LAN or Tailscale `100.x.x.x`) bypasses Tailscale's DNS-based routing and may not be protected by CORS.

**JWT authentication** adds a second layer of protection. Without it, anyone who can reach the server port has full access to your sessions. To enable:

1. Generate a secret (minimum 32 characters):
   ```bash
   openssl rand -base64 48
   ```
2. Set the environment variable before starting wolfpack:
   ```bash
   export WOLFPACK_JWT_SECRET="your-secret-here"
   ```
   For service installs, add it to your shell profile or the service environment.

3. Optional configuration:
   - `WOLFPACK_JWT_AUDIENCE` — expected `aud` claim
   - `WOLFPACK_JWT_ISSUER` — expected `iss` claim
   - `WOLFPACK_JWT_CLOCK_TOLERANCE_SEC` — clock skew tolerance (default: 30s)

Tokens use HS256 (HMAC-SHA256). The server validates but does not issue tokens — generate them with any JWT library using the same secret.

**Without `WOLFPACK_JWT_SECRET` set, authentication is disabled.** This is fine for localhost-only usage but strongly recommended when the server is reachable over a network.

## Ralph Loop

Autonomous task runner. Write a markdown plan file, pick an agent, set iterations, and let it rip. Ralph reads the plan, extracts the first incomplete task, hands it to the agent, marks it done, and moves on — implementing, testing, and committing along the way. See [full documentation](docs/ralph-macchio.md).

## Config

Stored in `~/.wolfpack/config.json` (mode 0600):

```json
{
  "devDir": "/Users/you/Dev",
  "port": 18790,
  "tailscaleHostname": "your-machine.tailnet-name.ts.net"
}
```

Agent list and per-server settings stored in `~/.wolfpack/bridge-settings.json`.

The broker socket lives at `$XDG_RUNTIME_DIR/wolfpack-broker.sock` (or `~/.wolfpack/broker.sock`) and is owned by the user (filesystem permissions are the auth boundary).

## Contributing

### Dev Setup

Requires [Bun](https://bun.sh/) (v1.2+) and a [Rust toolchain](https://rustup.rs/) (for building the broker).

```bash
git clone https://github.com/almogdepaz/wolfpack.git
cd wolfpack
bun install
bun run scripts/gen-assets.ts          # generate embedded assets (required once)
cargo build --release --manifest-path broker/Cargo.toml  # build the broker
bun run src/cli/index.ts                # start the server locally
```

For an end-to-end local install (build + service install + restart), use `scripts/deploy-local.sh`.

### Testing

```bash
bun test                                 # all bun tests
bun test tests/unit/                     # unit tests only
bun test tests/unit/plan-parsing.test.ts # single file
bunx playwright test                     # e2e (uses test-server harness)
```

Test layout:
- `tests/unit/` — pure-logic tests (plan parsing, ralph log parsing, escaping, validation, grid logic, broker codec, etc.)
- `tests/integration/` — API routes, broker backend, ralph loop endpoints, WS dispatch
- `tests/snapshot/` — launchd plist and systemd unit generation
- `tests/e2e/` — Playwright end-to-end (`test:e2e` / `test:e2e:headed` scripts)

The Rust broker has its own tests under `broker/tests/` (`cargo test` from `broker/`).

### Asset Pipeline

Frontend files live in `public/`. The server doesn't serve from disk — everything is embedded:

1. Edit files in `public/` (HTML, TS, CSS, manifest, etc.)
2. Run `bun run scripts/gen-assets.ts` — bundles `public/app.ts` and ghostty-web, then embeds every file from `public/` into `src/public-assets.ts` (binary→base64, text→string)
3. **Do NOT edit `src/public-assets.ts` manually** — it's auto-generated

### Building Binaries

```bash
bun run scripts/build.ts    # assets + broker + 4 platform binaries + npm pkg dirs in dist/
```

Compiles `wolfpack` for: linux-x64, linux-arm64, darwin-x64, darwin-arm64. The script also stages `wolfpack-broker` per platform — in CI it expects pre-built broker binaries under `dist/broker/<target>/`; locally it falls back to a host-arch-only `cargo build --release`.

### PR Conventions

- Branch off `main`
- Tests must pass (`bun test`)
- Keep PRs focused — one feature or fix per PR

## Community & Support

- 💬 [Open a Discussion](https://github.com/almogdepaz/wolfpack/discussions) — questions, ideas, show & tell
- 🐛 [File an Issue](https://github.com/almogdepaz/wolfpack/issues) — bugs and feature requests
- ⭐ **Star the repo** if Wolfpack saves you time — it helps others find it

## License

MIT
