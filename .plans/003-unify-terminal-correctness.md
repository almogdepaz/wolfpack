# terminal correctness parity implementation

- branch: dev07
- worktree: /private/tmp/wolfpack-dev07
- status: implementation and automated verification complete; awaiting manual validation
- authorized: user explicitly said “do the work”

## goal
single and grid terminals share correctness contracts for initial reveal, reconnect hydration, takeover recovery, and snapshot persistence while retaining mode-specific payload, focus, and layout behavior.

## success criteria
- [x] viewport/grid attach waits for resize redraw output before snapshotting without adding a second resize
- [x] missing `prefill_done` closes/reconnects for full and viewport; partial content is never revealed
- [x] grid manual replacement connects perform replacement hydration
- [x] single and grid takeover use bounded retry with timer cleanup
- [x] active grid cells persist debounced snapshots during output
- [x] Command key and Command-modified shortcuts preserve scroll-lock; ordinary input still scrolls to bottom
- [x] live grid transitions were not modified; canonicalization remains separate cleanup
- [x] each behavior fix has a regression observed red then green
- [x] focused tests, full bun tests, rust tests, playwright, typecheck, asset regeneration, and diff checks pass
- [x] manual test script is documented below

## execution
1. viewport stabilization regression and minimal server fix
2. shared prefill timeout regression and fix
3. reconnect hydration regression and fix
4. takeover retry regression and shared coordinator behavior
5. grid snapshot cadence regression and per-cell persistence fix
6. canonical grid transition use where safely separable
7. regenerate browser assets
8. full verification
9. produce manual testing script

## status log
- [x] compatibility audit and current behavior matrix completed
- [x] assumptions surfaced
- [x] p0/p1 behavior implementation completed
- [x] initial viewport stabilization approach rejected after it caused two resize calls
- [x] corrected viewport path preserves one resize and observes its redraw before snapshot
- [x] automated verification completed
- [ ] manual validation pending

## verification evidence
- bun: 1,695 passed, 0 failed
- rust: 174 passed, 0 failed on fresh rerun
- playwright: 82 passed, 101 skipped
- focused desktop parity: 35 passed, 3 skipped
- typecheck: passed
- generated assets: deterministic
- `git diff --check`: passed
- command-key scroll-lock browser regression: passed against a real broker stream
- note: first rust run hit one unchanged timing test; exact rerun and full rerun passed
- note: one full bun attempt hit an unrelated deploy fixture timeout after a dangling process; isolated rerun and final full bun rerun passed

## manual test script

### preparation
1. deploy this worktree when authorized; this task did not deploy it.
2. hard-refresh every browser tab so `app.bundle.js` is not cached.
3. open browser devtools console and preserve logs.
4. prepare at least four shell sessions; use one real full-screen TUI such as claude, vim/neovim, or the fixture below.

### optional resize-heavy TUI fixture
run in a test session; press `q` to exit:

```bash
python3 - <<'PY'
import curses
import time

def run(screen):
    screen.nodelay(True)
    frame = 0
    while True:
        height, width = screen.getmaxyx()
        screen.erase()
        for row in range(max(1, height - 1)):
            text = f"frame={frame:06d} row={row:03d} size={width}x{height} " + ("#" * width)
            try:
                screen.addnstr(row, 0, text, max(1, width - 1))
            except curses.error:
                pass
        screen.refresh()
        if screen.getch() in (ord("q"), 27):
            return
        frame += 1
        time.sleep(0.05)

curses.wrapper(run)
PY
```

### single-terminal checks
1. open a shell session with at least 200 lines of history.
2. switch between it and the TUI session 20 times.
3. resize the window and sidebar while switching.
4. expected: old canvas disappears immediately; no partial redraw scrolls through; final cursor/content is authoritative; hydration never remains stuck beyond 15 seconds.

### grid checks
1. add the same sessions to a two-cell grid.
2. repeat window/sidebar resize ten times while the TUI redraws.
3. add cells until the grid contains four, then six sessions.
4. remove middle, focused, and last cells; return to single mode.
5. expected: each new cell stays hidden until hydrated; no initial vertical scroll-through; no stale single canvas; one cell’s resize/reconnect does not disturb others.
6. optional console check after initial hydration:

```js
state.gridSessions.map(({ session, controller }) => ({
  session,
  scrollback: controller?.term?.getScrollbackLength?.(),
  pending: controller?.hydration?.pending,
}))
```

### reconnect checks
1. with a live two-cell grid, set devtools network to offline for five seconds.
2. restore network and wait for both cells.
3. repeat in single mode.
4. expected: stale content is hidden during replacement prefill; all terminals reconnect independently; no duplicate transcript or partial viewport is revealed.

### take-control checks
1. open the same session in two browsers/devices.
2. click **Take Control** in single mode; repeat for one grid cell.
3. repeat after disconnecting the controlling browser.
4. expected: control transfers once, the displaced browser shows the conflict state, and a stalled in-band takeover retries through an authoritative attach after about three seconds.

### snapshot checks
1. emit a unique marker in every grid cell and wait at least three seconds.
2. inspect devtools storage or run:

```js
state.gridSessions.map(({ session, machine }) => ({
  session,
  saved: JSON.parse(localStorage.getItem(`wp-snap|${machine || ""}|${session}`) || "null")?.d,
}))
```

3. expected: every live cell’s saved text contains its marker.

### mobile checks
1. on a physical phone, open a single terminal using fast/viewport prefill.
2. background for at least 60 seconds, return, scroll, open keyboard, and send input.
3. expected: replacement remains hidden until complete; touch scroll and keyboard work immediately; no blank/stale flash.

### Command-key scroll-lock check
1. in a streaming single terminal, scroll upward and note the first visible line.
2. press and release Command; then select terminal text and press Command+C.
3. expected: the viewport remains anchored for standalone Command and Command+C.
4. press an ordinary terminal key.
5. expected: ordinary input releases scroll-lock and returns to the live bottom.

### failure report
record mode, cell count, session command/TUI, exact action, approximate blank/loading duration, screenshot/video, and whether the symptom was stale content, partial redraw, unexpected scrollback, or stuck hydration.
