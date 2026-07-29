# current ux/ui and terminal review

status: complete
reviewed: 2026-07-29
baseline: `.plans/ux-ui-terminal-audit.md`
branch: `feat/ux-ui-terminal-optimizations` at `56ade8d`

## purpose

This is a differential follow-up to the existing audit, not a replacement. It records what the current branch has already addressed, corrects stale recommendations, and prioritizes the remaining work observed in source and the live local PWA.

## current branch gains

The branch already addresses several P0/P1 items from the baseline audit:

- inactive views use `inert`/`aria-hidden`, with focus movement and restoration coverage
- browser zoom suppression is removed and an 18px terminal preset exists
- the terminal has an on-demand, bounded transcript dialog sourced from existing server output
- JS/CSS assets negotiate Brotli, use validators, and versioned URLs receive immutable caching
- Ghostty/app scripts use `defer`
- session refresh is single-flight, visibility-aware, and machine metadata can fail without discarding valid session data
- unreliable semantic attention UI was removed after live source-authority validation

These should not be redesigned again during the remaining pass.

## remaining recommendations

### P0 — make CLI output deterministic

Fresh behavior still violates basic terminal contracts:

- `NO_COLOR=1 bun src/cli/index.ts list` emitted 20 ANSI sequences
- `kill <missing> --json` wrote colored human prose to stdout, emitted no JSON, and left stderr empty
- top-level help has no `--version`

Centralize rendering policy instead of adding command-specific branches:

- color only for interactive output unless explicitly forced; honor `NO_COLOR` and `TERM=dumb`
- diagnostics go to stderr
- every `--json` success and failure emits one stable JSON envelope on stdout
- add side-effect-free `--version`

### P0 — replace blocking browser dialogs

Primary workflows still use native `prompt`, `alert`, and `confirm` in `public/app.ts` and `public/app-grid.ts`, including quick-command editing, session creation errors, stop confirmation, version warnings, and grid limits.

Replace them with one accessible dialog primitive plus inline form/status feedback. Preserve typed input after create/edit failures and restore focus to the invoking control.

### P0 — continue terminal correctness only through the existing source investigation

`.plans/background-tab-rendering.md` has isolated corruption before canvas paint. The app still performs focus/pageshow/visibility repaints plus a 30-second repaint heartbeat in `public/app.ts`.

Do not tune or add repaint timing. Finish representative Pi trace capture, then choose the typed resize request/ack boundary or a proven upstream Ghostty fix. Remove legacy repaint recovery only after the selected source fix has equivalent regression coverage.

### P1 — stop spending a full desktop column on an offline machine

At 1280×720, two configured machines receive equal-width columns even when one is offline and contains no sessions. The offline column consumed roughly half the usable dashboard while the active machine held all five visible sessions. Its green “new session” button also remained enabled.

Use content-aware machine layout:

- active machines receive the primary columns
- offline machines collapse into a compact status row or narrow rail
- disable session creation for unreachable machines and offer retry/details instead
- preserve stable machine ordering when connectivity changes

### P1 — remove dashboard snapshot work that produces low-value preview noise

`GET /api/sessions` calls `capturePaneForTriage()` for every live session on every refresh. The browser and CLI then expose the resulting `lastLine`; live cards showed repeated footer text such as `agents a:0 c:0 f:0 s:0 tasks: 0 inbox`.

The best source-level simplification is:

1. expose the broker’s current output sequence as a typed session fact
2. compare sequence values for generic `output`/`quiet` activity
3. make terminal text preview opt-in or on-demand
4. fetch authoritative snapshots only for terminal attach, transcript/read, or explicit preview

This removes O(all sessions) snapshot materialization from dashboard polling without parsing terminal prose or weakening broker authority. Treat the wire change as cross-module work and preserve protocol compatibility.

### P1 — fix project discovery at realistic scale

The live picker rendered 43 projects in one flat list. The current branch only partially separates search from creation: the visible Create button is explicit, but the same “Project name” input still filters projects and Enter creates when no match exists.

