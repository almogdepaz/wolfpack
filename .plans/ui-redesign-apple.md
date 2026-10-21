# ui redesign: attention-first dashboard, apple-style skin

status: fix-3 verified from `358a42fe` on `ui/apple-reskin`: desktop sidebar grid-action reveal, dashboard search focus ring, and screenshot untracking only. authorized delivery is a normal commit/push; no PR/merge/history rewrite. logs `/tmp/wolfpack-reskin-logs/fix-3/`. screenshots belong in the PR, not the git tree; copies are ready for attachment, not uploaded by this assignment. no child sessions; existing fix-2 verification/native iOS limitations remain recorded below.

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
- sort within each machine: automatic need → fail → work → idle tiers; delegation trees rank by their most urgent member and stay adjacent. user-authored per-row slots win within a tier/sibling scope; untouched rows fill the remaining slots by oldest wait age for need and newest output for work/idle. a drag/Alt+Arrow persists only the moved row's target slot plus earlier manual placements, not the whole machine. v1 identity-only and sparse saved orders remain supported; optional `position` records sparse slots and optional `tier` scopes them to the effective tier at placement time. a placement is ignored in other tiers. older untagged entries bind to their first observed effective tier without an automatic migration write.

### 2b. pinned "Needs you" group — `app.ts` `renderSessionListFromState` (~1701)

- before machine groups, render one synthetic group `machine-group needs-you` containing every `tier==need` session across all online machines, each row carrying its machine chip and `data-machine`. the same session still appears in its machine group (rendered dimmer, `opacity:.6`) so machine counts stay true; clicking either opens the same session.
- ordering is **age-only**, oldest `runtimeState.changedAt` first across machines; machine-group manual positions are deliberately ignored. this can differ from a session's machine-group order. unknown ages follow known ages. this decision does not change the pinned renderer.
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
- screenshots: `dashboard-1440.png`, `dashboard-390.png`, `terminal-1440.png`, `terminal-390.png` (1440×900 / 390×900 Chromium; mobile device scale 3). compared with mockup CSS 01/02/03/05. controlled session/peer fixtures, not live agent/device evidence. screenshot storage is superseded by fix-3: PR attachments, not tracked files.

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
- inspected the final 1440×900 and 390×900 captures. fix-3 subsequently moved screenshot delivery out of the git tree to PR attachments. these remain controlled-fixture evidence, not exact mockup parity or physical-device evidence. known structural deviations in the initial handoff remain except corrected failed Close, status/filter/counts, mobile Settings/Changes and sidebar overflow. no built-in Changes/Plan/Tasks content or missing actions were invented; split/fullscreen/widget controls remain in their established positions rather than re-homed.
- stop here. coordinator may independently review these commits; no merge recommendation beyond this scoped evidence. unrelated `edc-context/reports/` remains untouched.

## fix-2 handoff — second review remediation

- review: `/tmp/wolfpack-reskin-review/report-2.md`; start `07759f4e`; final production `d62f06cd5c84e5975db1df34b8dea7e68a53e9c2`. reference base remains `909d5150`. local commit only; no push/PR/merge. no worker sessions/tasks created; coordinator owns independent review.
- changed: `public/{app.ts,index.html,styles.css}`, generated `src/public-assets.ts`, `tests/e2e/{delegation-sessions,reskin-review}.e2e.ts`, this handoff and manually refreshed screenshots. protected-scope diff is empty (`14-protected.diff`). unrelated `edc-context/reports/` remains untouched.
- review-2 correctly found intermittent N1 despite the passing fix-1 full run. this section supersedes that run's broad conclusion; test counts alone were insufficient to establish an identical failing set.

### findings table

