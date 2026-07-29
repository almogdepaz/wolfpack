# ux/ui and terminal optimization audit

status: complete
date: 2026-07-29
scope: browser pwa, desktop/mobile workflows, terminal interaction, perceived performance, accessibility, and cli ergonomics

## executive summary

Wolfpack's core interaction model is sound: session state is visible, desktop and mobile layouts preserve terminal space, terminal loading has explicit phases, and broker ownership remains the correct authority boundary. The biggest remaining gains are not a wholesale redesign.

Prioritize these five outcomes:

1. resolve terminal state corruption through the existing source-layer investigation, not another repaint/resize delay.
2. remove static assets from the first-paint bottleneck; the current uncompressed Ghostty bundle makes the dashboard take about 1.3s to first paint at synthetic 10 Mbps and 4.5s at 2 Mbps.
3. repair keyboard/focus semantics: hidden views remain tabbable, clickable session/project cards are not keyboard-focusable, and status changes are not announced.
4. turn the existing typed `runtimeState` and `unseen` data into an attention queue instead of making operators scan every session.
5. make cli streams predictable: `NO_COLOR` and non-tty output currently still contain ANSI, and `--json` error paths can contaminate stdout.

## concurrent work already covering the visual baseline

`.plans/001-ui-polish.md` is already being executed in the working tree. Its current changes address named icon controls, the collapsed-sidebar handle, desktop content width, touch sizing, visual hierarchy, and baseline contrast. Finish and verify that work rather than opening a second overlapping visual-polish pass.

This audit therefore treats the following as already in progress, not new backlog:

- replace ambiguous platform glyphs with named controls
- expose a visible, keyboard-accessible collapsed-sidebar handle
- bound desktop session/settings content
- improve card and terminal-control hierarchy
- raise the weakest baseline colors

The recommendations below cover gaps not fully addressed by that plan.

## evidence and limits

### inspected

- architecture and route ownership through `edc-context/`
- browser source, CSS, terminal controller/loading/prewarm paths, server asset delivery, polling, cli, and e2e coverage
- existing investigations in `.plans/terminal-canvas-corruption.md`, `.plans/background-tab-rendering.md`, and `.plans/mobile-beforeinput-regression.md`
- live service at `127.0.0.1:18790`, read-only
- e2e server at `127.0.0.1:52003`
- desktop at 1280×720 and mobile at 390×844
- session list, terminal, project selection, settings, keyboard tab order, cli help/list output, and synthetic network loading

### measured

- local warm/mock load: roughly 23–49ms load, 32–56ms FCP, and no observed long tasks
- synthetic 10 Mbps / 80ms RTT: 1,320ms FCP and 1,652ms until a session card was observed
- synthetic 2 Mbps / 100ms RTT: 4,468ms FCP and 4,702ms until a session card was observed
- current four critical static files: about 968KB raw versus 257KB gzip, a 3.77× reduction
- static responses have `Cache-Control: no-cache` with no `Content-Encoding`, `ETag`, or `Last-Modified`
- mobile settings baseline: about 1,769px scroll height across eight sections
- baseline mobile keyboard order moved from visible controls into off-screen project/agent/settings controls after the stop buttons
- `NO_COLOR=1 wolfpack list | cat` still began with ANSI escape bytes

### limits

- synthetic throttling is not a real Tailscale path measurement
- no physical iOS/Android, VoiceOver, TalkBack, NVDA, or memory-pressure run was performed
- no live session was created, controlled, typed into, or terminated
- the working tree changed concurrently during the audit; visual-polish findings are assessed against the baseline plus the in-progress `.plans/001-ui-polish.md` diff
- prewarm memory cost and periodic repaint cost remain hypotheses until profiled

## priority matrix

