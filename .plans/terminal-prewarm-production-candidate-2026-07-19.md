# terminal ghostty immediate prewarm production candidate — 2026-07-19

status: promoted locally; not committed/deployed

## change

- production default changed from `GHOSTTY_PREWARM_DELAY_MS = 750` to `0`.
- debug/perf override remains available:
  - localStorage: `wolfpackGhosttyPrewarmDelayMs`
  - env: `WOLFPACK_PERF_GHOSTTY_PREWARM_DELAY_MS`
- no user-visible grid delay added.

## why

The second adjacent grid cell was cold under the old 750ms prewarm delay. Immediate prewarm fills both isolated Ghostty slots before typical grid entry.

## terminal perf evidence

raw:

- `.plans/terminal-grid-prewarm-delay-baseline-n20-2026-07-19.raw.txt`
- `.plans/terminal-grid-prewarm-delay-0-n20-2026-07-19.raw.txt`

primary n20 result:

| scenario | metric | baseline 750 | delay 0 | delta |
|---|---|---:|---:|---:|
| `grid:2` | reveal p50/p95 | 165.0/313.5ms | 140.1/249.5ms | -24.9/-64.0ms |
| `grid:2` | ghostty p50/p95 | 21.2/93.0ms | 0.0/0.1ms | -21.2/-92.9ms |
| `grid:2` | prewarm hits | 20/40 | 40/40 | +20 |
| `single:1` | reveal p50/p95 | 275.8/397.0ms | 272.8/306.0ms | -3.1/-91.0ms |

page-load-integrated n20, collected after instrumentation:

| scenario | metric | baseline 750 | delay 0 | delta |
|---|---|---:|---:|---:|
| `grid:2` | reveal p50/p95 | 148.6/169.9ms | 139.9/153.1ms | -8.8/-16.8ms |
| `grid:2` | prewarm hits | 20/40 | 40/40 | +20 |
| `single:1` | reveal p50/p95 | 175.6/186.3ms | 178.4/202.7ms | +2.8/+16.4ms |

Interpretation: the second run had a warmer/quieter baseline, so visible grid median improvement was smaller. It still improved grid p95 and converted grid prewarm hit rate to 40/40. The solo p95 movement is small relative to prior solo improvement and appears run-noise dominated; no col mismatch regression was observed.

## page-load / cpu sanity

raw:

- `.plans/terminal-page-load-only-baseline-n20-2026-07-19.raw.txt`
- `.plans/terminal-page-load-only-delay-0-n20-2026-07-19.raw.txt`

page-only n20:

| metric | baseline 750 | delay 0 | delta |
|---|---:|---:|---:|
| cards visible p50/p95 | 891.3/910.2ms | 898.4/919.4ms | +7.0/+9.2ms |
| domContentLoaded p50/p95 | 55.7/57.5ms | 56.6/61.7ms | +0.9/+4.2ms |
| first contentful paint p50/p95 | 68.0/72.0ms | 70.0/76.0ms | +2.0/+4.0ms |
| long task count p50/p95 | 0.0/0.0 | 0.0/0.0 | 0.0/0.0 |
| long task total p50/p95 | 0.0/0.0ms | 0.0/0.0ms | 0.0/0.0ms |
| console errors | 0 | 0 | 0 |
| second prewarm ready p50/p95 | 821.2/827.7ms | 86.2/99.5ms | -735.1/-728.2ms |

Interpretation: immediate prewarm adds no observed long tasks and only ~7–9ms page-card visibility movement in the isolated page-load run, while filling both Ghostty slots ~735ms earlier.

## decision

Promote immediate Ghostty prewarm locally. This is the lowest-risk terminal UX/perf target found so far:

- no server wait/hydration/layout-stable default changes,
- no cached-content reveal change,
- no user-visible grid delay,
- no observed CPU long-task regression,
- grid second-cell cold creation removed.

## verification required after promotion

- focused unit tests
- typecheck
- regenerated assets
- desktop grid e2e
- desktop session-switch e2e
- full `bun test`
- cleanup `perf-*` sessions