| finding | disposition / regression evidence |
|---|---|
| N1 — equal collapsed delegation heights | fixed at the separator rule, not by relaxing tolerance or setting arbitrary row heights. pre-fix probe: parent `76px`, solo `77px`; both content boxes `43.75px`, both name lines `19px`, both preview lines `18.75px`. only the later row had a `1px` top separator. the absolute difference occasionally exceeded 1px in transformed bounding boxes. reserve a transparent top border on the first row too. original bounding-box assertion remains; added exact computed-height equality. 15/15 isolated iphone-14 repetitions, zero retries/flakes, every captured pair `77px`/`77px`; also passes all three projects in the final suite. |
| N2 — two-line sidebar | hide the badge row again and move the delegation toggle into the name row. move its existing zero-top-margin selector with it, avoiding an Open hit-target overlap from the generic 3px toggle margin. regression checks hidden status row, equal parent/solo CSS heights, exactly 2px between name and preview, expansion/collapse and actual Open click into the delegation grid. final desktop screenshot shows name + preview + status dot. drag-cancel hierarchy assertion now targets `.card-name-text`, because `.card-name` intentionally also contains toggle text; order expectations are unchanged. |
| N3 — unusable Changes tab | hide the tab-bar control when not in a terminal, including initial markup. keep the existing, usable terminal-header Changes affordance. regression checks absence on initial sessions plus opening the existing context from the header. no last-terminal state or route added. |
| N4 — duplicate mobile Settings | optional change declined: retain the header gear and navigation link to preserve the established keyboard focus-return contract. original accessibility and mobile scrolling cases pass. the duplicate entry remains an explicit visual deviation. |
| N5 — clipboard gesture | clipboard read now occurs directly in the trusted `touchend` handler or ordinary `click`, never a synthetic click dispatched inside touchstart. start/mousedown guards retain terminal focus; cancelled touchend suppresses compatibility click. regression observes one trusted touchend read, then one trusted mouse click read, exactly two pasted payloads, and retained focus. original delayed-permission target/session check and error dialog preserved. Chromium emulation is not physical iOS/WebKit clipboard permission evidence; device coverage remains open. |
| N6 — Close confirmation | failed-session confirmation title, message and confirm button now say Close; normal sessions retain Stop. failed-session terminal chrome and error copy use the same verb. regression covers dashboard/sidebar/chrome confirmation and cancel/focus return; backend kill operation and confirmation gate unchanged. |

### verification

logs/artifacts: `/tmp/wolfpack-reskin-logs/fix-2/`. final checks ran in `/home/almog/dev/wolfpack` at `d62f06cd`; only the handoff was dirty during execution. browser/native checks used the same existing `WOLFPACK_BROKER_BIN=/home/almog/dev/wolfpack/broker/target/release/wolfpack-broker`; no native rebuild/install. full Chromium ran **once** after focused corrections. screenshots were copied manually only after testing.

| check | actual result | artifact |
|---|---|---|
| new/strengthened regressions before production edits | exit 1; 6 fail, 1 pass, 3 skip (N1/N2/N3/N5/N6 fail as intended) | `01-red.log`, `red-artifacts/` |
| pre-fix row decomposition | exit 1; exact-height assertion fails, measured border/content evidence retained | `02-geometry-report.json`, `02-row-geometry.json` |
| focused initial green | exit 1; 6 pass, 3 skip, one new test locator still expected Expand after expansion | `05-green.log` |
| sidebar corrections | initial Open interception reproduced; final exit 0, 1 pass | `06-sidebar.log`, `08-sidebar-fixed.log` |
| N1 iphone-14, `-g 'expanded child cards stay compact' --repeat-each=15 --reporter=json` | exit 0; 15 pass / 0 fail / 0 skip / 0 flaky; 25.46s | `10-n1-repeat.json`, `10-repeat-geometries.json`, `10-result.txt` |
| affected specs, desktop + iphone-14 | exit 1; 121 pass, 49 skip, 6 fail; five known selected-host baseline failures plus stale drag name selector | `11-affected.log` |
| corrected drag-cancel assertion | exit 0; 1 pass; same case also passes final suite | `12-drag.log` |
| `bun run scripts/gen-assets.ts` | exit 0; generated assets current | `15-final-assets.log` |
| `bun run typecheck` | exit 0 | `16-final-types.log` |
| full Chromium: `bunx playwright test --project=desktop --project=iphone-14 --project=iphone-se` | exit 1; **763 pass, 444 skip, 32 fail**, 1239 cases / 55 specs, 1239s; zero retries | `17-full-chromium.log`, `17-result.txt`, `final-artifacts/` |
| `bun test` | exit 1; **3599 pass, 8 skip, 1 fail**, 329.95s | `18-bun-test.log`, `18-result.txt` |
| base iphone-se widget-manager probe, 10 repetitions | exit 1; 7 pass / 3 fail, exact same x=-31 failure | `22-base-widget-repeat.log`, `base-widget-artifacts/` |
| `git diff --check`; protected diff | exit 0; protected diff empty | `14-protected.diff`, final git evidence |

