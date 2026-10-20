# ui redesign: attention-first dashboard, apple-style skin

status: fix-1 finished on `ui/apple-reskin`; verified production head `03f8f39b`, starting at `04bd999b`. H1–H5, M1–M6, L1–L10 and visible failed-row Close accounted for below, including explicit partial declines. final full suites remain non-green with baseline-reproduced failures. no push; phase 2 excluded.

fix-1 baseline reconciliation: reviewer logs `10-playwright-head.log`, `12-playwright-base-failing-specs.log`, and `13-playwright-head-regressions-rerun.log` inspected under `/tmp/wolfpack-reskin-review/logs/`. six pre-existing failures: iphone-14 session-switch:253; desktop session-switch:656 and ui-polish:19/:35/:71/:106. six branch regressions: iphone-14 accessibility-navigation:39/:52, delegation-sessions:562 on desktop + iphone-14, iphone-14 ux-navigation:1177 and impeccable-refinement:165. baseline Bun inbox failure also reproduced by reviewer. full Chromium final gate may expose additional failures; isolate those on base before assigning ownership. fix logs: `/tmp/wolfpack-reskin-logs/fix-1/`. commit boundary: logical fix commits and final handoff, no push/PR/merge. independent reviewer remains coordinator-owned; no child sessions launched.

- base: `909d5150c4d004135751da375b880d814543ba69` (main, 2026-10-20)
- spec: `mockups/*.html` next to this file (open in a browser; they are the design source of truth — read the css, do not eyeball pngs). `06-system-tokens.html` is the token/status reference.
- allowed: edit `public/styles.css`, `public/index.html`, `public/app.ts`, `public/app-action-controller.ts`, `public/app-state.ts`, `src/agent-runtime-ui.ts`, `src/server/session-observation.ts`, tests. new files under `public/` and `tests/` only.
- not allowed: broker (`broker/`), wire protocol, `src/server/websocket.ts`, auth, task relay, extension sdk, install/release scripts. no new dependencies. no webfont files committed (SF is not licensable; use the `-apple-system` stack with a Google Fonts `<link>` fallback only if already permitted by CSP — otherwise `system-ui`).
- edc routing: `public/` → wolfpack.md "generated artifacts and verification" (browser edits require asset generation). phase 2 touches `src/server/session-observation.ts` + `agent-status` → wolfpack.md "status, activity, attention, and notifications". do not cross into broker.md.
- verification gate (final revision): `bun run build` (asset generation), `bun test`, playwright suite for dashboard + mobile, manual check at 390px and 1440px. save full output to a private artifact; report exit codes.

## design decisions (fixed — do not relitigate)

1. **triage over machines.** the dashboard's primary grouping is attention tier; machine is secondary. sessions with `needs-input` are pinned in a cross-machine "Needs you" group above the per-machine groups.
2. **12 runtime states → 4 tiers.** mapping lives in one place (`src/agent-runtime-ui.ts`):
   - `needs-input` → **need** (amber `#f6c35c`, dot with 3px 20% halo)
   - `running | working | audit | cleanup | output` → **work** (green `#45ed7e`)
   - `idle | done | stopped | off | unknown` → **idle** (grey `#8a9b91`, dot `#58685e`); label keeps the specific word (Idle / Done / Stopped)
   - `failed` → **fail** (red `#ff8a80`)
