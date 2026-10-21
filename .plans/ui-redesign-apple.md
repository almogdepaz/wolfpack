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

## phase 2c execution status

- assignment: implement 2c only in `/home/almog/dev/wolfpack-last-line-meta`, branch `ui/last-line-meta`; base/start `a3e249544f892f50735ca0fad2fde87e4ab2a888` (`ui/apple-reskin`). local logical commits only, no push/PR/merge. no child sessions or endpoint tasks created.
- allowed: observation display projection, client metadata rendering/styles, fixtures/tests, generated assets, this handoff. runtime reduction, broker/transport/auth and sibling phase-2a/2b worktree remain untouched.
- status: fix-3 N-B4 implemented at `f455ce9f46ee36d92b5ff97c8970067ec93223da`, from `81961ae4802a56d3b414394ec6eadd12b3203930`. all requested scoped gates pass; regression evidence and exact exits/counts are in the fix-3 handoff below. logs `/tmp/wolfpack-2c-logs/fix-3/`. only display footer recognition changes; no runtime/tier changes, child sessions, push/PR/merge or sibling-worktree changes. stop after local handoff commit.

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

## phase 2c handoff

- base: `a3e249544f892f50735ca0fad2fde87e4ab2a888` (`ui/apple-reskin`); source commits `5e2a0b43` (projection/rendering) and `a2d7cb9033d4e1e70096f24819d67a735248fc6f` (preserve two-line sidebar), branch `ui/last-line-meta`. this final handoff is documentation-only. no push, PR, merge, sibling-worktree edits, or child sessions.
- changed: `src/server/session-observation.ts` walks upward over chrome, truncates the selected line to 160 codepoints, retains the original final-line/240-character fallback, and adds optional display-only `meta` + raw `footer` summary fields. `public/session-meta.ts` owns the shared display type and escaped labeled rendering; `public/app.ts` joins it into dashboard `activityHtml` without adding sidebar lines; `public/styles.css` styles values and ctx ≥85% amber; generated `src/public-assets.ts`. tests: `tests/unit/{session-output-preview,session-meta}.test.ts`, `tests/e2e/session-meta.e2e.ts`.
- regexes: pi footer `^[↑↓]\d`, cwd `^~\/.*\(.*\)$`; pi model/reasoning from the trailing `(provider) model • reasoning`, cost/tag from `$number (tag)`, context exclusively from `number%/numberk` (expanded contextLimit in tokens). **CH is cache-hit, never contextPct.** Claude skips captured auto-mode and update-installed lines. all harnesses skip 8+ hyphens/rules, box-drawing-only rules, blank lines and empty input/cursor glyphs. Codex/Gemini/Cursor have only synthetic conservative rule/cursor fixtures; metadata remains undefined without a captured parseable footer. unknown pi footer chrome retains raw text for fallback.
- runtime authority: no prompt detection or changes to tier, ordering, attention, notifications, activity fingerprints or status reduction. the existing runtime preview input remains unfiltered, separate from the display projection. a y/n preview with program status Done remains idle-tier in unit/browser regressions and an actual server-observation probe. git delta/project-git-status remains client-side and untouched. broker/websocket/PTY/auth/lockfile diff is empty.

verification ran in `/home/almog/dev/wolfpack-last-line-meta` on source `a2d7cb90` with only this plan dirty; same installed broker used by both Chromium runs. full evidence, commands/cwd, durations, failure diagnostics and artifacts: `/tmp/wolfpack-2c-logs/verification-summary.md`.