- all requested regression cases pass in the final run; the full `reskin-review` file has 17 pass and 13 intentional project skips. N1 also passes desktop and iphone-se, not only its 15 iphone-14 repetitions. existing mobile settings focus-return, scrolling, accessory, order and parent Open cases pass.
- baseline accounting is by test and failure signature, not just aggregate counts: 29 final failures match the prior full base run and have identical extracted signatures (`19-baseline-comparison.json`, `23-shared-failure-signatures.json`). the other three are worker-readiness cleanup (browser-independent, previously reproduced on base), passive-inspection column race (previously reproduced on base), and **iphone-se** widget-manager x=-31. the last variant was re-probed on unchanged base in this round: 3/10 failures, same assertion/value. baseline app/index/styles hashes match `909d5150` (`20-base-source-check.txt`). the first probe's over-anchored grep selected no tests (`21-base-widget-repeat.log`); it is not counted as execution evidence.
- final Bun failure is the already baseline-reproduced bounded-inbox JSON truncation. no unrelated CLI/native/extension repair attempted. skips and diagnostics are retained unfiltered. these results do not claim a green full repository gate or rule out all possible flakes.
- fix-2 screenshots were manually copied from `final-artifacts/`; inspected the two-line desktop sidebar and the mobile bar with no dead Changes entry. fix-3 subsequently untracked those images and preserved copies for PR attachments. tests still write only private Playwright output paths. exact mockup parity, physical iPhone and WebKit remain unclaimed; no missing host libraries installed.
- stopped at the phase-1 boundary. no remaining product decision for this scoped assignment; coordinator may independently verify the commits. accepted earlier declines remain unchanged.

## fix-3 handoff — final scoped punch list

- base/start `358a42fe24eb22f94165ff8755c60865430221ba`, branch `ui/apple-reskin`. scope exactly the three requested items; normal push authorized, no PR/merge/force push/history rewrite. no child sessions.
- desktop sidebar grid buttons now use opacity 0 until row hover or focus-within, including selected/in-grid buttons. DOM, tab order, click handlers and all geometry remain unchanged; touch/non-hover presentation remains available. regression tabs from Open to the grid action, activates it with Enter, and checks reveal/hide before and after grid selection. the real-broker manual/delegation parent hit-target case from fix-1 passes unchanged.
- dashboard search uses `box-shadow: 0 0 0 3px var(--accent-tint)` and no outline in normal rendering. forced-colors modes suppress shadows, so the existing focus outline is deliberately retained there; both styles are asserted. other fields and segmented-control focus outlines are unchanged.
- screenshots live in the PR, **not the git tree**. all four PNGs were copied to `/tmp/wolfpack-reskin-screenshots/` before `git rm --cached`; copies and ignored local originals have identical SHA-256 hashes before/after verification. no PR was created or attachment uploaded by this assignment: coordinator attaches the preserved images or the fresh captures from `final-artifacts/`. old commits retain their historical images; no history rewrite. `git ls-files '.plans/screenshots/*.png'` is empty. tracked-source search found no writer/reference outside this handoff, and `apple-reskin.e2e.ts` still uses `testInfo.outputPath()`.

verification ran in `/home/almog/dev/wolfpack` on the final fix-3 source diff against `358a42fe`; dirty paths were only the requested CSS/generated assets/test/handoff and staged PNG removals. no source edits after checks. logs: `/tmp/wolfpack-reskin-logs/fix-3/`.

| check | result / exit | evidence |
|---|---|---|
| pre-fix regressions | 2 fail as intended; exit 1 (grid opacity 1, search solid outline) | `02-red.log` |
| focused fixes + parent Open regression | 3 pass; exit 0 | `04-green.log` |
| final `bun run scripts/gen-assets.ts` | exit 0 | `05-final-assets.log` |
| `bun run typecheck` | exit 0 | `06-typecheck.log` |
| affected Chromium desktop + iphone-14: reskin-review, apple-reskin, visual-makeover, accessibility-navigation, axe-accessibility, delegation-sessions, idle-session-view, grid, desktop-workspace-tools, session-state-visualization | 120 pass, 62 project-specific skips, 0 fail; exit 0, 2.3 min | `07-affected.log`, `07-result.txt`, `final-artifacts/` |
| real-broker selected-host manual/delegation grid hit-target case, desktop | 1 pass; exit 0 | `08-parent-hit.log` |
| screenshot copy integrity / no test writes | hashes unchanged; `cmp` exit 0 | `01-screenshot-copies.txt`, `09-screenshot-copies-after-tests.txt`, `10-screenshot-tracking.txt` |
| scope / whitespace | protected and unrelated production diff empty; `git diff --check` exit 0 | `11-untouched-scope.diff`, final git evidence |

