# Desktop Terminal: xterm.js Integration

## Context
Wolfpack's terminal view uses a `<pre>` element + text input box + key buttons. This works well on mobile but feels clunky on desktop — you can't just type into the terminal like a real terminal. Adding xterm.js on desktop gives full terminal emulation (keyboard input, ANSI rendering, cursor, vim support) while keeping the current mobile UI unchanged.

## Architecture

### Current flow
```
poll() → GET /api/poll → capture-pane -p -J → term.textContent = pane
sendMsg() → POST /api/send → tmux send-keys -l
sendKey() → POST /api/key → tmux send-keys
```

### New flow (desktop only)
```
WebSocket /ws/terminal?session=X
  server: capture-pane loop → ws.send(pane)
  client: xterm.js renders pane
  client: xterm.onData → ws.send(input) → tmux send-keys
```

## Files to modify
- `serve.ts` — add WebSocket upgrade handler
- `public/index.html` — add xterm.js terminal, desktop/mobile switching
- `scripts/gen-assets.ts` — embed xterm.js assets (or load from CDN)
- `package.json` — add `ws` dependency (or use bun's native WebSocket)

## Phase 1: WebSocket endpoint in serve.ts

### ~~1a. WebSocket upgrade handler~~
Bun has native WebSocket support but wolfpack uses `node:http` createServer. Two options:
- **Option A**: Use `ws` npm package with the existing http server
- **Option B**: Switch to Bun.serve() which has native WebSocket

Recommend **Option A** — minimal change, `ws` works with existing `createServer`:
```ts
import { WebSocketServer } from "ws";
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/ws/terminal") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = url.searchParams.get("session");
      handleTerminalWs(ws, session);
    });
  }
});
```

### ~~1b. WebSocket handler function~~
```
handleTerminalWs(ws, session):
  - validate session exists
  - start capture-pane loop (every 100ms)
  - on pane change → ws.send(JSON.stringify({ type: "output", data: pane }))
  - on ws message → parse { type: "input", data } or { type: "key", key }
    - "input" → tmuxSend(session, data)
    - "key" → tmuxSendKey(session, key)
    - "resize" → tmuxResize(session, cols, rows)
  - on ws close → stop loop
```

Keep capture-pane approach (not PTY piping) — simpler, reuses existing tmux helpers, same output format. 100ms polling over WebSocket is fast enough for interactive use.

## Phase 2: xterm.js in frontend

### ~~2a. Load xterm.js~~
Two options:
- **CDN**: `<script src="https://cdn.jsdelivr.net/npm/xterm/lib/xterm.min.js">` + CSS
- **Embed**: Download and include in public/ → gen-assets.ts embeds it

Recommend **CDN for dev, embed for prod**. Start with CDN, embed later if needed for offline/PWA.

### ~~2b. Desktop terminal element~~
Add alongside existing terminal:
```html
<div id="xterm-container" style="display:none"></div>
```

### ~~2c. Desktop detection & switching~~
In `showView("terminal")`:
```js
const isDesktop = !('ontouchstart' in window) && window.innerWidth > 768;
if (isDesktop) {
  // hide: #terminal, .actions, .input-row
  // show: #xterm-container
  // init xterm.js + WebSocket
} else {
  // show: existing mobile UI
  // use existing HTTP polling
}
```

### ~~2d. xterm.js initialization~~
```js
function initXterm(session) {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    theme: { background: '#0a0a0a', foreground: '#e0e0e0' }
  });
  term.open(document.getElementById('xterm-container'));

  const ws = new WebSocket(`ws://${location.host}/ws/terminal?session=${session}`);

  // server → xterm
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "output") {
      term.reset();
      term.write(msg.data);
    }
  };

  // xterm → server (keyboard input)
  term.onData((data) => {
    ws.send(JSON.stringify({ type: "input", data }));
  });

  // resize
  term.onResize(({ cols, rows }) => {
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  });

  // fit to container
  // use xterm-addon-fit for auto-sizing
}
```

### 2e. Output strategy
**Problem**: capture-pane returns the full screen buffer each time. xterm.js expects incremental writes, not full redraws.

**Solution**: Send full capture-pane output but use `term.reset()` + `term.write()` on each update. This is slightly wasteful but:
- Simple to implement
- Reuses existing capture-pane infrastructure
- No PTY bridging needed
- 100ms refresh is visually smooth

**Future optimization**: Track diff between captures, only send changed lines. Or switch to PTY piping for true incremental output. But start simple.

### 2f. Search on desktop
xterm.js has a search addon (`xterm-addon-search`). Replace current DOM-based search with:
```js
import { SearchAddon } from 'xterm-addon-search';
const searchAddon = new SearchAddon();
term.loadAddon(searchAddon);
// searchAddon.findNext(query);
```

## Phase 3: CSS & polish

- xterm-container: full height of terminal area, dark background
- hide mobile-only elements on desktop (action buttons, input row)
- keep header (back button, session name, search) on both
- xterm.js cursor should blink green to match wolfpack theme

## What stays the same
- All mobile UI — zero changes
- HTTP polling endpoints — still used by mobile
- tmux helpers in serve.ts
- Session management (open, kill, switch)
- Ralph loop features

## Verification
1. `bun serve.ts` starts without errors
2. Open on desktop browser → xterm.js terminal renders, keyboard input works
3. Open on phone → current mobile UI shows, no xterm.js
4. Type in xterm.js → commands execute in tmux
5. vim/nano work properly in xterm.js
6. Ctrl+C, arrow keys, tab completion all work
7. Terminal resize on window resize
8. Search works on desktop via xterm addon
9. Session switching works on both desktop and mobile
