# Plan: Terminal Upgrade + README Overhaul + UI Facelift

## Context

Three improvements, ordered easy → hard:

1. **README** — current README is functional but lacks badges, architecture diagram, comparison to alternatives, and contributor info. Reference projects (webmux, claude-conduit, 247-claude-code-remote) have better structure.
2. **UI facelift** — the PWA CSS is functional but bulky: oversized padding, tall buttons, wasted vertical space. Tighten everything for a leaner, more professional look.
3. **xterm.js integration** — replace `<pre>` + AnsiUp + capture-pane polling with a real terminal emulator. xterm.js v6 removed the canvas renderer (the historical flicker source), only DOM + WebGL remain. Backend switches from polling to PTY streaming via `tmux attach-session` piped through binary WebSocket.

---

## ~~1. README overhaul~~

Update `README.md` with:

- **Badges**: version, license, platform, CI status (shields.io)
- **Architecture section**: ASCII diagram showing `Phone → Tailscale → wolfpack server → tmux → agent` with component labels (PWA, HTTP/WS, CLI, Ralph)
- **Feature comparison table**: wolfpack vs webmux vs tmux-web vs raw SSH — columns for mobile PWA, multi-machine, multi-agent, ralph loop, no auth setup
- **Ralph section expansion**: add example plan file format, explain iteration mechanics, link to wolfpack-context.ts
- **Screenshots**: keep existing, add captions
- **Contributing section**: dev setup, test commands, asset pipeline, PR conventions
- **Trim redundancy**: condense the overlapping "workflow" and "features" sections

**Files:** `README.md`

---

## ~~2. CSS facelift (`public/index.html`)~~

Visual density pass — tighter spacing, leaner controls, no functionality changes.

Key changes:
- **Header**: reduce min-height from 40px → 32px, padding from `4px 10px` → `3px 8px`
- **Session cards** (`.card`): padding from `8px 10px` → `6px 8px`, margin-bottom from 4px → 3px
- **New session button** (`.new-btn`): padding from `18px` → `10px 14px`, font-size from 16px → 13px
- **Action buttons** (`.action-btn`): padding from `10px 16px` → `6px 12px`, min-height from 44px → 36px, min-width from 44px → 36px
- **Input bar**: textarea padding tighter, send button 36px instead of 44px
- **Ralph cards** (`.ralph-card`): padding from `8px 10px` → `6px 8px`
- **List padding**: 8px → 6px
- **Settings/project items**: reduce vertical padding throughout
- **Search bar**: already compact, leave as-is
- **Mobile touch targets**: ensure buttons stay ≥ 36px for touch (down from 44px — still above the 32px minimum)

**Files:** `public/index.html` (CSS section only, ~lines 17-780)

---

## ~~3. Add xterm.js + xterm-addon-fit as embedded assets~~

- Download xterm.js v6 ESM bundle (`xterm.min.js`, `xterm.css`) and `xterm-addon-fit.min.js`
- Place in `public/` directory
- Run `scripts/gen-assets.ts` to embed them into `public-assets.ts`
- Add `<link>` and `<script>` tags to `index.html` (load xterm only on desktop, mobile stays unchanged)
- Serve the new assets from the embedded asset map in `serve.ts` (already handled by the generic asset serving code)

**Files:** `public/xterm.min.js`, `public/xterm.css`, `public/xterm-addon-fit.min.js`, `public/index.html`, `public-assets.ts` (auto-generated)

---

## ~~4. PTY streaming backend (`serve.ts`)~~

Add a new WS endpoint `/ws/pty?session=X` alongside existing `/ws/terminal`:

- On connect: spawn `tmux attach-session -t <session>` via `Bun.spawn()` with PTY (`{ stdin: "pipe", stdout: "pipe", stderr: "pipe" }` — or `Bun.Terminal` if available in current Bun version)
- Pipe PTY stdout → binary WS frames (raw bytes, no JSON wrapping)
- Pipe binary WS frames → PTY stdin (keyboard input, no key mapping needed — xterm.js sends raw escape sequences)
- On resize message (JSON `{type:"resize", cols, rows}`): send SIGWINCH or use PTY resize API
- On WS close: kill the PTY child process
- On PTY exit: close WS
- Keep the existing `/ws/terminal` endpoint working for mobile (capture-pane polling is fine on mobile)
- Security: same origin check, same session validation, same key allowlist is unnecessary (raw PTY, not tmux send-keys)