| id | recommendation | impact | effort | risk | priority |
|---|---|---:|---:|---:|---:|
| T1 | finish source-layer terminal corruption remediation | critical | large | high | P0 |
| P1 | compress/cache assets and unblock first paint | high | medium | low–medium | P0 |
| A1 | fix view focus isolation and native interaction semantics | high | medium | low | P0 |
| C1 | enforce cli color/stdout/stderr contracts | high | small | low | P0 |
| A2 | restore zoom, larger type, and an accessible terminal transcript | high | medium–large | medium | P1 |
| O1 | add an attention-first session workflow from typed runtime state | high | medium | medium | P1 |
| O2 | consolidate polling and stop recapturing every pane every five seconds | high at scale | medium–large | medium | P1 |
| N1 | separate project search from creation and add fast session discovery | medium–high | medium | low | P1 |
| E1 | replace blocking dialogs and ambiguous offline states | medium | medium | low | P1 |
| S1 | reduce mobile settings traversal | medium | medium | low | P2 |
| P2 | make prewarming adaptive and add performance budgets | medium | medium | medium | P2 |
| Q1 | test WebKit and accessibility, not only Chromium device emulation | high regression value | medium | low | P1 |
| C2 | add cli completion, interactive attach selection, version, and concise startup | medium | small–medium | low | P2 |

## recommendations

### T1 — finish source-layer terminal corruption remediation

**evidence**

- `.plans/background-tab-rendering.md` isolates corruption before canvas paint under stale-dimension, high-cardinality TUI output.
- ordinary freeze/resume and forced full paint were not the failing boundary.
- the current app still contains focus/pageshow/30-second full-repaint recovery code. The newer investigation explicitly rejects periodic repaint, delay, and unacknowledged resize as corrective paths.
- upstream Ghostty fixes are not yet available as a stable npm release, and the synthetic incident linkage still needs representative Pi trace confirmation.

**recommendation**

Use the existing plan as the sole terminal-correctness track. Capture/replay representative Pi output, then choose either the typed resize request/ack contract or a proven upstream Ghostty fix. Do not add another repaint, resize, or timing branch. Retire legacy periodic repaint recovery only after the accepted fix has equivalent regression coverage.

**acceptance**

- the representative failing trace is reproducible before the fix
- browser dimensions change only at the proven authoritative boundary
- solo and grid modes preserve broker ownership and ordered input/output
- no periodic resize/repaint/delay is introduced as the fix
- the screenshot-class corruption test passes through background output and resize cycles
- legacy recovery hooks are removed only after the regression remains green

### P1 — compress/cache assets and unblock first paint

**evidence**

- `ghostty-web.bundle.js` is about 642KB raw and is parser-blocking in `<head>`.
- `app.bundle.js` is about 247KB raw and cannot run until the Ghostty script completes.
- the four main assets are about 968KB raw / 257KB gzip.
- synthetic FCP was 1.32s at 10 Mbps and 4.47s at 2 Mbps, even though localhost FCP was below 60ms.
- responses have no compression or validators; reloads must transfer static bytes again.

**recommendation**

Stage this to minimize terminal-open regressions:

1. serve Brotli/gzip variants and keep HTML/service-worker responses revalidated.
2. use content-hashed or versioned asset URLs with long-lived immutable caching.
3. preserve script order with `defer` so Ghostty does not block HTML parsing/FCP.
4. after measuring cold terminal open, load Ghostty after the session shell is painted or on terminal intent, while retaining bounded idle prewarm.

Do compression/caching first; it has the best payoff and lowest behavior risk.

**acceptance**

- `br` or `gzip` is negotiated for JS/CSS
- versioned assets return `public, max-age=31536000, immutable`
- HTML can discover a new release without a hard refresh
- initial session-shell FCP p95 is below 1s at the 10 Mbps / 80ms profile
- the non-terminal first paint is not blocked by the 642KB Ghostty body
- warm and cold terminal-open p95 do not regress beyond an agreed budget

### A1 — isolate focus to the active view and use native interactive elements

**evidence**

