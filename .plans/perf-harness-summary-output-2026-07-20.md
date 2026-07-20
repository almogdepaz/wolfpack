# perf harness summary output — 2026-07-20

status: pr open
branch: perf-harness-summary-output
base: main after #189

## scope

- add readable aggregate output for repeated terminal-load perf runs.
- document supported perf harness env vars near the script.
- keep measurement flow and terminal/browser behavior unchanged.

## constraints

- no terminal attach/reveal/hydration/socket timing changes.
- env-driven harness stays; no cli parser unless needed later.
- raw artifacts remain local/uncommitted.
- TDD first for output formatting/docs helpers.

## status

- [x] red tests for readable summary/docs helpers
- [x] implementation
- [x] verification
- [x] commit/push/pr — PR #190

## verification log

- red: `bun test tests/unit/terminal-load-perf.test.ts -t "perf run options"` failed on missing `formatPerfRunsSummary` export.
- green: same narrow test passed, 4 tests.
- green: `WOLFPACK_PERF_HELP=1 bun run scripts/terminal-load-perf.ts` printed env help without requiring broker/server startup.
- green: `bun test tests/unit/terminal-load-perf.test.ts` passed, 10 tests.
- green: `bun run typecheck` passed.
- green: page-only repeated-run smoke with `WOLFPACK_PERF_RUNS=2` printed aggregate summary and parseable json, `summary.runs = 2`, console errors 0.
- green: small full smoke with `WOLFPACK_PERF_GRID_CELLS=2` printed single/grid aggregate lines, parseable json, grid prewarm hits 2/2, no remaining `perf-*` sessions.
- green: `git diff --check` passed.
- green: full `bun test` with git commit signing disabled passed, 1820 tests.