3. **card body = last agent line**, not the status-line blob. `session.lastLine` already exists (`session-observation.ts:566`, `lastTerminalPreviewLine`). phase 2 makes it skip status/footer lines so it returns the last *agent* line (the prompt it's waiting on, or last sentence).
4. **meta row is labeled fields**: `model · reasoning` · `ctx NN%` · `$cost` · git delta. parsed from the harness status line once, server-side, into a `meta` object. ctx ≥85% renders amber.
5. **quick reply on needs-input cards**: `y` / `n` / `esc` / free-text, posting to the existing `POST /api/session-control/send`. gated: buttons disabled unless runtime `freshness === "fresh"` and state === `needs-input`.
6. palette unchanged. surfaces move from solid green-tinted panels to white-alpha layers (`rgba(255,255,255,.045)` fill, `.07` hairline). type: `-apple-system, "SF Pro Text", system-ui` for ui; mono (`ui-monospace, "SF Mono", Menlo`) only for agent text, paths, numbers.

## phase 1 — re-skin (markup + css only, no behavior)

goal: dashboard, sidebar, terminal chrome, and mobile match `01`, `02`, `03`, `05` visually using existing data. no new state, no new routes.

### 1a. tokens — `public/styles.css` `:root` (lines 1–58)

replace/add; keep old names as aliases until phase 1 lands fully, then delete unused.

```
--bg-base:#0b0e0c; --bg-terminal:#090c0a;
--surface-1:rgba(255,255,255,.028);   /* sidebar, inspector */
--surface-2:rgba(255,255,255,.045);   /* grouped list container */
--surface-3:rgba(255,255,255,.08);    /* controls, fields */
--hairline:rgba(255,255,255,.07);
--hairline-strong:rgba(255,255,255,.12);
--gloss:inset 0 1px 0 rgba(255,255,255,.06);
--glass-bg:rgba(13,17,15,.78); --glass-filter:blur(24px) saturate(180%);
--accent:#45ed7e; --accent-tint:rgba(69,237,126,.14); --accent-on:#06130a;
--attn:#f6c35c;  --attn-tint:rgba(246,195,92,.14); --attn-fill:rgba(246,195,92,.055); --attn-line:rgba(246,195,92,.18);
--danger:#ff8a80; --danger-tint:rgba(255,138,128,.14);
--info:#7fc8ff;
--text-1:#f2f6f3; --text-2:#b8c6be; --text-3:#9fb0a6; --text-4:#7f9087; --text-5:#58685e;
--font-ui:-apple-system,"SF Pro Text","SF Pro Display",system-ui,sans-serif;
--font-mono:ui-monospace,"SF Mono",Menlo,Monaco,Consolas,monospace;
--r-control:9px; --r-card:12px; --r-group:14px; --r-sheet:26px;
```

contrast note: `--text-4` on `--bg-base` is ~5.1:1; do not go darker for text. `--text-5` is for chevrons/dividers only.

### 1b. dashboard header — `public/index.html` `<header>` + `#expanded-toolbar`

- desktop header: 52px, `.glass` (bg + backdrop-filter), hairline bottom. left: 26px app-icon tile + "Wolfpack" (sans 14/600, **not** mono uppercase). center: 440px search field (`--surface-3`, radius 9, ⌘K kbd). right: "● 2 machines online" + icon segmented control (bell, settings).
- page title block above the list: `<h1>Sessions</h1>` 28/700/-.025em + subline "10 across 2 machines · **2 need you**" (amber). lives in `#session-dashboard-controls`.
- mobile (≤768): large title 34/700 at top (56px top inset), search + new-session as 36px circles, segmented control under it. see `03`.

### 1c. triage segmented control — replaces `.session-card-view-filter` (`app.ts:1595–1612`, `app-action-controller.ts` `SESSION_CARD_VIEW`)

- extend `SESSION_CARD_VIEW` to `{ NEED:"need", WORK:"work", IDLE:"idle", FAIL:"fail", ALL:"all" }`. default stays `ALL`. keep `isSessionCardView`.
- `sessionCardRows()` (`app.ts:1622`) filters by tier via a new `sessionTier(session)` helper in `src/agent-runtime-ui.ts` (decision 2). `ALL` = no filter.
- markup: `<div class="seg" role="tablist">` with 4 `<button role="tab" aria-selected>` each containing label + `<span class="n [a|g|r]">count</span>`. counts come from `state.lastSessionGroups` (count all sessions across online groups per tier). "All" is reachable by clicking the selected segment again (toggle off) — simpler than a 5th segment.
- css: `.seg` 3px padding, `--surface-3` bg, radius 10; selected button `rgba(255,255,255,.12)` + `0 1px 3px rgba(0,0,0,.4)`. count capsules: `.n.a` amber fill/dark text, `.n.g` green, `.n.r` red, default grey.

### 1d. grouped list container + row — replaces `.card` block (`styles.css:302–660`, markup `app.ts:1898–1912`)

keep every `data-*` attribute, `card-open` button, `kill-btn`, session-order attrs, delegation classes — only restyle and reflow. the row is:

```
<div class="card tier-{need|work|idle|fail} ..."  (existing attrs)>
  <button class="card-open" ...></button>
  <span class="app-icon harness-{pi|claude|codex|gemini|cursor|shell}" aria-hidden="true">π</span>
  <div class="card-info">
    <div class="card-name">name  [machine chip — only when rendered inside the pinned group]</div>
    <div class="card-preview">lastLine</div>
    <div class="card-meta">… activityHtml(s) …</div>
  </div>
  [tier==need: <div class="card-reply"> y n esc [input] Open </div>]   ← phase 2; render nothing in phase 1
  [tier==fail: Restart / Log buttons]                                   ← phase 1: restyle existing kill-btn as "Close", add nothing new
  <span class="status st-{tier}"><i></i>{label} {elapsed}</span>
  <svg class="chev">…</svg>
  <button class="kill-btn" …>  (move visually to hover-reveal on desktop; keep in DOM)
</div>
```

- `.machine-group-body` becomes the grouped container: `--surface-2` fill, 1px `--hairline` border, radius `--r-group`, `--gloss`, `overflow:hidden`. rows have no own border/radius; `.card + .card { border-top:1px solid var(--hairline) }`. drop `border-left: 3px` tier stripes (`styles.css:408`), drop `--bg-surface-gradient`.
- `.app-icon`: 30px (34 mobile), radius 8, vertical gradient per harness, `inset 0 1px 0 rgba(255,255,255,.12), 0 1px 2px rgba(0,0,0,.35)`. gradients: pi `#7a4fa8→#5c3a85`, claude `#d9825a→#b4603e`, codex `#3fb39d→#2b8a78`, gemini `#4f8ae6→#355fb3`, cursor `#5a6b61→#3a4740`, shell `#b8962e→#8a6f1f`. replace `harnessIconHtml()` output class, keep the `data-harness` attr.
- `.status`: dot 8px + text 12/500, tier color. `.st-need i` gets `box-shadow:0 0 0 3px rgba(246,195,92,.2)` and the existing pulse keyframe (respect `prefers-reduced-motion`).
- `.card-name` 14/600/-.01em `--text-1`; `.card-preview` 12.5 `--text-3`, mono if tier is need (it is a prompt) else sans; `.card-meta` 11.5 `--text-4`, values `--text-2` 500.
- failed row: `background:rgba(255,138,128,.05)`, preview in `--danger`.
- `.machine-header`: 11/600 uppercase .06em `--text-4` with 7px green/grey dot, "N sessions" in `--text-5`, `+` plain button right. no background.
- desktop dashboard: two machine columns `grid-template-columns:repeat(2,minmax(0,1fr)); gap:24px`, content max-width 1296 centered. (today: already 2 columns; keep responsive collapse at ≤1100.)
- hover (desktop, `@media (hover:hover)`): row `background:rgba(255,255,255,.04)`; active `.06`. kill-btn opacity 0 → 1 on row hover/focus-within.

### 1e. desktop sidebar + terminal chrome (`#desktop-sidebar`, terminal header; see `02`)

- sidebar 250px `--surface-1`, hairline right. header row: icon tile + "Wolfpack" + dashboard/new icons. filter field below. section headers "Needs you" (amber) / machine names. rows `.src`: 22px app icon, name 13/500, lastLine 11 `--text-4`, status dot right. selected row: `background:var(--accent-tint); box-shadow:inset 0 0 0 1px rgba(69,237,126,.18)`; radius 8.
- terminal header: 52px glass; app icon 26 + name 14/600 + mono path 11 `--text-4` under it; status; right: segmented control [Inspect | Restart | Stop(red text)] + segmented icon group [split | fullscreen | inspector toggle]. existing buttons re-homed, no new actions.
- terminal footer status line: 30px, `rgba(255,255,255,.02)`, hairline top, mono 11 `--text-4`; "● live" in accent right.
- context dock (`#workspace-context-region`): 360px `--surface-1`, hairline left, tab bar as full-width segmented control (Changes N | Plan | Tasks N), git section header mono, file list in a grouped container, diff in `--bg-terminal` container with `+`/`-` line tints at 8%. primary "Mark Reviewed" + grey "Open in Editor" footer.
- needs-input banner above the terminal (`05`/`02`): radius 12, `--attn-fill` bg, `--attn-line` border, backdrop blur, mono amber prompt, y/n/esc amber-tint buttons, primary "Reply in terminal". phase 1: render only when `sessionRuntimeState === needs-input`; buttons focus the terminal and send the key through the existing terminal input path (not the HTTP route) — this is already how the mobile key bar works.

### 1f. mobile (`03`, `05`)

- tab bar 84px incl. 20px safe-area, glass, hairline top, 4 tabs (Sessions / Changes / Machines / Settings) 24px stroke icons + 10/500 labels; active in accent. "Changes" and "Machines" route to the existing context region and Settings→Machines section; no new views.
- key bar (`public/app-touch.ts` + styles): two rows of 42px keys, radius 9, `--surface-3`, `0 1px 0 rgba(0,0,0,.5)`. **row 1 order: `y` `n` `↵` `esc` `tab` `ctrl` `⇧⇥` `^C`**; row 2: arrows, `git`, `paste`, keyboard toggle (accent fill) right. y/n/↵ use `--attn-tint`/amber. this is a reorder of existing keys + 3 new literal keys (`y`, `n`, `↵` already exists as enter).
- terminal header on mobile: back chevron + "Sessions" in accent (iOS nav style), centered session-switcher button (icon + name + dot + chevron), subline "workstation · 2 of 10", right: changes icon with blue count badge + more (…).

### 1g. phase 1 acceptance

- screenshot parity with `01`/`02`/`03`/`05` at 1440 and 390 (tolerate copy differences; structure, spacing, color must match).
- no change to session order persistence, delegation toggles, drag/dock, kill flow, keyboard selection (`.card.keyboard-selected` restyled as a 2px accent ring).
- axe/contrast: every text ≥4.5:1 on its surface.
- `bun run build` + existing playwright dashboard/mobile specs green; update selectors only where class names changed (list the renames in the pr).

## phase 2 — behavior

### 2a. tier helper + attention sort — `src/agent-runtime-ui.ts`, `app.ts` `sessionOrderRows`

- `sessionTier(session): "need"|"work"|"idle"|"fail"` per decision 2. unit test every `AGENT_STATUS_STATE` value.
- sort key, applied *within* a machine group before user manual order: need (oldest-waiting first) → fail → work (most recent output first) → idle (most recent first). manual drag order remains the tiebreak within a tier. if this conflicts with `session-order.ts` persistence semantics, keep tier ordering and persist only intra-tier order; document in pr.

### 2b. pinned "Needs you" group — `app.ts` `renderSessionListFromState` (~1701)

- before machine groups, render one synthetic group `machine-group needs-you` containing every `tier==need` session across all online machines, each row carrying its machine chip and `data-machine`. the same session still appears in its machine group (rendered dimmer, `opacity:.6`) so machine counts stay true; clicking either opens the same session.
- the pinned group is not drag-orderable; `sessionOrderCardHtml` returns no ordering attrs for it. hidden when empty.
- mobile: identical, above machine groups.

### 2c. last agent line + structured meta — `src/server/session-observation.ts` `lastTerminalPreviewLine`

- currently returns the last non-empty rendered line, which for pi/codex is the status footer (`↑80k ↓7.2k …`). change: walk upward from the bottom; skip lines matching a per-harness footer regex (`^[↑↓]\d`, `^~\/.*\(.*\)$`, `^[-─]{8,}`, box-drawing-only, cursor-only); return the first remaining line, trimmed to 160 chars. keep old behavior as fallback when nothing qualifies.
- add `meta` to `ObservedSessionSummary`: `{ model?, reasoning?, contextPct?, contextLimit?, cost?, costTag? }` parsed from the skipped footer line (pi: `CH(\d+\.?\d*)%`, `\$(\d+\.\d+)`, `(\d+\.?\d*)%\/(\d+)k`, `\(([\w-]+)\)\s+([\w.-]+)\s+•\s+(\w+)$`; claude/codex: whatever their footers expose — if nothing, leave undefined). fixture tests from real captures in `tests/` (grab 3 footers from the gif frames in `docs/assets` or a live session). git delta already comes from `project-git-status`; join it client-side.
- client: `activityHtml(s)` renders `meta` as the labeled row; falls back to the raw footer text when `meta` is undefined.
- this touches the agent-status module: no change to runtime state reduction, only the preview/summary projection. "output is not semantic activity" invariant untouched.

### 2d. quick reply — dashboard card + mobile sheet (`04`)

- card `.card-reply` (tier need only): buttons `y`, `n`, `esc`, text input, "Open". post `POST /api/session-control/send` with `{ session, machine, text, noEnter }`: `y`/`n` send the char + enter; `esc` sends `\x1b` with `noEnter:true`; free text sends as typed + enter. use the existing client helper if one exists for session-control (check `public/delegation-sessions.ts`); otherwise add one small fetch wrapper with `fetch-timeout.ts`.
- gating: disabled unless `runtime.state === needs-input && runtime.freshness === "fresh"`; after a send, disable for 1.5s (`SESSION_SEND_DEFAULT_OBSERVE_MS`) and let the next observation re-enable. show the send outcome inline (`SESSION_SEND_OUTCOME`) — failure reason text, not a toast.
- mobile: tapping a needs-you card opens a bottom sheet (`04`): grabber, session header, "Last output" box (last ~8 lines from the snapshot route the inspector already uses, read-only), prompt line, 4 big keys, text field + send, "Open Terminal" + "Snooze 10m". snooze is client-only (hides the card from the pinned group for 10 min, stays in machine group). sheet is a `<dialog>` like `#session-inspector-dialog`.
- security: same global api auth as every other control route; no new authz. do not add a websocket path for this.

### 2e. failed row actions

- `Restart` → existing create-session flow pre-filled with the same project/harness/name (there is no restart primitive; do not invent one in the broker). `Log` → opens the inspector snapshot for the dead UUID (retained dead-by-id inspection exists per edc index). `Close` → existing kill.

### 2f. phase 2 acceptance

- unit: tier mapping (12 states), sort order, footer-skip + meta parse fixtures (≥3 harnesses), send gating state machine.
- playwright (mock backend, `src/server/mock-backend.ts`): needs-input session appears pinned and in its machine group; `y` posts to send route with correct body; buttons disabled when stale; snooze hides and restores.
- real-broker integration (local, not ci-required): one pi session hitting a y/n prompt; quick reply resolves it; `lastLine` shows the prompt, not the footer.
- no change to attach/resize/watermark paths. if any diff touches `websocket.ts`, `pty-*`, or `broker/`, stop and report.

## sequencing / handoff

1. phase 1 on branch `ui/apple-reskin`, one pr. pure styling; safe to merge independently.
2. phase 2a+2b on `ui/triage-pinned` (client only). 2c on `ui/last-line-meta` (server + fixtures) — these two are independent of each other. 2d depends on 2a–2c. 2e last.
3. each pr: list renamed css classes, updated playwright selectors, screenshot pair (before/after) at 1440 and 390, command log with exit codes per CONTRIBUTING.

## open questions (decide, don't block)

- keep "All" as an explicit 5th segment or toggle-off? plan says toggle-off; if playwright/a11y prefers an explicit tab, add it.
- machine groups as 2 columns vs. 1 stacked column of grouped lists on desktop when >2 machines: plan says `repeat(auto-fit, minmax(560px, 1fr))`.

## initial implementer handoff — phase 1 (historical; superseded by fix-1 below)

- base: `909d5150c4d004135751da375b880d814543ba69`; implementation: `87a6b75c` (`ui/apple-reskin`). existing checkout changes were discarded only after explicit user authorization. no push, PR, merge, dependency installation, or live-service change.
- scope clarification: user authorized continuing after the missing native inspector actions/build script were reported. existing extension composition is preserved; unavailable Restart / Mark Reviewed / Open in Editor actions were not invented. browser assets are built with the repository's documented generation command.
- changed production files: `public/styles.css` (tokens, grouped rows, responsive chrome), `public/index.html` (headers, search, banner, mobile navigation/accessory), `public/app.ts` (tier filtering/counts and existing-action wiring), `public/app-action-controller.ts` (closed tier-view domain), `src/agent-runtime-ui.ts` (authority-preserving tier mapping), generated `src/public-assets.ts`.
- tests: new `tests/unit/session-tier.test.ts`, `tests/e2e/apple-reskin.e2e.ts`; updated session-card-view, mobile-accessory-enter, idle-session-view, visual-makeover, machine-groups, session-state-visualization, and desktop-workspace-tools tests. actual key bytes, tier mappings, search/navigation, preserved widgets, and mobile scrolling checked.
- classes/selectors: dashboard `.triage-badge` → `.status.st-{need,work,idle,fail}`, dashboard `.dot` → `.status i`; sidebar keeps its existing badge/dot classes. `.session-card-view-filter` retains its class and gains `.seg`; role `group` → `tablist`, buttons → `tab`, `aria-pressed` → `aria-selected`. `.src` and `.tier-*` added. `.harness-icon` deliberately retained for existing consumers. selector updates are in the five dashboard/workspace specs above; layout/color assertions now reflect grouped rows and the new tokens.
- decisions: All uses selected-tab toggle-off; native system font fallback, no external fonts; two desktop machine columns wrapping to one at ≤1100px; existing stored/resizable workspace widths preserved. ctrl is a native disclosure of supported control keys (not a new modifier state). copy remains alongside paste. Changes is disabled without an active terminal. search uses input values rather than new application state.

### verification

commands ran in `/home/almog/dev/wolfpack` against the source committed as `87a6b75c`; full logs are private under `/tmp/wolfpack-reskin-logs/`.

| check | exit / outcome | full log |
|---|---|---|
| `bun run build` | 1 — no declared build script | `19-requested-build.log` |
| `bun run scripts/gen-assets.ts` | 0 | `27-assets.log` |
| `bun run typecheck` | 0 | `33-final-types.log` |
| `bun test` | 1 — 3599 pass, 8 skip, 1 fail, 322.89s | `32-final-bun.log` |
| baseline inbox test, isolated archive of base + same dependencies | 1 — same bounded-inbox JSON truncation failure; 150 pass, 1 fail | `25-baseline-inbox.log` (archive path: `baseline-path`) |
| dashboard/mobile/axe/machine/runtime Playwright specs, desktop + iphone-14 Chromium | 0 — 76 pass, 20 project-specific skips, 85s | `34-browser-final.log` |
| desktop workspace spec | initial 7 pass + outdated selector failure; corrected case exit 0 | `35-workspace.log`, `36-workspace-selector.log` |
| tier/domain unit tests | 0 — 14 pass | `31-focused-unit.log` |
| mobile WebKit | 1 — browser cannot launch: missing host libraries | `22-final-browser.log` |
| design detector | 2 — warnings, including legacy overridden stripes, pinned 10px tab labels, static contrast heuristic | `26-design-scan.log` |
| `git diff --check` | 0 | terminal command outcome |

- mobile scrolling regression was reproduced, baseline-checked, and fixed at the CSS source: preserve header geometry during overlapping swipe transitions. no transport/hydration changes. all three scrolling cases pass. search-empty keyboard navigation also has observed red/green coverage.
- screenshots: `.plans/screenshots/dashboard-1440.png`, `dashboard-390.png`, `terminal-1440.png`, `terminal-390.png` (1440×900 / 390×900 Chromium; mobile device scale 3). compared with mockup CSS 01/02/03/05. screenshots use controlled session/peer fixtures, not live agent/device evidence.

### remaining risks / deviations

- exact screenshot parity is **not claimed**: no pinned attention group, parsed metadata, dashboard replies, or failed Restart/Log actions (phase 2); no built-in Changes/Plan/Tasks content or review/editor actions (extension-owned). existing workspace widths and grid/stop controls are retained rather than forced to the mockup's 250/360px dimensions. mobile header retains the existing machine-label structure; failed rows retain the existing Stop control rather than adding a distinct Close action.
- axe checks passed on covered fixture views; this is not proof of every dynamic extension, reconnect/error state, or physical-device contrast/layout. WebKit and physical iPhone behavior remain unverified. the full Bun suite is not green because the same inbox test fails on the untouched base; no unrelated CLI fix attempted.
- unrelated/untracked `edc-context/reports/` left untouched. private logs are not committed. plan, supplied mockups, and screenshots are committed separately from production. stop here; phase 2 remains out of scope.
- `output` state currently maps to work-tier; if users want an "unread" signal, add a small accent dot on the name for `output` with `freshness fresh` — not in scope.

## fix-1 handoff — independent review remediation

- base `909d5150c4d004135751da375b880d814543ba69`; review target/start `04bd999b`; final production `03f8f39b` on `ui/apple-reskin`.
- commits: `dcbc5305` review fixes/regressions; `a9f5a049` full-suite navigation/reorder compatibility; `03f8f39b` sidebar parent hit-target correction. final handoff/screenshots are documentation-only. no push, PR, merge, new dependencies, or phase 2.
- this round changes only `public/{app.ts,index.html,styles.css}`, generated `src/public-assets.ts`, tests, and this handoff/screenshots. protected-scope diff is empty (`38-protected-scope.diff`). no broker, websocket, PTY, auth, relay, SDK, observation, or workspace implementation edits.
- no delegated sessions/tasks were created. independent reviewer lifecycle remains coordinator-owned. all complete logs, traces, failure screenshots and baseline comparisons: `/tmp/wolfpack-reskin-logs/fix-1/`.

### findings and decisions

| finding | disposition and verification |
|---|---|
| H1 | fixed: single- and multi-machine load/poll use `renderSessionListFromState`, updating controls, summaries and online counts. `reskin-review` asserts initial values before any filter click and changed values after a refresh. |
| H2 | fixed at the same render source: dashboard search is reapplied after replacement. regression preserves the query and checks visible rows after a runtime change. |
| H3 | restored mobile header visibility while retaining its layout space through swipes. original gear focus-return specs and scrolling specs pass. mobile Settings navigation is a native link to the existing destination, avoiding duplicate button-role matches; separate keyboard-return coverage passes. |
| H4 | restored grouped child indentation/compact sizing and sidebar status rows; the unchanged delegation geometry assertions pass. restoring the original sidebar name-row height also keeps the parent Open hit target clear of the delegation toggle. |
| H5 | restored solid `--bg-surface`, `--bg-elevated`, and original `--text-primary` for legacy dialogs/settings; new phase-1 surfaces consume the new tokens explicitly. reason: prevent incidental translucent stacking outside the requested surfaces. original stop-dialog/debug expectations pass without weakening their contrast helper. |
| M1 | fixed accessory overflow and focus guards on ctrl summary/paste. regression checks hit testing, retained terminal focus and the actual control-key byte. no new modifier state. |
| M2 | single-terminal chrome/footer hidden in manual and delegation grids; Inspect/Stop handlers also guard their context. both grid modes covered. |
| M3 | existing mobile context restore affordance is now named Changes and remains reachable in the terminal header. test opens its existing region. dashboard Changes remains disabled without a terminal; no new route/view invented. |
| M4 | restored semantic info-blue via `--info` (`rgb(127, 200, 255)`), including the existing activity assertion. reason: the mockups specify this signal, not muted grey or the previous palette's blue. |
| M5 | sidebar filter is a bounded two-column grid with nowrap labels/counts, not a squeezed four-column row. width/height and no-overflow checks restored; inspected 1440px capture. |
| M6 | screenshots use `testInfo.outputPath()`; regression asserts the artifact exists there. tests left tracked screenshots unchanged. final images were copied manually from the verified artifacts after testing, not written by a spec. |
| L1 | active preview text fixed to `--text-2`, covered by computed-color assertion. partial decline: preserve specified Gemini/shell gradient glyphs. they are labelled `role=img`, meet 3:1 non-text contrast (3.44/3.93 minimum), and are not prose; blanket 4.5:1 glyph parity is not claimed. |
| L2 | restored visible and accessible `← Back`; it truthfully handles projects/settings/terminal return destinations. matching label and keyboard focus-return test added. |
| L3 | singular/plural machine and session counts fixed; initial one-machine summary asserted. |
| L4 | group of native toggle buttons with `aria-pressed`, count descriptions and toggle-off instructions replaces the incomplete tablist. All remains toggle-off. keyboard, count-description and synchronized-control tests pass. |
| L5 | shared status content supplies dot, tier color and tooltip in dashboard/chrome; terminal Working dot/color/label are asserted. |
| L6 | dashboard status preserves the source runtime tooltip; exact tooltip asserted. |
| L7 | app-local wrapper supplies the shell tile for unknown/custom harnesses without changing the shared harness module. fallback accessibility asserted. name remains first in sidebar DOM for the existing reorder announcement contract; CSS orders the tile visually first. |
| L8 | removed unused sheet radius, overridden session stripe/pill rules and duplicate mobile declarations; uses card radius, info and danger-tint tokens. partial decline: retain aliases still consumed by legacy surfaces and the generic card stripe used outside session rows; deleting/restyling those would exceed phase 1. |
| L9 | restored visible-logo, 2px focus outline, bounded sidebar size and no-overflow assertions. All clearing now targets the actually pressed button; delayed-ack test explicitly selects the expected surface's status element. old dashboard left-edge alignment assertion deliberately not restored: mockup 01 places filters right of the title; screenshot inspection covers that layout. |
| L10 | sentence-case dashboard/chrome labels replace CSS title casing. elapsed time remains deferred, not fabricated from absent phase-1 data. |
| failed-row Close | visible, danger-tinted Close label in dashboard/sidebar, retaining the existing kill confirmation. regression checks no-hover visibility, confirmation and cancel focus restoration. |

### regression evidence and expectation changes

- `01-red.log` observed failures before fixes for H1/H2/H3/M1/M2/M3/M6. reviewer baseline probes additionally established H3/H4/H5 as branch regressions before remediation. `03-counters-search.log`, `08-focused.log` (31 pass), `09-extra.log`, `17-corrections.log`, `18-corrections.log` and `20-widget-expectations.log` preserve subsequent outcomes, including intermediate failures.
- final `reskin-review.e2e.ts`: 16 pass, 11 intentional project skips. original accessibility/delegation/mobile-scrolling/dialog/debug cases also pass in the full gate.
- full-suite discoveries were not hidden: `12-full-chromium-head.log` exposed duplicate Settings button matches, fallback-tile reorder naming and stale context-control assertions. tests now expect mobile header Changes and the specified borderless, raised, translucent selected context segment; selection, draft retention, terminal identity and persistence assertions remain intact.
- `23-full-chromium-final.log` exposed the sidebar parent Open hit-target regression. `25-parent-hit-target-red.log` reproduced it in isolation; `27-parent-hit-target-green.log` passes the same real-broker test plus reorder/manual-grid/delegation-grid checks. final full run also passes it. no native transport code changed.

### final verification and baseline reconciliation

commands ran in `/home/almog/dev/wolfpack` against `03f8f39b`; only handoff/images were dirty. all browser runs used `WOLFPACK_BROKER_BIN=/home/almog/dev/wolfpack/broker/target/release/wolfpack-broker`, existing dependencies, Chromium projects `desktop`, `iphone-14`, `iphone-se`, zero retries. baseline archive `/tmp/wp-reskin-fix-base.EGXjvp` is exact `909d5150` plus generated assets and a shared dependency symlink; path recorded in `base-path`. no baseline production edits.

| check | actual result | private log |
|---|---|---|
| `bun run scripts/gen-assets.ts` | exit 0; generated source current | `29-final-assets.log` |
| `bun run typecheck` | exit 0 | `30-final-typecheck.log` |
| `bun test` final | exit 1; 3599 pass, 8 skip, 1 fail; 329.06s | `33-verified-bun-test.log`, `33-result.txt` |
| baseline `bun test` (archive caveat below) | exit 1; 3583 pass, 8 skip, 4 fail; 329.72s | `32-base-bun-test.log`, `32-result.txt` |
| full Chromium final, all 55 specs / 1236 cases | exit 1; 762 pass, 442 skip, 32 fail; 20.7 min (1252s including generation/typecheck) | `31-full-chromium-verified.log`, `31-result.txt`; artifacts `playwright-verified/` |
| full Chromium base, 1206 cases | exit 1; 747 pass, 430 skip, 29 fail; 1247s | `15-full-chromium-base.log`, `15-result.txt`; artifacts `playwright-base/` |
| three variable browser failures, baseline/head repeated probes | base exit 1: 13 pass / 3 skip / 2 fail; head exit 1: 14 pass / 3 skip / 1 fail | `34-base-flake-probe.log`, `35-head-flake-probe.log` |
| baseline passive-inspection spec, 10 repetitions | exit 1; 32 pass, 10 skip, 8 fail; 1.5 min | `36-base-inspection-race.log` |
| `git diff --check`; protected scope | exit 0; protected diff empty | `38-protected-scope.diff`, final git evidence |

- final Chromium failures: the same 29 failing cases as base, plus three intermittent failures independently reproduced on base. installed-widget manager: transient settings x=-31; worker-readiness cleanup: session still present (browser-independent test); passive inspection: controller columns change 122→81 before the compared snapshot. baseline passive probe fails the exact same geometry assertion; base rows 47 versus head 42 reflect the deliberate terminal chrome height, not the failing column transition. full failure lists/comparisons are `verified-baseline-comparison.json` and `baseline-failure-signatures.json`. no unexplained branch-only failure remains in these checks; this is not a claim that the repository suite is green.
- final Bun failure is the same bounded-inbox JSON truncation reproduced on base. intermediate full run `24-final-bun-test.log` was exit 0 (3600 pass / 8 skip), so this is intermittent; that passing run does not replace the final failing result. baseline archive full run also hit two git-metadata checks (archive has no `.git`) and a server-shutdown timing test; do not present those archive failures as production regressions or infer a clean full baseline. reviewer `logs/05-base-inbox.log` independently reproduced the inbox failure in a proper detached worktree (150 pass / 1 fail).
- skip counts include project-specific/native-environment guards; full logs retain their names. no retries concealed failures. build script remains absent; authorized asset-generation substitute used. no WebKit host libraries installed; WebKit/physical iPhone remain unverified.
- inspected the final 1440×900 and 390×900 captures and copied them manually into `.plans/screenshots/{dashboard,terminal}-{1440,390}.png`. these remain controlled-fixture evidence, not exact mockup parity or physical-device evidence. known structural deviations in the initial handoff remain except corrected failed Close, status/filter/counts, mobile Settings/Changes and sidebar overflow. no built-in Changes/Plan/Tasks content or missing actions were invented; split/fullscreen/widget controls remain in their established positions rather than re-homed.
- stop here. coordinator may independently review these commits; no merge recommendation beyond this scoped evidence. unrelated `edc-context/reports/` remains untouched.