- `.view` uses off-screen transforms and `pointer-events: none`, but no `hidden`, `inert`, or equivalent focus isolation.
- baseline mobile tab order entered off-screen `new-project-name`, create, session-name, discovery, and settings controls while the sessions view remained visible.
- session and project rows are clickable `<div>` elements without native keyboard focus; only their stop buttons appear in normal tab order.
- `showView()` does not consistently move or restore focus.
- no status/dialog/log live-region semantics are present for connection, loading, errors, or overlays.

**recommendation**

- set inactive view roots `inert` and `aria-hidden`; remove both before animating the destination
- render session/project rows as buttons/links or give an equivalent single, tested interaction contract
- move focus to the destination heading/primary control and restore it when backing out
- treat drawer, conflict, confirmation, and overlay surfaces as real dialogs with focus containment
- expose connection/loading outcomes through `role="status"` or `role="alert"` without announcing terminal output itself

**acceptance**

- Tab never reaches a control outside the visible view/dialog
- every session/project can be opened with Tab plus Enter/Space
- Escape/back restores focus to the invoking control
- focus remains visible at 200% zoom and on 375px layouts
- terminal loading, displacement, failure, and reconnection are announced once, not continuously
- automated tab-order regressions cover sessions → project → agent → terminal → back

### C1 — enforce cli stream and color contracts

**evidence**

- formatting helpers always emit ANSI.
- `NO_COLOR=1 wolfpack list` and piped list output still contain escape bytes.
- list/kill `--json` success writes JSON to stdout, but several error paths use the human `print()` path on stdout.
- human list uses only `triage`, despite richer typed runtime state, and repeats noisy last-line footer text for every session.

**recommendation**

Centralize output policy: color only on an interactive terminal unless explicitly forced, honor `NO_COLOR`, route diagnostics to stderr, and guarantee one machine-readable JSON envelope on stdout for every `--json` result. Use typed runtime state for human status and make terminal previews opt-in (`--verbose`) rather than parsing footer prose.

**acceptance**

- `NO_COLOR=1`, `TERM=dumb`, and non-tty stdout contain no ANSI
- human errors use stderr and nonzero exit codes
- each `--json` path writes exactly one valid JSON object to stdout on success and failure
- human list shows typed states such as needs-input/failed when available
- no semantic state is inferred by regex from `lastLine`
- golden stream tests cover tty/non-tty, color, JSON, auth, network, and validation failures

### A2 — restore magnification and provide a screen-reader path through the terminal

**evidence**

- the viewport declares `maximum-scale=1, user-scalable=no`.
- terminal presets stop at 14px.
- Ghostty output is canvas-rendered and absent from the accessibility tree; the hidden textarea is an input bridge, not a readable transcript.

**recommendation**

Remove zoom suppression unless a verified terminal gesture conflict requires a narrower alternative. Add 16px/18px or a bounded custom terminal size. Add an optional accessible transcript/copy view sourced from the existing terminal/broker snapshot contract, with `role="log"` and live announcements off by default. Do not build a second terminal parser or infer task state from prose.

**acceptance**

- pinch/browser zoom reaches at least 200% without trapping navigation
- 16px and 18px terminal settings remain usable at 375px
- a screen reader can identify the active session, review recent text, reach the input, and hear connection status
- transcript updates use existing authoritative output and remain bounded
- VoiceOver and one desktop screen reader complete open/read/type/back smoke flows

### O1 — make typed attention state the dashboard's primary signal

**evidence**

- the server already returns typed `runtimeState.state`, `unseen`, and transition sequence data and exposes an acknowledgement route.
- the browser renders richer state labels but does not use `unseen` or call the acknowledgement route.
- sessions remain primarily alphabetic/grouped, forcing operators to scan for needs-input or failed agents.
- cli human list falls back to coarse running/idle triage.

**recommendation**

Add a small attention layer, not a new state engine: visible unseen markers, an “attention” filter/count, and needs-input/failed sessions promoted within their machine/delegation context. Acknowledge the exact transition when the user opens or explicitly dismisses it. Reuse the same typed state in CLI output.

**acceptance**