| check | actual exit / counts | log under `/tmp/wolfpack-2c-logs/` |
| --- | --- | --- |
| `bun run scripts/gen-assets.ts` | 0 | `20-final-assets.log` |
| `bun run typecheck` | 0 | `21-final-types.log` |
| focused unit (projection, render helper, unchanged tier mapping) | 0; 24 pass | `10-focused.log` |
| focused Chromium render + fallback + amber + Done + compact sidebar, 3 projects | 0; 3 pass | `22-sidebar-green.log` |
| `bun test` final | 1; 3608 pass, 8 skip, 2 fail; 351s | `16-bun.log`, `16-bun.result` |
| full Chromium final, zero retries | 1; 771 pass, 448 skip, 29 fail; 1447s | `17-full-chromium.log`, `.json`, `.result` |
| full Chromium base `ui/apple-reskin` | 1; 764 pass, 448 skip, 33 fail; 1279s | `18-base-chromium.log`, `.json`, `.result` |
| actual server-observation + tier probe, head/base | head 0; base 1 at intended old-preview assertion; Done/idle-tier agrees on both | `23-observation-probe.log`, `24-base-observation-probe.log` |
| lifecycle test isolated TMPDIR, head/base | both 0; 4 pass each | `26-head-lifecycle-isolated.log`, `27-base-lifecycle-isolated.log` |
| `git diff --check`; protected scope | 0; protected diff empty | `diff-check.log`, `protected.diff` |

- red/green: original footer selection/length fail in `04-preview-red.log`; original client has an empty metadata row in `13-client-base-red.log`; pre-correction sidebar leaks metadata in `19-sidebar-red.log`. final focused tests pass. initial missing-export/module errors are not behavioral-red evidence. an early broad run was stopped for the sidebar correction; aborted logs are retained separately, not counted as final checks.
- Bun failures: known inbox #461 plus a global-temp-directory lifecycle assertion racing concurrent Playwright fixtures. the latter's identical failure was reproduced with a real concurrent fixture on unchanged base (`25-base-lifecycle-race.log`, exit 1); isolated head/base lifecycle tests pass. this extra harness failure is reported, not silently ignored or fixed out of scope. isolated base inbox happened to pass 151 tests (`28-base-inbox.log`); no claim that it reproduced #461 this round.
- browser reconciliation: **all 29 head failures occur on base, zero head-only failures** (`browser-comparison.json`). differing diagnostics were inspected: randomized fixture paths/tokens, repeated wait counts, the same pointer-intercepting overlays, extra `/api/backend` polling, missing TUI bottom line, 122→81 inspection columns and hydrating-not-live grid cells. four base-only failures remain baseline/flaky observations, not fixes claimed here. full raw/signature evidence: `shared-signatures.json`, `31-different-signatures.txt`, `32-selected-host-signatures.txt`. base archive path in `base-path`, same dependencies/generated base assets, no `.git`; no git-metadata baseline claims.
- open risks: no live Codex/Gemini/Cursor footer captures/metadata claims; synthetic chrome fallback coverage is explicit. no physical-device/WebKit verification or fresh native build. the repository suites are not green; baseline/harness failures remain outside 2c. no outstanding product decision. stop and wait after committing this handoff.

### fix-1 — review B1–B5 remediation

- start `7a856b4c7e7def67a3bb8347769893477aa21923`; final source `d51cfc0b97448d6d08b45237e91e322d1a9c9763` on `ui/last-line-meta`. this handoff commit is documentation-only. all checks ran in this worktree with only the plan dirty. no push/PR/merge, child sessions, sibling-worktree changes or installs.
- B1: authorized edits to `src/control-api/schema.ts` and regenerated `docs/generated/control-api.schema.json` declare **optional** `meta` (six optional typed fields) and `footer`. the rest of the entire generated contract is unchanged (`13-schema-scope.log`). new real HTTP pi-footer contract sample in `tests/integration/control-api-schema-contract.test.ts`, shared capture `tests/fixtures/pi-footer.ts`; omission stays valid and wrongly typed metadata is rejected.
- B2: `session-observation.ts` anchors pi stats within the bottom **three nonempty lines**, skipping trailing extension statuses and the directly preceding path-shaped cwd (`~/`, `/`, `…`). fixtures cover no branch, named session, outside home, truncated path and one/two status lines below stats. adjacent ordinary agent text is preserved when there is no cwd, and older stats do not consume subsequent agent content.
- B3/B4: pi context accepts `number%/number[kM]`, multiplying by 1000/1000000; CH is still not context. model regex anchors at the 2+ space alignment gap, makes `(provider)` optional, and accepts multiword reasoning such as `thinking off`. new fixture regressions in `tests/unit/session-output-preview.test.ts`.
- B5: shared type moved to `src/session-meta-contract.ts`; `public/{app,session-meta}.ts` and server import it from `src/`, not `public/`. client changes are type-only; generated browser assets remain byte-identical after generation. no tier/state reduction, sorting, attention, notification, broker, transport, auth, kill or task-runtime changes.

