# Architecture Audit

Combined audit context + terminal lifecycle inventory. Nontrivial findings only.

## Terminal Architecture

```
                         ┌─────────────────────┐
                         │  Server: websocket.ts│
                         │  handlePtyWs()       │
                         │  setupNewPtyEntry()  │
                         │  activePtySessions   │
                         └────────┬────────────┘
                                  │ /ws/pty
                    ┌─────────────┴──────────────┐
                    │                            │
         ┌──────────▼──────────┐     ┌───────────▼──────────┐
         │ Single Desktop View │     │ Grid Cell View        │
         │ state.terminalController  │ state.gridSessions[]  │
         └─────────────────────┘     └───────────────────────┘
```

Server is unified. Both views share xterm construction, addons, copy/paste, reconnect policy, and prefill logic. Grid uses fontSize-2 and lower scrollback.

### Key Divergences (Single vs Grid)

| Aspect | Single | Grid |
|---|---|---|
| **WS close 4002 (displaced)** | Shows "displaced" status, user clicks "Reconnect" | Immediately reconnects silently (gets conflict overlay) |
| **WS close 4001 (session ended)** | Shows "session ended" message | Falls through to reconnect timer |
| **Connection status** | Full status bar | No per-cell status bar, silent reconnect |
| **Stdin guard** | Always active | Only focused cell can send |
| **Snapshot save** | Writes to localStorage on data write | Not saved |
| **PTY reset** | Not used | `_resetPty` flag for sessions that had full-width PTY |

### Invariants

- **INV-1: Hydrate → scroll bottom**: Server sends scrollback via `capture-pane -e -S -N` before PTY stream. Container starts `visibility: hidden`, reveals after prefill + scrollToBottom. Timeout fallback reveals if no data.
- **INV-2: Focused grid cell alone accepts stdin**: `disableStdin`/`cursorBlink` set per cell. `onData`/`onBinary` guard with focus check.
- **INV-3: Take-control flow**: Server `viewer_conflict` → overlay → user "Take Control" → `take_control` msg → server nulls old viewer, tears down old PTY, promotes pending → `control_granted` → overlay removed.
- **INV-4: PTY spawn deferred until first resize**: `setupNewPtyEntry()` creates entry with `proc: null`. First resize triggers `spawnPty(cols, rows)`.
- **INV-5: Detach safety**: Server only tears down PTY if `entry.viewer === ws && activePtySessions.get(session) === entry`. Take-control nulls `entry.viewer` BEFORE closing old WS.

## High Severity Findings

### Session auth uses weak path prefix check
`isAllowedSession()` does `pane_current_path.startsWith(DEV_DIR)`. A path like `/Users/home/Developer/foo` matches `/Users/home/Dev`. Fix: use `DEV_DIR + path.sep` boundary or `path.relative()`.

### PTY websocket drops binary payloads starting with `{`
`setupNewPtyEntry()` treats any binary frame whose first byte is `{` as JSON control traffic. Typing/pasting `{` as first char → parsed as JSON → fails → discarded. Fix: string frames = control, binary frames = raw stdin. Kill the heuristic.

### Frontend API helper and action handlers disagree about failures
`api()` returns parsed JSON even on non-2xx. Callers treat resolved promise as success. `sendMsg()` clears composer before request, only restores in `catch` — structured 4xx loses typed input. Fix: throw on non-2xx or return `{ ok, data, error }` consistently.

### Ralph worker scope is prompt-only, not enforced
Prompt says "only work under this project directory" but worker config grants broad file-changing and shell tools. Scope is social, not mechanical.

### `killPortHolder()` can terminate unrelated processes
Looks up any PID on the configured port and sends SIGTERM without verifying it's a wolfpack process.

### Tests mirror production code instead of importing it
`tests/integration/api.test.ts`, snapshot tests, and `escaping.test.ts` reimplement helpers. Can pass while production drifts.

## Medium Severity Findings

### Ralph path safety inconsistent across endpoints
Some Ralph routes reject symlinks, others don't. Symlink under `DEV_DIR` can escape project tree on unguarded routes. Fix: centralize project directory resolution.

### `/api/git-status` guesses project from session name
Strips trailing `-2`, `-3` etc. Custom session names or projects naturally ending in numbers get mis-resolved. Fix: resolve from tmux metadata.

### Grid reconnect weaker than single-terminal
Grid cells reconnect on timer budget but lack the same state handling. Long sleep/network flap → dead cells until manual rebuild.

### Grid focus restoration wrong on lower-index removal
Removing a cell before the focused one doesn't shift focus index left. Focus jumps to wrong terminal in 4+ cell grids.

### Ralph subtask expansion only adds one iteration
Late breakdown into multiple subtasks only increments `maxIterations` by 1. New subtasks can remain open when run ends.

### Ralph task completion depends on exact text match
`markSectionDone()`/`markCheckboxDone()` match raw text. Agent rewriting task text without changing counts → silent failure → re-picks completed work.

### `/api/ralph/start` mutates git before full validation
Acquires lock and may create/switch branch before validating plan file. Failing request still mutates repo state.

### Ralph cleanup scope broader than current session
Cleanup inspects `HEAD~10..HEAD` instead of `START_COMMIT..HEAD`. On long-lived branches, can inspect/remove unrelated code.

## Structural Debt

### Frontend monolith
`public/index.html` carries too much behavior in one file. Duplicated state logic and drift between desktop/grid paths. Should split into: API client, settings store, machine registry, terminal controllers, grid controller, Ralph UI.

### Ralph monolith
`src/ralph-macchio.ts` should split into: plan parsing/mutation, agent invocation, iteration loop, cleanup pass.

### Duplicated implementations (root cause of most bugs)
- desktop vs grid terminal logic
- production vs test helpers
- prompt rules vs validator rules
- CLI expectations vs actual lifecycle behavior

Fixing duplication boundaries removes a large fraction of the bug surface.