- needs-input and failed sessions are findable in one action
- unseen state persists across refresh and clears only through the typed ack contract
- machine and parent/child context remains visible
- done/stopped/task-completion claims are not inferred from terminal prose
- transitions are covered for stale sources, reconnect, session recreation, and repeated acknowledgement

### O2 — consolidate refresh work and cache session summaries

**evidence**

- browser refresh runs every five seconds.
- each machine refresh requests both `/api/sessions` and `/api/info`; that is 24 requests/minute per machine before overlap.
- the desktop visibility-resume path can start both the sidebar poller and a sessions-view poller.
- healthy remote timeout equals the five-second poll interval.
- `/api/sessions` captures every active pane for triage on every request.
- `/api/info` failure causes a successful sessions result to be discarded because they share `Promise.all`.

**recommendation**

First unify all browser session refresh into one visibility-aware, non-overlapping coordinator. Cache machine info/version much longer than session state and degrade the two endpoints independently. Then move pane-summary/runtime-state maintenance to broker/output events or a server-side bounded cache so list requests do not recapture every pane. SSE/WebSocket invalidation is worthwhile only if the simpler coordinator and cache are insufficient.

**acceptance**

- only one refresh can be in flight per machine
- hide/resume does not create a second interval
- machine info is fetched on discovery/startup and infrequently thereafter
- session data remains visible if only `/api/info` fails
- list request work is O(changed sessions), not O(all panes), between output events
- request and capture counts are instrumented for 1, 10, and 50 sessions across multiple machines

### N1 — separate search, creation, and session switching

**evidence**

- the project field is immediately focused and simultaneously acts as search and new-folder input.
- Enter selects the first filtered project when any match exists; otherwise it creates a project.
- the audited desktop list contained 41 projects in one flat full-height list.
- session switching has Cmd/Ctrl+Arrow and a drawer, but no discoverable searchable switcher.

**recommendation**

Label the default project field as search and make new-project creation an explicit secondary action/form. Rank exact/prefix/recent results without auto-creating from ambiguous Enter behavior. Add a searchable session switcher grouped by attention, machine, and parent; expose the existing shortcuts in help/tooltips.

**acceptance**

- Enter on search cannot accidentally create or select an unintended first substring match
- project creation requires an explicit action and validates the final path/name
- recent/exact projects appear before broad substring matches
- any session is reachable by keyboard with a short query
- switching preserves the current broker/control semantics and grid state

### E1 — replace blocking dialogs and distinguish failure causes

**evidence**

- quick-command editing uses native `prompt()`.
- create/delete/kill/version errors use `alert()`/`confirm()`.
- machine fetch collapses timeout, auth, version, and server errors into “offline”.
- single-machine failure can leave a green header with no explicit error because offline rendering is gated to multi-machine mode.

**recommendation**

Use inline forms and a reusable accessible confirmation/error dialog. Preserve typed input on failure and provide retry. Distinguish unreachable, unauthorized, incompatible, and broker-unavailable states from structured status/error fields; do not regex error messages.

**acceptance**

- no primary workflow depends on browser alert/prompt/confirm
- stop confirmation names the session and machine and restores focus
- failed session creation preserves project, agent, and name inputs
- local and remote failures show a cause category plus retry
- auth/version failures are not mislabeled offline

### S1 — reduce mobile settings traversal

**evidence**

- the baseline settings page is about 1,769px high at 390×844 across machines, effects, terminal, input, agents, quick commands, debug, and about.
- debug/provider management have equal visual weight to frequent terminal/input preferences.

**recommendation**

Keep one route but add compact section navigation and collapse infrequent administration/debug sections. Put terminal/input/effects first; group machines/providers/quick commands under management; keep About/Debug collapsed. Show local save/error feedback near the changed control.

**acceptance**

- terminal font/input settings are reachable within one viewport plus one action
- section state and deep links survive back navigation
- collapsed sections expose error/unready badges
- all controls remain reachable and labeled without horizontal overflow at 375px

