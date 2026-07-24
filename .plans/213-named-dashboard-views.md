# issue #213 — persistent named dashboard views

status: completed
branch: `213-named-dashboard-views`
base: `main` @ `4dbe7fcc7fcdc7c98e12298f6ca4dddbb72ad37e`
issue: https://github.com/almogdepaz/wolfpack/issues/213

## goal

users can persist an explicitly ordered composition of stable local/peer session identities, reopen it from another admitted browser, and retain unavailable members without coupling semantic view state to terminal/rendering state.

## ownership boundary

Wolfpack server owns:

- named-view records, schema version, validation, timestamps, and durable storage
- authenticated CRUD contracts
- opaque stable session reference fields supplied by admitted clients

browser owns:

- resolving stored references against currently loaded local/peer session identities
- desktop grid versus mobile member-list presentation
- terminal mounting, hydration, resize, reconnect, and take-control state machines

neither layer may:

- treat terminal names as identity
- persist Ghostty/WebSocket/controller/canvas/viewport state
- infer availability from project names or terminal output
- implement saved filters/tags from #198

## behavioral acceptance criteria

### record and persistence

- [x] a record has schema version, server-generated opaque id, validated name, ordered members, optional focused reference, and server-owned created/updated timestamps
- [x] each member includes stable `sessionId`, last-known `sessionName` display hint, and `machineUrl` (`""` for local; validated peer URL otherwise); name is never sufficient for matching
- [x] views contain 1–6 unique `(machineUrl, sessionId)` members; focused reference must identify one member
- [x] names are trimmed, 1–64 Unicode code points, control-character free, and case-insensitively unique
- [x] ids/session ids/session names/machine URLs and collection size are bounded; unknown fields and malformed shapes fail closed
- [x] storage is an atomic versioned JSON file under Wolfpack’s existing `.wolfpack` persistence boundary and survives Bun restart
- [x] missing file means an empty collection; malformed/unreadable persistence is never silently overwritten

### authenticated API/schema

- [x] authenticated list/create/update/delete routes expose deterministic JSON envelopes
- [x] create generates id/timestamps; update preserves id/createdAt and advances updatedAt; delete is explicit by id
- [x] unknown ids return 404; duplicate names return 409; invalid input returns bounded 400 errors
- [x] control API source, generated artifact, snapshot, runtime compatibility tests, and JWT route coverage agree

### browser behavior

- [x] desktop can save the active 2–6 cell grid, list/open views, update from the current grid, duplicate with a new name, and delete
- [x] opening resolves members only by `(machineUrl, sessionId)` against current structured session identities
- [x] same-name replacement with a different stable id remains unavailable
- [x] desktop preserves stored order and focus; live members reuse the current grid terminal state machine
- [x] unavailable members render as explicit non-terminal slots and never attempt PTY/WebSocket attach
- [x] mobile presents the same ordered semantic members as a list; tapping a live member opens the existing single-terminal flow, unavailable members remain visible/disabled
- [x] management state is fetched from the server, not localStorage; another browser sees saved changes after refetch/reload
- [x] unsaved grid add/remove/focus/suspend/reconnect/take-control behavior remains unchanged

## decisions

1. **bounded by existing grid capacity:** named views use 1–6 members; no new layout engine.
2. **stable composite member key:** `(machineUrl, sessionId)` is authoritative. `sessionName` is only a last-known label.
3. **peer URL trust boundary:** server and browser must share one validated machine-URL rule before persisted peer URLs can drive authenticated fetch/WS calls. extraction of the existing browser validator is allowed only as required to avoid a second protocol.
4. **single server file:** use one local versioned collection; no database, sync service, or event stream.
5. **REST surface:** `GET/POST/PUT/DELETE /api/named-views`; update/delete carry the immutable view id in strict JSON bodies because the route table is exact-path based.
6. **duplicate is create:** browser duplicates by creating the same ordered composition under a new validated name; no separate server action.
7. **no migration fiction:** schema v1 has no predecessor. test missing-file initialization and malformed/future-version refusal; do not invent legacy formats.
8. **no terminal-state redesign:** unavailable-slot handling is a guarded branch around existing grid mounting, not another controller/hydration implementation.

## milestones

### m1 — domain, persistence, API, schema

status: completed
owner: one server/domain implementer

- [x] write failing contract/store/API/schema/auth tests
- [x] add shared named-view contract and required machine URL validation ownership
- [x] add atomic persistence store and test isolation hooks/path
- [x] add strict authenticated CRUD routes
- [x] update generated control API artifact/snapshot and concise docs
- [x] focused verification green
- [x] fresh `edc-delivery-review`
- [x] fresh `edc-review` for validation, filesystem, auth, and persisted peer URL trust boundary

### m2 — browser desktop/mobile integration

