# delegation grid ux implementation plan

status: implemented and verified — task_9e9ffe0aaedf4f9f997b927cf0e4b9c0; reviewer approved in task_be9431446dbd4f5f822f831a93aa1198
mock: `.plans/delegation-grid-ux-mock.html`
base branch: latest `main`
proposed branch: `225-delegation-grid-ux`

implementation notes:
- uses an ephemeral delegation workspace, separate from manual `gridSessions`
- preserves/suspends manual grids before delegation grid or direct child focus
- applies the same isolated terminal wasm gate as manual grid mode
- collapsed child cells suspend terminal controllers instead of shrinking live ptys
- unchanged session polling updates status/membership without unnecessary cell relayout churn

verification:
- `bun test tests/unit/delegation-sessions.test.ts` — 6 pass
- `bun run typecheck` — pass
- `bunx playwright test tests/e2e/ux-navigation.e2e.ts --project=desktop` — 14 pass
- `bunx playwright test tests/e2e/grid.e2e.ts --project=desktop` — 22 pass
- `git diff --check` — pass
- `bun test` — 1901 pass, 22 skip, 0 fail

## goal

when a user opens a parent session with child agents, wolfpack should present an ephemeral delegation workspace: parent + child terminals in a grid, with a way to focus any terminal fullscreen and return to the same grid.

this must feel native to wolfpack, not like the standalone mock:
- keep the wolfpack logo and app chrome
- keep existing terminology: `sessions`, `child agents`, `terminal`, `grid`
- use existing status/triage badges and terminal loading language
- reuse current desktop grid/terminal visual system where practical

## non-goals

- no ralph-specific UX work
- no saved/named grid changes
- no mutation of manual `gridSessions` just because a delegation grid is opened
- no terminal text parsing
- no string matching on `*-sub-agent`
- no redesign of the whole session dashboard
- no mobile-first redesign in v1; mobile may gracefully fall back to focused terminal/list behavior

## assumptions to confirm before implementation

1. clicking a parent session with children opens the delegation grid immediately.
2. clicking a child session opens that child fullscreen, with a visible way to return to its parent delegation grid.
3. clicking a session with no children keeps current fullscreen terminal behavior.
4. delegation grid membership is derived from structured session identity (`identity.parentSession`) and current `/api/sessions`, not persisted.
5. the existing wolfpack logo/chrome remains the app identity; the mock's fake branding is only directional.
6. terminology should be user-facing as `child agents` or `child sessions`, not `subagents` unless existing UI already says it.

## design decisions

### view model

add an ephemeral delegation workspace view separate from manual grid state.

suggested state shape:

```ts
type ActiveView =
  | { kind: "session"; sessionName: string; machineUrl?: string }
  | { kind: "delegation-grid"; rootSessionName: string; machineUrl?: string }
  | { kind: "delegation-focus"; rootSessionName: string; focusedSessionName: string; machineUrl?: string };
```

implementation can be smaller if current app state prefers separate fields:
- `activeDelegationRoot`
- `focusedDelegationSession`
- `returnToDelegationGrid`

hard rule: do not use manual `gridSessions` as source of truth for delegation grid membership.

### data source

reuse the #200 projection in `public/delegation-sessions.ts`:
- root rows know `role`, `depth`, `parent`, `childSummary`
- children are ordered by runtime attention state and stable names
- orphan handling remains explicit

needed addition, if not already ergonomic:
- helper to get a root row's recursive descendants as renderable terminal members
- helper to resolve a child to its nearest known parent/root for `show parent grid`

### desktop behavior

session dashboard:
- parent card with children: click opens delegation grid
- child card: click opens focused child terminal
- child card may show a compact action: `show grid` only if design needs discoverability
- session with no children: unchanged

within delegation grid:
- parent terminal first
- children after parent, preserving #200 attention ordering
- parent and children use existing terminal/grid cell styling
- child cells are collapsible
- default collapse policy:
  - <= 4 total sessions: expand all
  - > 4 total sessions: collapse idle children, keep `needs input` and `running/recent output` expanded
- grid header shows:
  - wolfpack logo/app chrome preserved globally
  - `delegation grid`
  - root session name
  - existing child summary text
  - actions: `collapse idle`, `expand all`, `focus parent`, `exit grid`

focus mode:
- fullscreen existing terminal view for selected member
- top/back affordance: `back to delegation grid`
- escape returns to delegation grid when focus came from delegation grid
- optional member strip can exist later; v1 can use only back + grid button

### styling constraints

