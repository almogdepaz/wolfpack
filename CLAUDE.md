# Wolfpack — Project Context

## What This Is

Remote tmux session controller for AI coding agents. Phone PWA → HTTP API → tmux.

## Architecture

```
Phone/Browser (PWA)          HTTP (no auth)          tmux sessions
index.html ──────────→  serve.ts:18790  ──────────→  AI agents
```

- **serve.ts**: HTTP server, tmux bridge — the attack surface
- **cli.ts**: Setup wizard, OS service management (launchd/systemd)
- **public/index.html**: PWA frontend (vanilla JS, all-in-one)
- **qr.ts**: QR code wrapper (trivial)

## Trust Model

**No authentication.** Relies on Tailscale device-level network auth.
- CORS `Access-Control-Allow-Origin: *` — any origin can call API
- Session visibility filtered by DEV_DIR (projects directory)

## Key Validation Boundaries

1. **Project names**: `/^[a-zA-Z0-9._-]+$/` — alphanumeric, dots, underscores, hyphens
2. **Agent commands**: `/^[a-zA-Z0-9 \-._/=]+$/` — no shell metacharacters
3. **Key allowlist**: 13 named keys (Enter, Escape, arrows, y, n, C-c, C-d, C-z, etc.)
4. **Session auth**: `isAllowedSession()` checks against `tmuxList()` (DEV_DIR filtered)
5. **Path traversal**: Static files checked via `startsWith(PUBLIC_DIR + "/")`
6. **Body size**: 64KB max

## File Locations

- `~/.wolfpack/config.json` — user config (devDir, port, tailscaleHostname)
- `bridge-settings.json` — agent command setting (in app directory)
- `~/.wolfpack/wolfpack.log` — service logs

## Commands

```bash
wolfpack              # Start server (runs setup if no config)
wolfpack setup        # Interactive setup wizard
wolfpack service install|uninstall|start|stop|status
wolfpack uninstall    # Full removal
```

## Development Notes

### tmux Helpers

- `tmuxList()` uses colon-delimited format — fragile if session names contain `:`
- `tmuxSend()` uses `-l` flag for literal mode — prevents key interpretation
- `capturePane()` always captures 2000 lines scrollback

### Frontend

- `esc()` function for HTML escaping in innerHTML — handles `<>&'"`
- Polling: 1s normal, 200ms fast after input
- localStorage stores remote machine registry

### Known Remaining Issues

1. Fragile: Session names with colons break `tmuxList()` parsing
2. Missing: No fetch timeout for remote machine health checks

### Fixed Issues (recent audit)

1. ~~Dead code~~: Removed unreachable try/catch after return in `GET /sw.js`
2. ~~Dead param~~: Removed unused `history` param from `capturePane()`
3. ~~Dead param~~: Removed unused `history` query param handling from `GET /api/poll`
4. ~~UX~~: "^C" button now sends Ctrl-C interrupt; separate "Kill" button for session termination
5. ~~UX~~: Removed Ctrl+C keyboard hijacking — browser copy works normally now
6. ~~Security~~: Added XML escaping in plist generation (`xmlEsc()`)
7. ~~Dead code~~: Removed `createSession()`, `createNewProject()`, `/api/nuke-cache`

### Security Considerations

- The regex validations are the security boundary for command injection
- Quote escaping in `tmuxNewSession()`: `replace(/'/g, "'\\''")` — standard shell technique
- Session authorization happens on every mutation via `isAllowedSession()`
- CORS * is intentional but allows any webpage to call API if port is known

## Testing

No test files in this project. Manual testing against running tmux sessions.

## Dependencies

Only 2 runtime deps:
- `qrcode-terminal` — QR code printing
- `tsx` — TypeScript execution (no build step)