| check | actual exit / counts | `/tmp/wolfpack-2c-logs/fix-1/` evidence |
| --- | --- | --- |
| B2/B3/B4 regressions before fixes | exit 1; intended fixture failures | `02-red-complete.log` |
| corrected B1 test against original schema | exit 1; footer/meta explicitly disallowed | `06-contract-old-schema-red.log` |
| schema generation | 0 | `03-schema-generation.log` |
| focused projection/render/tier units + control-api units/live contracts | 0; 83 pass | `07-focused-green.log` |
| assets / typecheck | both 0 | `08-assets.log`, `09-types.log` |
| affected Chromium specs, 3 projects | 0; 80 pass, 40 project-specific skips | `10-affected-chromium.log` |
| actual observation + Done/y-n tier probe | 0 | `11-observation-tier-probe.log` |
| full Chromium once, 3 projects, zero retries | 1; 770 pass, 448 skip, 30 fail; 1308s | `12-full-chromium.log`, `.json`, `.result` |
| worker-readiness desktop isolated probes | base 25/25 pass across two runs; head 5/5 pass; all exit 0 | `15-base-worker-readiness.log`, `16-base-worker-readiness-repeat.log`, `17-head-worker-isolated.log` |
| whitespace / protected scope | 0; protected diff empty | `protected.diff`, final git evidence |

- valid contract red evidence is `06-contract-old-schema-red.log`, not the earlier matcher-obscured failure: Bun's asymmetric `toMatchObject` mutated the response in the initial test. test validation now runs before a plain shape assertion; temporary instrumentation is removed. B5 retains passing renderer characterizations and strict typechecks; the tier-independence test remains green.
- full comparison reuses the saved `ui/apple-reskin` (`a3e24954`) base list: 764 pass / 448 skip / 33 fail in `/tmp/wolfpack-2c-logs/18-base-chromium.json`. **29 exact project/spec/title matches** have matching failure assertions (`browser-comparison.json`, `19-shared-failure-signatures.txt`). the 30th is desktop worker-readiness cleanup at line 116 after kill; the identical browser-independent test/assertion already fails on base iphone-se/iphone-14 (`18-base-worker-failure-signatures.txt`). its unchanged session-control-list route does not call the display projection. exact desktop reproduction on base was **not** obtained in 25 isolated attempts; head also passes 5 isolated attempts. retain that full-run variant as a flaky-risk caveat, not an unreported failure or a claim of a fully green suite. no out-of-scope task/broker fix attempted.
- complete commands, source provenance, diagnostics and limitations: `/tmp/wolfpack-2c-logs/fix-1/verification-summary.md`. no full Bun rerun in this scoped follow-up; requested focused/contract checks are above. original live-capture/native/device limitations remain. no open product decision; stop after the local handoff commit.

### fix-2 — review N-B1–N-B3 and schema-description nit

- start `83e3083321c052c0086cb32bd05d42c3ce98f837`; parser/fixture commit `87b0bb4ecb51e57175080de7da5934c167bfc534`; schema-description/test/generated-JSON commit `a40595d84e33e828b0f8bd8b9f33a9d75cc7d42f`. verification covered the exact dirty source/test/schema diff subsequently committed unchanged; this handoff is documentation-only. no installs, child sessions, sibling-worktree edits, push/PR/merge.
- N-B1/N-B2: `src/server/session-observation.ts` now shares the context-token regex between footer-block anchoring, chrome skipping and metadata parsing: numeric usage or `?`, followed by `/number` and optional `k`/`M`. fresh subscription/API-key sessions without ↑ counters are recognized; a non-pi ↑/↓digit line is no longer footer evidence and remains visible content. the bottom-three nonempty-line bound and adjacent cwd/status handling remain. unknown percentage is omitted, not fabricated; CH stays cache-hit only.
- N-B3: model parsing accepts no `• reasoning` suffix and uses the model after the final `→`, including optional provider labels. absent reasoning stays absent. `tests/unit/session-output-preview.test.ts` adds derived fresh/routed/non-reasoning fixtures and non-pi arrow regressions. the old unknown-counter footer expectation is intentionally replaced with preservation as content: without the pi context marker it is not known footer chrome.
- nit: `src/control-api/schema.ts` and regenerated `docs/generated/control-api.schema.json` now describe raw footer as also included alongside structured metadata. only the description changes; `tests/unit/control-api-schema.test.ts` covers the correction. no API shape or runtime/tier/attention/sorting changes.