Use separate contracts:

- a search field for existing projects
- a distinct “new project” action/form
- recent and exact/prefix matches before broad results
- a bounded initial result list with the full list available on demand
- Enter in search never creates a directory

### P1 — restructure settings around frequency

At 390×844, the settings list measured 2,006px of internal scroll. The Agents section alone measured 926px; Debug, About, provider administration, and frequent terminal/input controls all share one flat route.

Keep the existing route but add section navigation and progressive disclosure:

- first: terminal, input, effects
- management: machines, agents/providers, quick commands
- collapsed by default: debug and about
- preserve deep-link/back context and show errors on collapsed section headers

### P1 — add actual WebKit coverage

`playwright.config.ts` still defines only Chromium projects; the iPhone projects emulate device metrics but set `defaultBrowserType: "chromium"`. That leaves the recently fixed `beforeinput`, visual viewport, PWA background/resume, and paste paths exposed to engine-specific regressions.

Run a small critical WebKit matrix rather than duplicating the full suite: open session, soft-keyboard input, paste, background/resume, reconnect, transcript, and back navigation.

### P2 — measure before changing terminal prewarm

Every dashboard load schedules two isolated Ghostty instances immediately (`GHOSTTY_PREWARM_POOL_SIZE = 2`, delay `0`) and downloads the 642KB raw / 180KB Brotli Ghostty bundle even if no terminal is opened.

The current branch improved delivery but has only one recorded performance-harness run and no memory measurement. Compare zero/one/two prewarms across mobile solo, desktop solo, and grid scenarios. Change policy only if memory and cold-open p95 support it; a likely outcome is one default prewarm and a second only for grid intent.

### P2 — finish PWA install and notification ergonomics

The manifest contains only an SVG `purpose: any` icon and no shortcuts/screenshots. The service worker is notification-only; generated session notifications do not include a session URL, so tapping one can only return to `/`.

Add maskable 192/512 assets and session-aware notification routing. Prefer a typed app route or service-worker message to string parsing. Offline terminal operation is not a valid goal, but a clear disconnected shell is.

### P2 — reduce the UI architecture tax incrementally

`public/app.ts` is 5,530 lines and owns API calls, view routing, session lists, terminal lifecycle, quick commands, settings, dialogs, machine discovery, sidebar state, and input behavior. `public/styles.css` is 2,455 lines. This mixed ownership makes every UX change more regression-prone.

Do not introduce a framework rewrite. Extract only cohesive production modules while touching related behavior: dialogs, project picker, settings, and session-list rendering first; keep terminal controller and broker protocol changes isolated behind their current contracts.

## recommended sequence

1. CLI stream/color/JSON contracts.
2. Browser dialog/error replacement.
3. Offline-machine layout and explicit failure categories.
4. Project picker separation and settings navigation.
5. Replace per-refresh snapshots with typed output sequence facts.
6. Add WebKit critical-path coverage.
7. Continue terminal corruption work only after its trace/decision gates.
8. Profile adaptive prewarm, then improve PWA metadata/deep links.

## evidence collected

- architecture: `edc-context/index.md`, manifest, and both routed module docs
- branch diff: 28 files changed from `main`, 1,412 insertions / 237 deletions
- live PWA: `127.0.0.1:18790`, desktop 1280×720 and mobile 390×844
- live picker: 43 project actions in one flat list
- mobile settings: 2,006px list scroll; Agents section 926px
- static delivery: Brotli + immutable caching confirmed for versioned CSS/Ghostty/app assets
- static size: Ghostty 642,448 bytes raw / 180,464 bytes Brotli response
- local `/api/sessions`, five sessions: 1.33ms median across 10 warm requests, 115.86ms max; current concern is avoidable O(N) work and remote/scale behavior, not proven local median latency
- no physical iOS/Android, assistive-technology, memory-pressure, or real Tailscale latency run was performed