**Key decision**: `tmux attach-session` vs `Bun.Terminal` spawning `tmux attach-session`. Need to verify which PTY approach Bun supports in our version. Fallback: `node-pty` via Bun's Node compat.

**Files:** `serve.ts`

---

## 5. Frontend xterm.js integration (`public/index.html`)

Replace `initDesktopTerminal()` / `connectDesktopWs()` / `destroyDesktopTerminal()`:

- **initDesktopTerminal()**: create `new Terminal()` + `FitAddon`, open into a `<div id="desktop-terminal-container">` (replaces `<pre id="desktop-terminal">`)
- **connectDesktopWs()**: connect to `/ws/pty?session=X` with `binaryType = "arraybuffer"`, pipe `ws.onmessage → terminal.write()`, pipe `terminal.onData → ws.send()`, pipe `fitAddon.onResize → ws.send(JSON.stringify({type:"resize",...}))`
- **destroyDesktopTerminal()**: `terminal.dispose()`, close WS, cleanup
- **Reconnect logic**: keep the existing exponential backoff pattern, just point at `/ws/pty`
- **Search**: xterm.js has `xterm-addon-search` — add it as embedded asset, wire Ctrl+F to it instead of our manual search
- **Keyboard**: remove the entire `onKeyDown` handler and key mapping — xterm.js handles all keyboard input natively
- **Paste**: remove the `onPaste` handler — xterm.js handles paste natively
- **Remove**: AnsiUp instantiation for desktop, `desktopRawAnsi`, `calcTermDimensions()` for desktop, `applySearchHighlights()` for desktop

HTML change: replace `<pre id="desktop-terminal">` with `<div id="desktop-terminal-container"></div>`

**Files:** `public/index.html`

---

## 6. Cleanup

- Remove AnsiUp library if only used by desktop (check if mobile still uses it — yes, mobile uses HTTP polling + AnsiUp, so keep it)
- Remove dead desktop-specific code paths (manual search highlighting on desktop `<pre>`, etc.)
- Test mobile still works identically (capture-pane polling + AnsiUp unchanged)
- Remove `#desktop-terminal` CSS rules, add xterm container styling

**Files:** `public/index.html`

---

## Files Summary

| File | Phases |
|------|--------|
| `README.md` | 1 |
| `public/index.html` | 2, 3, 5, 6 |
| `serve.ts` | 4 |
| `public/xterm.min.js` | 3 (new) |
| `public/xterm.css` | 3 (new) |
| `public/xterm-addon-fit.min.js` | 3 (new) |
| `public-assets.ts` | 3 (auto-generated) |

---

## Verification

```bash
bun test                                    # all tests pass
bun run scripts/gen-assets.ts               # regenerate embedded assets
launchctl kickstart -k gui/$(id -u)/com.wolfpack.server  # restart

# Manual checks:
# - Open desktop terminal → xterm.js renders with cursor, colors, scrollback
# - Type, paste, Ctrl+C, arrow keys all work natively
# - Switch tabs, come back → WS reconnects automatically
# - Open on phone → mobile UI unchanged (capture-pane + AnsiUp)
# - Search (Ctrl+F) works via xterm-addon-search
# - README renders correctly on GitHub
```

- [x] 5a. Core xterm.js wiring — replace initDesktopTerminal/connectDesktopWs/destroyDesktopTerminal with xterm.js Terminal + FitAddon over /ws/pty binary WS, replace `<pre id="desktop-terminal">` with `<div id="desktop-terminal-container">`, add xterm-addon-search as embedded asset, update CSS
- [x] 5b. Remove dead desktop code — remove onKeyDown handler, onPaste handler, AnsiUp desktop instantiation, desktopRawAnsi, calcTermDimensions (desktop usage), applyDesktopSearchHighlights, desktop mark CSS, clean up search function branching