status: completed
owner: issue #213 browser/grid implementation worker

- [x] write failing UI/grid/E2E tests first
- [x] add minimal named-view management surface
- [x] save/update/duplicate/delete through server API
- [x] resolve stable members and render desktop grid/mobile list
- [x] preserve unavailable ordered slots without PTY attach
- [x] verify unsaved-grid/hydration/take-control regressions
- [x] fresh `edc-delivery-review`
- [x] `edc-review` for server-controlled DOM/URL/auth flows
- [x] `antipattern-scan` only if app/grid changes add meaningful complexity

### m3 — holistic acceptance

status: completed
owner: orchestrator/reviewer

- [x] map every acceptance criterion to code/test evidence
- [x] resolve blocking delivery/security/maintainability findings, max two review/fix rounds per root cause
- [x] run fresh focused tests, browser tests, typecheck/build, full suite, schema determinism, and `git diff --check`
- [x] final holistic `edc-delivery-review`
- [x] document completed/deferred/intentionally omitted work

## baseline evidence

- repository instructions, EDC routing manifest, and server/browser/terminal/core/tests/docs modules read
- issue fetched via `gh issue view 213 --json number,title,body,labels,state,url`
- relevant history/blame inspected for grid, identity persistence, API schema, browser state, and E2E behavior
- focused baseline: 232 pass, 0 fail; schema snapshot current
- baseline typecheck: pass
- baseline `git diff --check`: pass

## risks

- persisted peer URLs can become a bearer-token exfiltration vector if validation drifts between server and browser
- missing-member placeholders must not enter controller/hydration paths
- `public/app.ts` is already a mixed orchestration hub; keep named-view logic in a focused browser module and inject only existing dependencies
- async peer loading must not silently reorder members or substitute names for stable ids
- malformed persistence must fail visibly without destroying operator data

## deferred / intentionally omitted