### P2 — make terminal prewarm adaptive and enforce budgets

**evidence**

- startup schedules two isolated Ghostty instances with zero delay on every dashboard load.
- this favors grid/terminal latency but may waste memory for list-only and constrained mobile usage.
- the performance harness records FCP, long tasks, prewarm readiness, terminal reveal, hydration, and server phases, but does not enforce budgets or model constrained networks/memory.

**recommendation**

Measure before changing the pool. Compare zero/one/two prewarms across mobile single-terminal, desktop single-terminal, and 2/4/6-cell grid scenarios, including JS/WASM memory and cold-open p95. Then choose a simple policy, likely one mobile/list prewarm and two only where grid use justifies it. Add repeatable p50/p95 budgets to CI or release checks.

**acceptance**

- reports include memory delta, FCP, cold/warm reveal, prewarm hit rate, and long tasks
- profiles include 10 Mbps and 2 Mbps network conditions
- policy reduces unused memory without exceeding the terminal-open budget
- performance checks fail on agreed material regressions rather than only printing summaries

### Q1 — add real engine and accessibility coverage

**evidence**

- all Playwright projects currently run Chromium; iPhone names only emulate viewport/touch/device metrics.
- the recent mobile `beforeinput` regression is precisely the kind of engine/input difference Chromium-only emulation can miss.
- tracked tests have focused behavior coverage, but no broad accessibility scan, inactive-view tab-order contract, or screen-reader smoke matrix.

**recommendation**

Add an explicit WebKit mobile project for navigation, soft keyboard/beforeinput, paste, background/resume, and viewport tests. Keep Chromium for the full suite. Add targeted accessibility assertions for tab isolation, names, statuses, dialogs, touch targets, and contrast; supplement automation with a short physical-device/assistive-tech release checklist.

**acceptance**

- critical mobile terminal/input smoke tests run in Chromium and WebKit
- inactive views are proven absent from tab order
- serious automated accessibility violations block release, with explicit documented exceptions for canvas output until transcript support lands
- a physical iOS PWA smoke test covers type, paste, background, resume, and reconnect before release

### C2 — round out cli discovery and startup ergonomics

**evidence**

- `wolfpack attach` requires a name when multiple sessions exist and only prints a comma-separated error list.
- there are no shell completions or `--version` command.
- bare `wolfpack` prints a large wolf plus QR code every invocation, even after onboarding.

**recommendation**

Add `wolfpack --version`, generated zsh/bash/fish completion, and an interactive fuzzy attach selector only when stdin/stdout are TTYs. Keep explicit names for scripts. Make repeated startup concise with `--qr`, `--open`, and `--quiet` controls or show the large onboarding block only on first setup.

**acceptance**

- session names complete for attach/status/prompt/kill
- no-argument attach provides a keyboard selector only in an interactive terminal
- `--version` is side-effect free
- noninteractive startup is concise and never emits QR/ANSI unexpectedly
- documented flags preserve current automation behavior

## suggested sequence

### now

1. finish and verify `.plans/001-ui-polish.md`.
2. implement compression/cache headers before any deeper frontend restructuring.
3. fix `inert`/focus/card semantics and cli stream contracts with regressions.
4. continue T1 only through the existing terminal investigation and its proof gates.

### next

5. surface typed attention/unseen state.
6. consolidate polling and cache machine/session summaries.
7. separate project search/create and add searchable session switching.
8. add WebKit and accessibility release coverage.

### later

9. add the accessible transcript and settings grouping.
10. tune prewarming only after memory/cold-open measurements.
11. add completion, interactive attach selection, and concise startup options.

## explicit non-recommendations

- no UI framework rewrite
- no broker authority transfer into the browser
- no task-state inference from terminal prose or error-message regex
- no periodic resize, repaint, or arbitrary delay as a terminal corruption fix
- no removal of prewarming before measuring terminal-open and memory tradeoffs
- no second visual-polish effort overlapping `.plans/001-ui-polish.md`