| check | actual exit / counts | `/tmp/wolfpack-2c-logs/fix-2/` evidence |
| --- | --- | --- |
| regressions before fixes | 1; 82 pass, 13 intended failures across all findings/nit | `01-red.log` |
| schema generation | 0 | `02-schema-generation.log` |
| assets | 0; generated bytes unchanged | `04-assets.log`, `.result` |
| typecheck | 0; 11s | `05-types.log`, `.result` |
| focused preview/render/tier units + control-api units/live contracts | 0; 95 pass, 471 expectations | `06-focused-final.log`, `.result` |
| affected Chromium: session-meta, apple-reskin, reskin-review, session-state-visualization, idle-session-view, delegation-sessions; desktop/iphone-14/iphone-se | 0; 80 pass, 40 project-specific skips; 82s | `07-affected-chromium.log`, `.result` |
| actual server observation + Done/y-n tier probe | 0 | `08-observation-tier-probe.log` |
| whitespace / protected scope | 0; protected diff empty | final git evidence, `protected.diff` |

- complete commands/provenance: `/tmp/wolfpack-2c-logs/fix-2/verification-summary.md`. no full Bun/full Chromium rerun in this scoped follow-up; prior broad-gate results and native/device/live-capture limitations remain. no new dependencies or protected-surface edits. no open product decision; stop after committing this handoff.

### fix-3 — N-B4 pi-shaped footer recognition

- start `81961ae4802a56d3b414394ec6eadd12b3203930`; implementation `f455ce9f46ee36d92b5ff97c8970067ec93223da`. verified the exact source/test diff subsequently committed unchanged; final handoff is documentation-only. no installs, child sessions, sibling-worktree changes, push/PR/merge.
- `src/server/session-observation.ts`: shared context regex now anchors at line start and accepts only pi stats before context (`[↑↓RW]number[kM]?`, `CHnumber%`, `$number`, `(sub)`). fresh pi sessions may still begin directly with context. footer detection, skipping and metadata parsing keep one shared recognizer; coverage prose no longer consumes later output or fabricates an amber ctx value. no runtime/tier/attention/sorting changes.
- `tests/unit/session-output-preview.test.ts`: five non-pi prose regressions verify both trailing-prompt and final-line placement, with no footer/meta. positive cache-write/zero-cost fixture plus existing fresh no-arrow fixtures protect N-B1. prefix formats were checked against the installed pi footer formatter read-only; unknown future formats intentionally remain content rather than becoming metadata.

| check | actual exit / counts | `/tmp/wolfpack-2c-logs/fix-3/` evidence |
| --- | --- | --- |
| before-fix regression/characterization suite | 1; 96 pass, 5 intended failures | `01-red.log` |
| focused preview/render/tier units + control-api units/live contracts | 0; 101 pass, 482 expectations | `02-focused-green.log` |
| assets | 0; generated bytes unchanged | `03-assets.log`, `.result` |
| typecheck | 0; 12s | `04-types.log`, `.result` |
| affected Chromium: session-meta, apple-reskin, reskin-review, session-state-visualization, idle-session-view, delegation-sessions; 3 Chromium projects | 0; 80 pass, 40 project-specific skips; 81s | `05-affected-chromium.log`, `.result` |
| actual observation + Done/y-n tier probe | 0 | `06-observation-tier-probe.log` |
| whitespace / protected scope | 0; protected diff empty | `07-diff-check.log`, `protected.diff`, final git evidence |

