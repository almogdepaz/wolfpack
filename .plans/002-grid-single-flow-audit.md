# grid vs single terminal flow audit

- branch: `dev07`
- baseline: `6f6abb6`
- status: completed, including cross-mode compatibility follow-up
- scope: report only; no production behavior changes
- report: `antipattern-report-grid-vs-single-2026-07-14.md`

## success criteria
- trace single and grid flows from session selection through attach, prefill, hydration, terminal writes, resize, reconnect, conflict, and cleanup.
- explain the observed scrollback difference from structured request/response behavior.
- inventory duplicated production responsibilities with precise locations.
- distinguish intentional mode differences from drift that can be unified.
- rank unification candidates and identify behavior/test constraints.

## progress
- [x] read repository routing and browser-client architecture context
- [x] establish full-scan scope and read antipattern catalog
- [x] read relevant production files completely
- [x] map tests and runtime call sites
- [x] compare behavior and duplication
- [x] write and verify report

## result
- current grid snapshots request zero broker scrollback; desktop single snapshots request up to 500 lines.
- the likely grid-only visual scroll source is late post-snapshot resize/TUI redraw output because viewport mode omits the output-quiescence barrier used by full mode.
- identified 3 high, 4 medium, and 1 low duplication/architecture findings.
- focused desktop browser verification: 31 passed, 3 skipped.

## compatibility follow-up
- [x] classify every proposed shared behavior as common, policy-driven, or mode-specific
- [x] choose the strongest existing implementation per shared concern
- [x] quantify where single-mode behavior is unsafe or too costly for grid
- [x] verify current single/grid contracts across browser profiles
- [x] add the compatibility matrix and recommended canonical sources to the report

## compatibility result
- choose canonical behavior per concern, not one mode wholesale: mobile single already uses viewport while desktop single uses full.
- desktop single provides the stronger hydration/stabilization baseline, but its full-history payload is unsafe to copy to as many as six grid cells.
- grid provides the stronger take-control coordinator; single provides the stronger output-driven snapshot cadence.
- five contracts need new parity regressions before implementation selection: viewport delayed redraw, viewport completion timeout, grid manual retry hydration, single takeover fallback, and periodic grid snapshots.
- cross-profile focused browser verification: 39 passed, 63 skipped; relevant pure unit verification: 125 passed, 0 failed.
