# Phase 1 workspace implementation

- **Base:** `345552eda3e4a489a9905b8a8278418a06deb150`
- **Implementation candidate:** `1e19258b8b0cc058d9898102b84a026a5d742ffe`
- **Worktree/branch:** `/Users/almog/Dev/wolfpack-ui-extensions-workspace` / `feat/ui-extensions-workspace`

## Delivered

- Host-only `workspace-shell` with browser-local bounded split preferences, left/right/bottom placement, collapse, full-context/full-terminal modes, and a persistent accessible restore control. The context container only says that enabled views appear there; it contains no fake extension/tab/data implementation.
- `TerminalLayoutRegistry` host seam using the approved `layout-contract` helpers: equal-grid default, explicit persisted Lead + stack / vertical selection, narrow viewport vertical recovery, finite geometry validation fallback, CSS-only placement, and visual-geometry keyboard neighbor helper.
- Narrow app/grid integration applies geometry to stable existing cells and uses the existing ordered resize settlement. It never attaches/takes control/focuses on a layout setting change. Collapsing a delegation child now retains its controller/canvas/socket/buffer and excludes hidden zero-size geometry from resize.
- Browser coverage includes explicit desktop shell/layout/focus/retention and mobile WebKit recovery with mock PTY routes. A real-broker test suite is included in the desktop and mobile-WebKit project filters but is intentionally blocked when no broker binary is present in this worktree.

## Changed files

- `public/terminal-layout-registry.ts`
- `public/workspace-shell.ts`
- `public/app-grid.ts`
- `public/app.ts`
- `public/index.html`
- `public/styles.css`
- `tests/unit/workspace-layout.test.ts`
- `tests/e2e/delegation-sessions.e2e.ts`
- `tests/e2e/workspace-layout-broker.e2e.ts`
- `playwright.config.ts`

## Verification

- Red retention regression: exact temporary export of base `345552e`, with the new retention assertion, failed as expected: collapsed child closed its socket (`Expected 0, Received 1`), run `717728c0-d02d-4d3c-b792-b95e769dc93f` (temporary export removed).
- Fixed desktop mocked browser suite: `bun run scripts/gen-assets.ts && bunx playwright test tests/e2e/delegation-sessions.e2e.ts --project=desktop` — **12 passed**, run `42c3671a-c68c-4267-919d-a4fb278a08a1`.
- Fixed mobile WebKit mocked recovery: with `PLAYWRIGHT_BROWSERS_PATH=/private/tmp/wolfpack-ui-extensions-browsers.DiZa4x`, same generated-source command for `--project=mobile-webkit` — **1 passed**, run `f367fa24-229b-4169-91c8-21ab187ff445`.
- Unit/layout/lifecycle + typecheck/context: **13 passed / 0 failed / 0 skipped**, run `48ea0982-6ab7-472e-b96f-c0c7b0a2053c`.
- Final clean candidate broad `bun test tests/unit/ tests/snapshot/`: **2045 passed / 0 failed / 1 skipped** (macOS no-controlling-TTY release staging fixture), 126.44s, run `0b231a10-68c4-4534-af48-2414ae6196b9`.

## Retained gates / gaps

- **BLOCKED real broker:** `workspace-layout-broker.e2e.ts` is project-included but **3 skipped** because the worktree has no broker binary and the only binaries outside it were explicitly not yet authorized/proven compatible. Run `727f60f1-36ec-4f7c-87ee-4057325e8731`. No mocked result is presented as broker evidence.
- **FAILED generated budget:** `bun run scripts/gen-assets.ts && bun run check:bundle-budgets` generated source assets but failed: app bundle `347016 raw / 85246 gzip` vs `335000 / 85000`, stylesheet `100603 raw` vs `100000`; run `89a668a9-db71-4df2-bfa3-94c8018ef554`. Generated `src/public-assets.ts` was restored and not committed. The fixed budget permits about 3.9KB over the exact-base app bundle (331067 raw), while this Phase-1 code adds about 15.9KB. No budget/script adjustment was made in this lane.
- Explicit destructive remove, ended, displaced, and focused single-terminal transitions remain destructive by design; the retention guarantee only covers geometry and reversible hide/restore paths.