- full commands, source provenance and limitations: `/tmp/wolfpack-2c-logs/fix-3/verification-summary.md`. no full Bun/full Chromium rerun in this scoped correction; earlier broad-gate failures and native/device/live-capture limitations remain. no open product decision; stop after the local handoff commit.

## integration + local deploy

- worktree `/home/almog/dev/wolfpack-ui-redesign`, branch `ui/redesign`; base `a3e249544f892f50735ca0fad2fde87e4ab2a888`. recovery read-only findings: existing `/home/almog/dev/wolfpack-redesign` belongs to `impeccable-redesign`; `ui/redesign` already pointed exactly to base and was not checked out; replacement path was absent. old path/worktrees remain untouched. full findings: `/tmp/wolfpack-redesign-logs/00-worktree-recovery.txt`.
- authorized merge commits: `a69a84f64960b34db09a8949b5f1940b71c89fe7` (triage @ `8d860f7a`), `7c5449454577c4816c9f299130a7c70c691d6445` (meta @ `11c33b62`). only expected plan/assets conflicts; both complete handoffs retained, assets regenerated rather than edited. no semantic app/CSS conflict observed and no integration-regression fixes needed. full gate/build use clean `7c544945`; this final commit changes documentation only. frozen install exit 0, lockfile unchanged. no push/PR/main merge or child sessions.
- full gate ran once, sequential Bun then default-project Playwright, in this worktree. command/revision/dirty-state/duration records and complete diagnostics live under `/tmp/wolfpack-redesign-logs/`:

| check | exit / actual result | log |
|---|---|---|
| `bun run gen:schema`; `bun scripts/gen-assets.ts` | 0 / 0; no tracked diff after either (diff checks 0) | `11-schema.log`, `13-assets.log`, `12-schema-no-diff.log`, `14-assets-no-diff.log` |
| typecheck; context routes | 0 / 0; all declared documents/links resolve | `15-types.log`, `17-context.log` |
| bundle budgets | 1; app 338645 raw / 101218 gzip (caps 386000 / 98000); CSS 121497 / 22224 (caps 104500 / 20000); Ghostty passes; no budget raised | `16-bundle-budgets.log` |
| full `bun test` | 1; 3655 pass / 8 skip / 1 fail (#461 only); 324s | `18-bun.log` |
| full default Playwright, all four projects | 1; 806 pass / 452 skip / 56 fail; 1287s | `19-playwright.log`, `19-playwright.json`, `playwright-artifacts/` |
| base WebKit, same complete project | 1; 0 pass / 0 skip / 27 launch failures, same missing host libraries | `21-base-webkit.log`, `.json` |
| server-only build | 0; linux-x64 artifact, 2s; post-build tracked diff empty | `27-server-only-build.log`, `27-server-only-build-result.txt`, `27-postbuild-source.diff` |

- new-vs-base failure difference: **zero new/unclassified failures**. 28 Chromium failures match the saved exact `a3e24954` full suite, one collapsed-widget preview failure matches the repeated exact-base probe, and all 27 WebKit failures match a fresh exact-base WebKit run (host libraries unavailable; no installs attempted). signatures and classification: `25-baseline-comparison.json`, `25-comparison-summary.txt`. baseline budgets already fail too: app gzip 99742; CSS 120451 raw / 22034 gzip (`24-base-budget.log`). the first baseline-budget probe lacked generated JS and is not valid size evidence; generation plus corrected probe are retained in `23-base-assets.log` / `24-base-budget.log`. gates are not claimed green; budgets remain a user decision and WebKit remains unverified.
- deploy preflight confirmed the command symlink resolves to a plain x86-64 ELF at `/home/almog/.wolfpack/bin/wolfpack`, backed by independent systemd user units. installed help/source document `wolfpack service restart --server-only` (broker:false). initial server/broker PIDs 2052/2051, initial installed SHA-256 `95727e7350d32c7e1f58700cee868ec5fdfa4c2cead51b76ced7ec480893a641`; layout/command/initial sessions recorded in `01-service-help.log`, `05-service-layout.log`, `06-installed-binary.sha256`, `07-initial-sessions.json`.
- deployed with a scoped deploy lock, backup `/home/almog/.wolfpack/bin/wolfpack.bak-pre-redesign`, exact `WOLFPACK_BUILD_SERVER_ONLY=1 bun run scripts/build.ts`, same-directory temporary copy/chmod/atomic rename, then explicit server-only restart. backup matches the original hash; installed server SHA-256 `e0f1bf8b4b1040d10f5735bcf601350713a4da5fa6b7bd673c34d6836c966416`. broker binary/service never replaced or restarted. rollback-on-failure path was prepared but not invoked; all checks passed and the owned deploy lock was removed.
- deploy verification exit **0**: server **2052 → 1847984**, broker **2051 unchanged**, exact **3/3 session UUIDs** preserved, loopback `/api/info` succeeds (version 1.6.26), installed top-level and session-open CLI help pass. built and served `/app.bundle.js` SHA-256 both **`964a04c6bf1bf36e5e528bc63de400c2a544ccde381d3a0db9d54578e789d37e`**. receipts: `deploy-result.txt`, `26-backup.sha256`, `28-session-ids-before.json`, `29-server-restart.log`, `30-api-info.json`, `32-session-ids-after.json`, `33-installed-help.log`, `34-final-hashes.txt`, `35-final-service-status.log`, `36-final-pids.txt`.
- stopped after this handoff commit. no push, PR, merge into main, budget changes, broker restart or unrelated repair.

## integration trim execution status

- start `ffc88a504f8006baeb95a879978ec6d4afd97ea1`, branch `ui/redesign`, worktree `/home/almog/dev/wolfpack-ui-redesign`; only this worktree may be edited. trim proven dead/overridden UI only, preserve pixels, then approve failing caps with at most min(1%, 500 bytes) headroom in a separate budget commit. no push/PR/merge; no broker restart. server-only redeploy with `wolfpack.bak-pre-trim` and rollback on failed verification is authorized.
- status: trim/control removals, final cap lowering, full-gate reconciliation and server-only deployment complete. source/deploy head `e7bc9e1337a12890fe732ac299249e60b5371eac`; final caps `4abe9bcc` supersede `a04dc602`. final handoff below records raw gate failures and narrow test-only correction, not a green-suite claim. main/probe temporary worktrees removed; no unresolved new failures or user decisions. evidence `/tmp/wolfpack-redesign-logs/trim/verification-summary.md`. stop after documentation-only handoff commit; no push/PR/merge.
- reviewer: session `608def22-45c1-44e9-8fbb-629e4fbe2afd`, endpoint `cd0a610a-3ada-466f-9843-12894ca86e98`, explicit model in `reviewer-model`. read-only candidate task `41a75af2-d328-4fa5-9925-faf0ff611f87` and final-diff task `92232e62-9645-4ee7-a7b2-4f93e5f10f9e` completed and each acknowledged once. final review found no verified issues across 279 removed per-selector declarations / 78 groups, no unmatched live-code deletion; source hashes independently match. exact session closed with canonical CLI; first immediate list was stale, subsequent `20-sessions-after-review-verified.json` proves its UUID absent. no child sessions retained.
- additional read-only review: session `7e617406-41ed-48bd-88e4-558c6fa46069`, endpoint `f765ed92-2af9-470d-b3a7-e5c7a1522e2a`, task `a53a7b6b-9c44-479f-93de-46bc2a930a7f`, explicit configured reviewer model. reviewed the new user-approved removals with no verified findings; completed and acknowledged once. exact session closed before deployment; `46-controls-review-absence.json` proves UUID absent.
- gates requiring user: visible behavior changes beyond the two explicitly approved control removals, headroom above the stated rule, broker restart. none requested. commit boundary: logical trim/removal commits, separate budget approval or lowering follow-up, then short final handoff.

### final integration trim handoff

- commits: `d816b5cb` proven-dead/superseded trim; `67cac468` header Inspect removal; `7db5dfbf` accessory removals; `92cc7b53` bounded capture evidence; `a04dc602` provisional caps **superseded/lowered by `4abe9bcc`** after removals; `e7bc9e13` one obsolete Copy-session assertion removed. final handoff is docs-only; no push, PR or merge. no other worktree edited; task-owned temporary measurement/probe worktrees removed.
- changed production: `public/{styles.css,index.html,app.ts}`, generated `src/public-assets.ts`, and budget script. removed 17 searched dead selector families and only proven superseded/identical declarations; preserved generic widget headers, grid-marker base/state/hover/coarse rules, floating-card fallbacks, media/theme/motion/hidden rules and custom properties. proofs: `reviewer-candidates.md`, `reviewer-final.md`, `09-dead-selector-search.json`. both independent reviewers reported no verified findings; no child sessions retained.
- explicitly approved controls removed in separate commits; conflict-overlay inspection/sessionInspector, native selection copy, shared fetch helper and banner replies remain. removed only private git/copy/paste handlers and their now-unreachable feedback overlay. retained M1 focus/hit-test/byte assertions; ctrl popup reanchored after clipping was reproduced. new `chrome-controls.e2e.ts` asserts exactly the kept controls; `trim-preservation.e2e.ts` captures the required views. only removed-control assertions/button-copy test were deleted; unrelated assertions stay.

| raw/gzip bytes | main `909d5150` | before `ffc88a50` | final | saved | final caps |
| --- | --- | --- | --- | --- | --- |
| app | 327833/98000 | 338645/101218 | 335835/100662 | 2810/556 | 386000/101100 |
| CSS | 104051/18864 | 121634/22251 | 112770/20859 | 8864/1392 | 113200/21000 |
| Ghostty | 647559/188830 | same | same | 0/0 | 700000/210000 |

- budgets exit 0. only originally failing caps increased; final headrooms app gzip **438**, CSS raw **430**, CSS gzip **141**, each below min(1%,500 bytes). measurements, initial failure/main success, removed main worktree and numerical bound proof: `01-head-budgets.log`, `04-main-budgets.log`, `47-final-headroom.json`, `55-final-budgets.log` under `/tmp/wolfpack-redesign-logs/trim/`.
- visual evidence: 8 pairs at 1440/390 (dashboard, terminal, grid markers, pinned). initial trim had 0 changed pixels/styles throughout. final removals: **0 pixels or captured style changes outside the approved header/accessory regions**; 2164 changed pixels in desktop terminal header, 145444 each in mobile terminal/grid accessory; other five images identical. `before/`, `after-controls/`, `44-final-pixel-comparison.json`. mobile grid is entered through existing desktop controls then resized; this is responsive-state evidence, not a new mobile grid-entry feature.
- final full gate once at clean `4abe9bcc`: assets/no-diff/typecheck/budgets all **0**; full Bun **1**, 3655 pass / 8 skip / known #461 only, 324s; full default Playwright **1**, 807 pass / 457 skip / 59 fail, 1324s. all 56 supplied baseline failures recur with matching assertion signatures. extra widget x=-31 reproduced on untouched pre-trim `ffc88a50` in 3/3 warm-file runs (cold isolated 10/10 passed); two extra mobile cases were the obsolete Copy expectation, corrected test-only in `e7bc9e13`, then both passed. **zero unresolved new failures**, not a green full-suite claim. no full rerun to hide failures; production bytes/full Bun inputs unchanged by the test-only fix. fresh assets/no-diff/typecheck/budget checks on e7bc9e13 all **0**. evidence `22–28` logs/results, `48-final-baseline-comparison.json`, `50-retained-mobile-shell.log`, `52-base-extensions-warm.json`, `53-widget-baseline-signatures.json`, `54-final-reconciliation.json`, `55-*`.
- deploy **0** from clean e7bc9e13 using the prior recipe, `WOLFPACK_BUILD_SERVER_ONLY=1 bun run scripts/build.ts` (**0**, 1s), independent backup `/home/almog/.wolfpack/bin/wolfpack.bak-pre-trim`, atomic replacement and `service restart --server-only`. server **1858055→2063469**, broker **2051 unchanged** (binary hash unchanged too), exact **3/3 UUIDs preserved**, `/api/info` v1.6.26 and both CLI help checks **0**. built/served JS SHA `5b8a887bd3f496147f3eea439a45b0c8f53cb4e80651383abdd2ea9659ca1744`, CSS `95dc8cf453abd55b77731233d37cb5e64603eca65d7f434f762527597d33f747`; installed equals built, backup equals original. rollback prepared but not needed; deploy lock released. receipts `deploy-result.txt`, `56-deploy.result`, `57-final-service-status.log`, `58-final-evidence.json`.
- full evidence/commands/revisions: `/tmp/wolfpack-redesign-logs/trim/verification-summary.md`. static design scans retained exit-2 warnings; no unrelated visual changes to silence them. default WebKit has the same 27 missing-library launch failures, no libraries installed; physical iOS remains unverified. no server/broker/transport/auth/semantic-state/lockfile changes. stop after the local handoff commit.

## final review follow-ups + server-only redeploy

- start `ce6235fe`; read all intervening trim commits first. `da8cb42a` restores direct server coverage for **R1**: five real HTTP handler tests with an isolated backend verify Unicode/multiline/empty/selected snapshots, plain text/no ESC, content type/no-store and 400/404 validation. the production `/api/copy-text` route and schema are unchanged. **R2/R3/R4** commit `4ff7981f173b6ad73cd4dbb6c86b9117187711d8` removes only the unreachable transcript fetch/show/close chain, its exclusive markup/listeners/selectors, `.error-pre` and `--git-accent`; retained inspector declarations/clipboard behavior remain. accessory now has two equal rows of five, 42px targets, with centered ctrl popup; retained key order/bytes are unchanged. no cap, broker, auth, transport, dependency or lockfile edits; protected diff empty.
- valid pre-fix red: `02-red.log`, exit 1, three failures (two layout widths + orphan dialog), one retained key-byte pass. R1 characterization on unchanged route: `01-copy-characterization.log`, exit 0, five pass. source grep found the R3 names only at definitions before removal; final public source has no transcript/helper/R3 references.
- final checks all **0**: assets (`17-final-assets.log`), typecheck (`18-final-types.log`), budgets (`19-final-budgets.log`), focused copy-route/backend/app-shell units **181 pass** (`20-final-unit.log`), mobile-accessory/chrome-controls/reskin desktop+iphone-14 **19 pass/13 skip** (`21-final-browser.log`), retained inspector cases **3 pass/5 skip** (`22-retained-inspector.log`). sizes shrink from app335835/100662 to **335688/100609**, CSS112770/20859 to **112269/20776** raw/gzip; Ghostty unchanged647559/188830. existing caps unchanged. full evidence under `/tmp/wolfpack-redesign-logs/final-fixes/`.
- layout assertions cover exact 5+5 ordering, equal widths, 42px heights, component/document scroll widths and popup viewport bounds at375/390, actual ^A and all retained key bytes/native Enter behavior. temporary diagnostics were removed. probes also found baseline `#view-container` entry-focus scrollLeft17 with old CSS (`11-baseline-focus-probe.log`); this unrelated pre-existing navigation offset was not changed. assertions measure accessory-local containment rather than claiming that global offset is fixed. no full suite/WebKit/device claim; static design warnings retained without unrelated changes.
- tested/built/deployed clean `4ff7981f`; final handoff commit is documentation-only. build/deploy exit **0/0**, backup `/home/almog/.wolfpack/bin/wolfpack.bak-pre-final-fixes`; atomic replacement and explicit `service restart --server-only`. server **2063469→2179989**, broker **2051 unchanged**, exact **2/2 UUIDs preserved**; API and both installed help commands pass. JS built/served SHA both `1080a37c21f5d130ca706fc5541abfd0c41f330825eeae7b799394746929e07d`; CSS both `77b2758859599bf3215f1f0425e424630f82cab0ff9f474b90ccf8d4bda44f28`. backup equals original installed hash; new installed hash `89652f4c1b2d121001b0da61794be4941a6441cc4c330d677550c894d70856c8`. receipts `deploy-result.txt`, `27-server-only-build-result.txt`, `34-final-pids.txt`, `35-final-hashes.txt`; rollback not needed, owned lock removed.
- stopped after this handoff commit. no push/PR or broker restart.
