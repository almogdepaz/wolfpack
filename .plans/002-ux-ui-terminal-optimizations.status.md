# ux/ui and terminal optimizations execution status

- plan: `.plans/002-ux-ui-terminal-optimizations.md`
- sha-256: `ef2755579b379b40344a7e0a476ca5f04f9be58e82d8464a6b1473ea73ba0d81`
- branch: `feat/ux-ui-terminal-optimizations`
- overall: `in_progress`
- current phase: task 3 — operator workflow

## goal-lock

- direct contribution: keep session-state presentation truthful and source-backed while continuing task 3 workflows
- source of truth: browser view state, typed runtime state, existing terminal/broker snapshots, and structured API responses
- preserved boundaries: broker authority, terminal attach/hydration/resize contracts, no prose inference
- blocked audit item: T1 remains in `.plans/background-tab-rendering.md` pending representative trace and remediation decision

## task states

- 1: `implemented`
- 2: `implemented`
- 3: `in_progress`
- 4: `not_started`
- 5: `not_started`

## inherited work

- `.plans/001-ui-polish.md`: landed on `main` in `d53750d`; latest main was merged before the task 3 checkpoint
- do not overwrite or duplicate its shell/control/density changes

## verification

- branch base updated to `main` at `d53750d`
- plan digest confirmed before tasks 1, 2, and 3
- task 1 red: desktop/mobile accessibility contracts failed for inactive-view focus, missing status semantics, zoom suppression, missing 18px preset, and missing transcript
- task 1 green: `bunx playwright test tests/e2e/accessibility-navigation.e2e.ts` — 13 passed, 2 platform skips
- inherited polish regression: `bunx playwright test tests/e2e/ui-polish.e2e.ts` — 5 passed, 7 platform skips
- task 1 typecheck: `bun run typecheck` passed
- task 2 red: static delivery contracts failed with no compression, validators, versioned URLs, or immutable caching; resume-cadence test measured 3 `/api/sessions` requests in 5.5 seconds; metadata failure erased session cards
- task 2 green: `bun test tests/integration/static-assets.test.ts tests/integration/csp.test.ts` — 9 passed
- task 2 refresh: `bunx playwright test tests/e2e/refresh-coordinator.e2e.ts --project=desktop` — 4 passed; concurrent refreshes produced one request, machine metadata stayed cached, and visibility resume produced at most two requests over one interval
- task 2 browser regression: accessibility + smoke — 25 passed, 2 platform skips; mobile terminal — 2 passed, 1 skip
- task 2 perf: one measured full harness run with 0 console errors, 120ms FCP, two prewarm-ready terminals, 160ms single-terminal reveal, 0.3ms Ghostty creation, and a prewarm hit; report retained at `/tmp/wolfpack-perf-after.txt`
- task 2 typecheck: `bun run typecheck` passed
- task 3 attention red: no attention count/filter, unseen marker, exact-transition acknowledgement on open, or explicit/bulk clear action
- task 3 attention green: `bunx playwright test tests/e2e/attention-workflow.e2e.ts --project=desktop` — 4 passed
- task 3 correction decision: user explicitly superseded the attention visualization after live use showed that ordinary sessions cannot emit semantic `needs-input` state; immutable plan remains unchanged
- task 3 correction evidence: all 5 live sessions exposed only source-backed `screen-fallback` `output`/`idle`, and no inspected project had `.wolfpack/agent-status.json`; bare runtime state objects were nevertheless rendered as semantic claims
- task 3 correction red: browser contracts found the attention toolbar/markers and open-time acknowledgement; UI projection accepted unproven semantic state; delegation summaries retained uncleared `done unseen`; human CLI and push labels called observed quiet state `idle`/`Stopped`
- task 3 correction green: attention presentation and acknowledgement side effects removed; child summaries are count-only and alphabetically stable; semantic badges require matching source/authority/freshness; observed states render as `output`/`quiet`; broker uncertainty renders as `unavailable`
- task 3 correction focused unit: shared status contract, runtime UI, delegation projection, push labels, and CLI list — 67 passed, 0 failed
- task 3 correction browser: session-state visualization across all projects — 9 passed; desktop UX/delegation focused run had one pre-existing hover-edge timing failure, then its exact test and the full browser regression both passed
- task 3 correction typecheck: `bun run typecheck` passed
- task 3 correction full unit/integration: `bun test` — 1433 passed, 0 failed
- task 3 correction browser regression excluding the two recorded main-baseline terminal contracts — 166 passed, 155 platform skips, 0 failed
- latest-main conflict resolution: desktop accessibility, attention, and updated UI-polish contracts — 10 passed, 3 platform skips; static/CSP integration — 9 passed; typecheck passed
- checkpoint full unit/integration: `bun test` — 1427 passed, 0 failed
- checkpoint browser suite excluding two main-baseline terminal contracts — 169 passed, 155 platform skips, 0 failed
- baseline browser gaps reproduced on clean `main` `d53750d`: final-column canvas assertion and grid snapshot persistence; the final-column assertion accounts for one failure in each browser project. No workaround was added; these remain on the blocked terminal-correctness track.

## changed files

- `.plans/002-ux-ui-terminal-optimizations.md`
- `.plans/002-ux-ui-terminal-optimizations.status.md`
- `public/app-state.ts`
- `public/app.ts`
- `public/delegation-sessions.ts`
- `public/index.html`
- `public/styles.css`
- `scripts/gen-assets.ts`
- `src/agent-runtime-ui.ts`
- `src/cli/sessions.ts`
- `src/public-assets.ts`
- `src/server/http.ts`
- `src/server/index.ts`
- `src/server/push.ts`
- `src/server/routes.ts`
- `tests/e2e/accessibility-navigation.e2e.ts`
- `tests/e2e/refresh-coordinator.e2e.ts`
- `tests/e2e/session-state-visualization.e2e.ts`
- `tests/e2e/ux-navigation.e2e.ts`
- `tests/integration/csp.test.ts`
- `tests/integration/static-assets.test.ts`
- `tests/unit/agent-runtime-state.test.ts`
- `tests/unit/delegation-sessions.test.ts`
- `tests/unit/push.test.ts`
- `tests/unit/session-list.test.ts`

## next action

- finish task 3 session-summary and mobile-return-context contracts