translate mock ideas into existing app style:
- use `/wolfpack-icon.svg` via existing logo/empty-state patterns
- use current CSS variables and card styles from `public/styles.css`
- use existing `.triage-badge` variants instead of inventing new badge colors
- use existing `#desktop-grid-container`, `.grid-cell`, terminal loading states, and toolbar button styles where practical
- keep current dark compact density; avoid large glassy panels from the mock if they clash
- preserve existing labels like `terminal`, `session`, `grid`, `needs input`, `running`, `idle`

new css should be narrow and named for delegation, e.g.:
- `.delegation-grid-shell`
- `.delegation-grid-header`
- `.delegation-grid-cell`
- `.delegation-grid-cell.collapsed`
- `.delegation-focus-return`

### accessibility / keyboard

- escape from focused delegation terminal returns to delegation grid
- escape from grid exits to session list only if that matches current desktop navigation semantics
- buttons must be real buttons, not clickable divs
- collapsed cells must retain session name, status, and focus button
- focus button labels should include session name for screen readers if practical

## implementation phases

### phase 0 — branch and baseline

- create branch from latest main:
  - `git fetch origin main:main`
  - `git checkout -b delegation-grid-ux main`
- ensure #200 PR/branch state is either merged or explicitly included/rebased, because this plan depends on `public/delegation-sessions.ts`.
- run baseline focused tests before edits:
  - `bun test tests/unit/delegation-sessions.test.ts`
  - `bunx playwright test tests/e2e/ux-navigation.e2e.ts --project=desktop`

### phase 1 — tests first

add failing tests before production changes.

unit tests:
- projection/helper returns parent + recursive children for delegation grid members
- resolving child returns parent/root for `show grid`
- disappearing child is absent on next projection
- orphan child does not silently attach to a fake grid

browser/e2e tests:
- clicking parent card opens delegation grid with parent + children
- clicking child card opens focused child terminal with return-to-grid affordance
- `back to delegation grid` returns to the same parent grid
- escape from focused child returns to grid
- manual grid sessions are unchanged after opening delegation grid
- new child appearing in `/api/sessions` is reflected in grid after refresh/poll
- removed child disappears from grid without breaking focus state

### phase 2 — view state

- add minimal delegation view state to `public/app-state.ts` or existing app state location.
- do not overload `gridSessions`.
- add functions:
  - `openDelegationGrid(rootSession, machineUrl?)`
  - `focusDelegationSession(rootSession, focusedSession, machineUrl?)`
  - `returnToDelegationGrid()`
  - `exitDelegationGrid()`
- wire session card click behavior:
  - parent with children -> `openDelegationGrid`
  - child -> current open/focus plus optional parent grid return context
  - normal session -> existing behavior

### phase 3 — rendering

- render delegation grid using existing desktop terminal/grid components where possible.
- add collapsed cell rendering.
- add grid header with root name and child summary.
- add focus mode top/back affordance without changing normal terminal entry.
- preserve existing terminal lifecycle/reconnect/take-control behavior.

### phase 4 — styling polish

- replace mock-specific look with wolfpack-native styling.
- keep current logo and app chrome.
- use existing `.triage-badge` and card density.
- add only small delegation-specific css.
- verify visually against:
  - session dashboard
  - existing manual desktop grid
  - focused terminal view

### phase 5 — verification

focused:
- `bun test tests/unit/delegation-sessions.test.ts`
- `bun run typecheck`
- `bunx playwright test tests/e2e/ux-navigation.e2e.ts --project=desktop`
- `git diff --check`

full before merge/deploy:
- `bun test`
- if browser assets changed: `bun run scripts/gen-assets.ts`
- if deploying: `scripts/deploy-local.sh --broker=no` unless broker code changed

## implementation verification

- `bun test`: 1901 passed, 22 skipped, 0 failed
- `bun run typecheck`: passed
- `bunx playwright test tests/e2e/ux-navigation.e2e.ts --project=desktop`: 11 passed
- `bunx playwright test tests/e2e/grid.e2e.ts --project=desktop`: 22 passed
- `git diff --check`: passed
- browser assets regenerated with `bun run scripts/gen-assets.ts`

## risks / watchpoints

- existing manual grid state may be tempting to reuse; doing so risks corrupting user-created grids.
- terminal lifecycle code is sensitive; reuse existing terminal mount paths instead of creating a parallel terminal runtime.
- focus/back behavior can conflict with existing escape/back navigation; tests must pin expected behavior.
- multi-machine parent/child relationships should stay within the same machine unless structured data explicitly supports cross-machine parentage.
- if #200 is not merged first, implementation will need to include/rebase the delegation projection changes.

## acceptance criteria

- parent click opens a wolfpack-styled delegation grid with parent + child agent terminals.
- child click can focus fullscreen and return to grid.
- grid membership updates from structured session identity.
- manual grid sessions are not modified.
- styling matches wolfpack's existing logo, terminology, density, badges, and terminal chrome.
- focused and full test suites pass before merge.