- no full Bun/full-repository browser rerun in this narrow final punch list; earlier full-suite baseline failures and device limitations remain documented above. no installs or live-service changes. unrelated `edc-context/reports/` left untouched.
- final commit SHA and normal-push result are recorded in `12-final-git.txt` and `13-push.log`. stop after delivery; no additional work authorized.

## phase 2a/2b handoff

- branch/worktree: `ui/triage-pinned`, `/home/almog/dev/wolfpack-triage-pinned`; base `a3e249544f892f50735ca0fad2fde87e4ab2a888` (`ui/apple-reskin`). implementation `ac61c90cac77c0bf798c74f8cdb6c2f1de222de6`; test-only reconciliation `8e72633a397ad3a3339c3d415fbde4388e11caa4`. logical commits only; no push/PR/merge or child sessions. sibling phase 2c untouched.
- changed production: `public/app.ts` (shared dashboard row renderer, synthetic pinned group, ordering/focus exclusions), new `public/session-triage.ts` (triage comparator over existing delegation ordering), `public/styles.css` (full-width amber group, machine chips, .6-opacity duplicates), generated `src/public-assets.ts`. reused `src/agent-runtime-ui.ts` unchanged. no server/broker/websocket/auth/wire/dependency/lockfile changes.
- decisions (updated by fix-1 below): need → fail → work → idle stays automatic. within a tier, explicit manual positions win; age/recency orders only unpositioned rows. need age uses runtime `changedAt`, work/idle recency uses activity `lastRenderedActivityAt`, never terminal text or client receipt time. unknown/invalid ages follow known ages. delegation trees stay contiguous and rank by their most urgent member, including descendant waiting age. pinned projection independently includes every waiting child, even with a collapsed parent. desktop/mobile share the renderer; pinned rows retain machine routing/Open/Stop but no ordering attributes; group is absent when empty or excluded by tier, hidden when search has no matches.
- persistence remains v1-compatible. automatic fallback positions are separate from explicit manual positions. drag/Alt+Arrow works within the same effective tier regardless of timestamps; cross-tier moves are rejected. fix-2 adds optional sparse `position` slots: only the moved row and earlier manual placements are saved; untouched rows keep automatic age/recency. fix-3 adds optional `tier` scope: tagged placements are ignored in other effective tiers. older identity-only and sparse entries bind to their first observed effective tier in memory, with no automatic migration write or deletion. delegation/manual-order/drag tests pass; updated selectors distinguish synthetic duplicates from real machine rows, and hierarchy/escaping assertions remain intact.
- tests: all 12 runtime-state mappings retained (broker authority fixture corrected to the contract constant); five new sort tests; four new Playwright tests covering duplication/dimming/counts, empty group, no ordering attributes, multi-machine routing and collapsed waiting children. red: unit 4 fail/14 pass; pinned browser 2 fail/1 pass. green: units 24 pass; affected Chromium 63 pass/23 skip; pinned desktop/390px 8 pass. inspected 1440px/390px captures in `pinned-final-artifacts/`; no screenshots committed.

verification ran in this worktree; logs and command/revision/duration records: `/tmp/wolfpack-2ab-logs/`. full gates used clean `ac61c90c` production inputs. subsequent changes are the one navigation test and this handoff only; final asset/type/unit rechecks ran at `8e72633a`. no repeated full-suite gate after the test-only correction.