- saved queries, tags, folders, or dynamic membership (#198)
- pixel/grid geometry persistence
- live cross-client push updates; reload/refetch is sufficient
- per-user ownership/sharing ACLs
- more than six members or a new grid layout engine
- migration from nonexistent pre-v1 named-view formats

## implementation log

- 2026-07-24: source of truth established; isolated branch created from current main; baseline verified; stale visual-only worker cancelled.
- 2026-07-24: m1 red command recorded and observed before production code: `bun test tests/unit/named-views.test.ts tests/integration/api.test.ts tests/integration/auth-middleware.test.ts tests/unit/control-api-schema.test.ts tests/integration/control-api-schema-contract.test.ts` failed for missing `src/named-views.ts`, missing `src/server/named-view-store.ts`, missing `listNamedViews` schema operation, and 404 `/api/named-views` runtime response.
- 2026-07-24: m1 green focused verification: `bun run gen:schema && bun run typecheck && bun test tests/unit/named-views.test.ts && bun test tests/integration/api.test.ts -t "/api/named-views|OPTIONS preflight" && bun test tests/integration/auth-middleware.test.ts && bun test tests/unit/control-api-schema.test.ts tests/integration/control-api-schema-contract.test.ts && git diff --check` passed.
- 2026-07-24: full `bun test` passed with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false` to neutralize local global GPG signing in tests that create temporary git commits: 1830 pass, 21 skip, 0 fail.
- 2026-07-24: fresh EDC delivery/security reviews written under ignored local artifacts `edc-context/reports/213-m1-delivery-review.md` and `edc-context/reports/213-m1-security-review.md`; no findings.
- 2026-07-24: m1 blocking review fix red evidence: after adding real filesystem write-failure regressions, `bun test tests/unit/named-views.test.ts -t "filesystem write failures"` failed with raw `EACCES` instead of `NamedViewPersistenceWriteError`, and `bun test tests/integration/api.test.ts -t "persistence write failures"` failed because POST returned 400 instead of bounded 500 `PERSISTENCE_UNAVAILABLE`.
- 2026-07-24: m1 blocking review fix green evidence: `bun run typecheck && bun test tests/unit/named-views.test.ts && bun test tests/integration/api.test.ts -t "/api/named-views|OPTIONS preflight" && git diff --check` passed.
- 2026-07-24: orchestrator reran focused m1 verification (173 pass, 0 fail), confirmed the write-error finding resolved, and accepted m1 with delivery `delivered`, architecture `fits`, security `APPROVE`.
- 2026-07-24: m2 red evidence before production code: `bun test tests/unit/app-named-views.test.ts` failed because `../../public/app-named-views.ts` did not exist; `bunx playwright test tests/e2e/named-views.e2e.ts --project=desktop --grep "desktop saves"` failed because `saveNamedViewFromActiveGrid` was not defined on `window`.
- 2026-07-24: m2 implementation added `public/app-named-views.ts`, thin `public/app.ts` wiring, named-view sidebar/mobile rendering, desktop CRUD actions, stable `(machineUrl, sessionId)` resolution, ordered/focused grid composition, and explicit unavailable grid slots that skip PTY controller mount.
- 2026-07-24: m2 focused green evidence: `bun run scripts/gen-assets.ts && bun run typecheck && bun test tests/unit/app-named-views.test.ts && bunx playwright test tests/e2e/named-views.e2e.ts --project=desktop --project=iphone-se` passed (2 unit pass; 2 E2E pass, 2 expected project skips).
- 2026-07-24: m2 grid regression evidence: `bunx playwright test tests/e2e/grid.e2e.ts --project=desktop` passed (22/22).
- 2026-07-24: m2 broader verification: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test` passed (1834 pass, 21 skip, 0 fail); `git diff --check` passed.
- 2026-07-24: m2 blocker-fix red evidence before production changes: `bun test tests/unit/grid-logic.test.ts --test-name-pattern "named-view stable identity"` failed because `suspendGridState`/`resumeGridState` dropped `_namedViewSessionId`, `_namedViewLabel`, and `_namedViewUnavailable`; `bunx playwright test tests/e2e/named-views.e2e.ts --project=desktop --grep "suspend/restore|only live"` failed because preserved grid state lost named metadata and removing the live cell restored/attached stale `another-project` as a solo terminal.
- 2026-07-24: m2 blocker fix preserved named-view stable metadata through `src/grid-logic.ts` clones and `public/app-grid.ts` restore, added stable ids to live named-grid entries, guarded named cells against stale same-name replacements before controller mount, and made unavailable-only collapse clear selection/return to sessions without solo `initTerminal`.
- 2026-07-24: m2 blocker-fix focused green evidence: `bun run scripts/gen-assets.ts`; `bun run typecheck` passed; `bun test tests/unit/grid-logic.test.ts --test-name-pattern "named-view stable identity"` passed (2 pass); `bunx playwright test tests/e2e/named-views.e2e.ts --project=desktop --grep "suspend/restore|only live"` passed (2 pass); CRUD/reload/second-page E2E `--grep "update duplicate delete"` passed.
- 2026-07-24: m2 blocker-fix acceptance verification: `bun test tests/unit/named-views.test.ts tests/unit/app-named-views.test.ts tests/unit/grid-logic.test.ts` passed (75 pass); `bunx playwright test tests/e2e/named-views.e2e.ts --project=desktop --project=iphone-se` passed (5 pass, 5 expected skips); `bunx playwright test tests/e2e/grid.e2e.ts --project=desktop` passed (22 pass); `git diff --check` passed.
- 2026-07-24: orchestrator post-fix review accepted m2: delivery `delivered`, architecture `fits`, security `APPROVE`, differential antipattern findings 0; fresh focused verification reproduced 75 unit, 5 named-view E2E, 22 grid E2E, deterministic assets, typecheck, and diff-check success.
- 2026-07-24: final full Bun suite passed: 1836 pass, 21 broker-unavailable skip markers, 0 fail; after release broker build, all 13 substantive real-broker integration cases passed.
- 2026-07-24: final Playwright evidence passed: named views 5 pass/5 expected device skips, existing grid 22 pass, UX navigation 9 pass/7 expected device skips.
- 2026-07-24: real two-process server restart smoke preserved the exact named-view id/record; full four-target build passed; schema/assets were deterministic; final `git diff --check` passed.
- 2026-07-24: final holistic EDC delivery review: delivery `delivered`, architecture `fits`, no unresolved findings. m1/m2 security reviews both `APPROVE`; differential antipattern findings 0.

## final artifact evidence

- control API schema SHA-256: `e8ec30302d77f0f11d0cb9997cfcfe79327790a1b327a1a36e436a0fb96504bc`
- control API snapshot SHA-256: `be1e08faa28cca3843cc1154d73f12cb4ecc7f223d95e24c05145e0885a70e5f`
- embedded public assets SHA-256: `af5d5859c8cb4c89a190b2572ef1ae9edc3d2dadba79d90cec054230c34e3220`
- browser client bundle SHA-256: `af341f16962ec3b4fb0e91f583eb447986ab94578c8feec3b2775f870bdfb265`

## completed

- versioned server-owned named-view contract and atomic persistence
- authenticated CRUD API plus generated public schema/docs
- desktop named-view save/open/update/duplicate/delete
- mobile ordered semantic member list
- stable identity resolution and explicit unavailable slots across grid lifecycle
- cross-page sharing, reload, restart, and regression coverage

## residual risks

- live multi-host Tailscale peer behavior was not exercised end-to-end; strict URL/identity contracts and browser fixtures cover the boundary
- management uses native prompt/confirm dialogs by design; richer visual tooling is outside #213