| check | actual exit / counts | evidence |
|---|---|---|
| frozen install | 0; no lockfile change | `install.log` |
| gen-assets; typecheck | 0; 0 (final rechecks also 0; typecheck 13s in full gate) | `17-final-assets*`, `18-final-types*`, `28-final-assets.log`, `29-final-types.log` |
| focused units | 0; 24 pass, 0 fail | `30-final-unit.log` |
| full `bun test` | 1; 3603 pass, 8 skip, 2 fail; 354s | `19-final-bun.log`, `19-final-bun-result.txt` |
| full Chromium, desktop/iphone-14/iphone-se, zero retries | 1; 780 pass, 448 skip, 29 fail, 0 flaky; 1491s | `20-full-chromium.{log,json}`, `20-full-chromium-result.txt` |
| same Chromium gate on exact base archive + same dependencies/broker | 1; 768 pass, 448 skip, 29 fail, 0 flaky; 1474s | `23-base-chromium.{log,json}`, `23-base-chromium-result.txt` |
| corrected delegation navigation test | 0; 1 pass | `27-ux-corrected.log` |
| base inbox test | 1; 150 pass, 1 fail (same #461 bounded JSON failure) | `22-base-inbox.log` |
| isolated server-lifecycle tests, head / base | 0: 4 pass / 1: 3 pass, 1 fail (same temporary-home assertion) | `25-head-lifecycle-isolated.log`, `26-base-lifecycle-isolated.log` |
| design detector; whitespace/scope | 2: two unchanged legacy CSS warnings; `git diff --check` 0, protected diff empty | `16-design-scan.json`, final git evidence |

- browser reconciliation: 28 failures match base by test and failure mechanism; the only head-only case was the old navigation count including the new pinned duplicate, corrected and passing in isolation. base-only widget-manager x=-31 failure passed on head. complete signatures/comparison: `24-baseline-comparison.json`. full-suite totals are reported as run, not relabeled green after the focused correction.
- Bun failures are not hidden: #461 is the authorized known failure; the additional server-lifecycle temporary-home assertion also reproduces on unchanged base, while isolated head passes. full Bun ran concurrently with browser fixtures, and the assertion scans global temporary homes; no unrelated fixture cleanup fix attempted. base is a source archive (`base-path`), not a git worktree; only browser and isolated inbox/lifecycle checks ran there, not git-metadata-dependent unit tests.
- open risks: no green full-repository gate is claimed; baseline failures remain. hierarchy-preserving sibling sorting is deliberate rather than strict flat cross-tree tier order. native broker was the existing approved binary, not rebuilt; WebKit/physical-device behavior is unverified. quick reply, footer/meta, snooze, failed actions and all phase 2c–2e work remain out of scope. the original equal-timestamp-only reorder model is superseded by fix-1 below. no push.

### phase 2a/2b fix-1 — review A1/A2/A3/L-a

- start `3cebe63705e3d52d50309fb1afe47f0944e28481`; final production/tests `4d57c5cd14857ed1ce13252f77e6dcea654423ce`, branch `ui/triage-pinned`. verified findings against source/history before fixing. no child sessions, push, PR, merge, dependency/server/protocol changes, or sibling-worktree edits.
- **A1:** explicit persisted manual order now precedes recency within each automatic tier. automatic stable server-order fallback is kept separately in memory, never converted into manual positions on refresh. keyboard/drag scope uses effective tier, not timestamp equality. retained v1 full-machine snapshots on a manual gesture; new unpositioned rows continue sorting by recency. `public/index.html:144` now explains the tier boundary and delegation-tree movement.
- **A2:** `renderedSessionNavigationTargets` excludes controls inside `.needs-you`; dashboard Cmd+ArrowDown from current waiting session attaches the working session instead of reopening the pinned duplicate.
- **A3:** shared subtree priority calculation promotes the most urgent descendant to its ancestors, preserving adjacency and sibling scopes. the same calculation drives render order and allowed manual moves. nested-grandchild unit coverage included. navigation expectations now put the idle tree with a waiting child above working orphan roots; all hierarchy/escaping assertions retained.
- **L-a:** rounded `.session-search:focus-within` owns the 3px green ring at .7 alpha; inner input has no square shadow. forced-colors retains its existing 2px outline. computed shape, shadow and forced-colors assertions pass.
- changed: `public/{app.ts,session-triage.ts,index.html,styles.css}`, generated `src/public-assets.ts`, `tests/unit/session-triage.test.ts`, new `tests/e2e/triage-review.e2e.ts`, existing `reskin-review` and `ux-navigation` expectations. protected diff empty (`18-protected-final.diff`). logs `/tmp/wolfpack-2ab-logs/fix-1/`.

| check | actual outcome | evidence |
|---|---|---|
| intended red, before production edits | units exit 1: 4 pass/4 fail; desktop A1 keyboard/drag, A3 and L-a fail; corrected A2 probe fails n1→n1 vs n1→w1 | `01-unit-red.log`, `02-browser-red.log`, `03-a2-red.log` |
| final gen-assets; typecheck | exit 0; exit 0 | `10-final-assets.log`, `11-final-types.log` |
| focused tier/triage/order/delegation units | exit 0: 34 pass/0 fail | `12-final-unit.log` |
| affected Chromium desktop + iphone-14, 8 specs | exit 0: 111 pass/45 intentional skips, 2.0 min | `09-affected.log`, `affected-artifacts/` |
| full Chromium, 3 projects, once, zero retries | exit 1: 790 pass/452 skip/30 fail/0 flaky, 1321s | `15-full-chromium.{log,json}`, `15-full-chromium-result.txt`, `full-artifacts/` |
| two extra failures on exact `a3e24954` base, 10 repeats per applicable project | exit 1: 8 pass/20 project skips/12 fail; passive geometry 4/10, collapsed preview 8/10 | `16-base-extra-failures.{log,json}`, `base-extra-artifacts/` |
| whitespace/protected scope | exit 0; protected diff 0 bytes | `18-protected-final.diff`, final git evidence |

- full gate used clean committed `4d57c5cd` in this worktree and the existing approved broker binary. all new regression cases pass in that full run. 28 failures match the prior exact-base list; two additional cases reproduce on that same base archive with identical assertions: iphone-se passive-inspection columns 122→81 and desktop collapsed widget Beta panel hidden. base-only widget-manager x=-31 passed this run. complete comparison/signatures: `17-baseline-comparison.json`; compact result `17-comparison-summary.txt`. no unexplained branch-only failure remains; full suite is **not green**.
- evidence corrections retained: the first A2 probe read the attach message instead of its URL and is not valid red evidence; `03-a2-red.log` is the corrected intended failure. the first narrow mobile A3 test needed expanding its already-collapsed parent; fixture corrected, not production mobile collapse behavior. detector exit 2 reports unchanged CSS/markup warnings (`13-design-scan.json`); no unrelated redesign attempted.
- no full Bun rerun was requested for this scoped fix; prior #461 and global temporary-home lifecycle failures remain recorded above. no WebKit or physical-device claim. only this handoff changed after the full gate. stopped after committing the handoff; no push.

### phase 2a/2b fix-2 — per-row placement and pinned age-only decision

- start `58eca009`; implementation `efb84f22942b373166eaa7178c56c03be2e4c629`, `ui/triage-pinned`. reviewed second-pass section A and verified the whole-machine snapshot in `moveSessionCard` before editing. scope: client persistence/ordering, focus token, tests and plan only. no push/PR/merge, installs, child sessions or sibling edits.
- **PER-ROW:** v1 entries now optionally carry a nonnegative safe-integer `position` within their effective tier/sibling scope. only the moved row gains a placement; earlier manual placements shift with displaced siblings. untouched rows fill vacant slots by automatic wait age/recency, including after refresh/reload. the numeric slot preserves the actual drop position without marking the target or other rows manual. out-of-range slots are clamped when scopes shrink; collisions resolve deterministically. identity-only v1 entries load unchanged and retain their manual rank; invalid optional metadata is ignored, not the session identity. legacy full-machine orders remain manual until the user resets them. this supersedes fix-1's full-machine gesture snapshot.
- **N-A1 AGE-ONLY:** documented explicitly in plan 2b. pinned rows remain oldest-waiting-first across machines, ignoring machine-group manual slots; pinned rendering code is unchanged. **token nit:** unchanged rounded .7-alpha ring now consumes `--accent-focus`.
- changed production: `public/app.ts` records sparse moves through `public/session-order.ts`; that file validates/round-trips optional positions and updates only previous placements plus the mover. `public/session-triage.ts` reserves manual slots per tier/sibling group and fills other slots automatically. `public/styles.css` adds/uses the accent token; generated `src/public-assets.ts`. no server/broker/wire/auth/lockfile changes (`12-protected.diff` is empty).
- regression evidence: `01-per-row-red.log`, exit 1, two failures before production changes (keyboard saved all six rows; drag saved both rows). green UI coverage uses a real gesture, no seeded store: asserts one saved row, unchanged untouched age/recency sorting, reload, and preservation of earlier placements on a second move. desktop drag also asserts a one-row store. unit coverage includes v1 legacy/sparse round trips, malformed metadata, shifted earlier placements, exact sparse slots and scope shrink collisions. the old delegation spec's whole-machine store/reload expectations were updated to the selected per-row behavior; its first failure and subsequent two passing cases remain in `06-affected.log` / `07-persistence-updated.log`.

final scoped checks ran in `/home/almog/dev/wolfpack-triage-pinned` on the exact source diff subsequently committed as `efb84f22`; only this handoff changed afterwards. complete logs and command/dirty-state/duration records: `/tmp/wolfpack-2ab-logs/fix-2/`.

| check | actual exit / result | evidence |
|---|---|---|
| gen-assets | 0; 1s | `08-final-assets.log`, `08-final-assets-result.txt` |
| typecheck | 0; 11s | `09-final-types.log`, `09-final-types-result.txt` |
| focused order/triage/tier/delegation units | 0; 38 pass, 0 fail | `10-final-unit.log` |
| six affected Chromium desktop + iphone-14 specs, zero retries | 0; 95 pass, 45 intentional skips; 95s | `11-final-affected.log`, `11-final-affected-result.txt`, `final-artifacts/` |
| whitespace/protected scope | 0; protected diff 0 bytes | `12-protected.diff`, final git evidence |

- no full Bun/full Chromium rerun requested for this scoped follow-up; fix-1's full-gate baseline failures/device limitations remain documented, not claimed resolved. all requested scoped checks pass. stopped after the handoff commit; no push.

### phase 2a/2b fix-3 — identityless ranking and tier-scoped placements

- start `c5ff5d76`; implementation `3fcb8ff769178988d66c0b1da06a0ab3ea8632db`, `ui/triage-pinned`. verified third-review section A findings against code and history. client/helpers/tests/generated assets only; no server/protocol/dependency/sibling edits, child sessions, push/PR/merge.
- **N-A2:** triage now ranks every row, not just persistent ids. the existing delegation traversal is shared by a new row-rank entry point and the unchanged identity-order wrapper; no copied tree algorithm. identityless waiting rows keep their age/tier priority instead of sinking below work, while hierarchy remains adjacent. they still do not gain drag/persistence attributes without an id.
- **N-A3:** new placements save validated optional `tier` alongside `position` in the same v1 format. scope is the effective subtree tier, so descendant urgency changes also invalidate a placement in the new tier. mismatched scopes are ignored, not deleted or rebound by moving another row. an explicit new move can place the row in its new tier. older v1 identity-only and untagged sparse entries load normally and bind to the first observed effective tier in memory. inferred scopes are saved with the next manual save; there is no automatic migration write. a legacy disk entry has no historical tier to recover and will bind again on reload until such a save; tagged entries retain their scope across reload.
- changed: `public/{app.ts,session-order.ts,session-triage.ts}`, generated `src/public-assets.ts`; unit order/triage coverage and browser triage/persistence coverage. tests assert both legacy formats still load, new tier metadata round-trips, invalid metadata drops without losing identities, tagged placement ignores tier changes across reload, and old out-of-tier placements are not rebound by another move. updated exact-store expectations include the new tier field. pinned age-only ordering is unchanged.
- intended red: `01-regression-red.log`, exit 1, **18 pass / 2 fail**, before production edits. N-A2 receives known-need/worker before identityless need; N-A3 carries a work slot into need. existing order tests characterize the shared traversal before extraction. green results below.

final scoped checks ran in `/home/almog/dev/wolfpack-triage-pinned` on the exact source diff committed as `3fcb8ff7`; only this handoff changed afterwards. logs and command/revision/dirty-state records: `/tmp/wolfpack-2ab-logs/fix-3/`.

| check | actual exit / result | evidence |
|---|---|---|
| gen-assets | 0 | `06-final-assets.log`, `06-final-assets-result.txt` |
| typecheck | 0; 11s | `07-final-types.log`, `07-final-types-result.txt` |
| focused order/triage/tier/delegation units | 0; 42 pass, 0 fail | `08-final-unit.log` |
| same six affected desktop + iphone-14 specs, zero retries | 0; 101 pass, 45 intentional skips; 99s | `09-final-affected.log`, `09-final-affected-result.txt`, `final-artifacts/` |
| whitespace/protected scope | 0; protected diff 0 bytes | `10-protected.diff`, final git evidence |

- no full Bun/full Chromium rerun requested for this scoped follow-up; earlier baseline failures and WebKit/device limitations remain documented, not claimed resolved. legacy missing-tier inference is intentionally non-destructive and cannot reconstruct historical facts. all requested scoped checks pass. stopped after the handoff commit; no push.
