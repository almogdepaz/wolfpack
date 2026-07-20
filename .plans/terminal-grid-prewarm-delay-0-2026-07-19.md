# terminal grid ghostty prewarm delay 0 experiment — 2026-07-19

status: measured; debug/perf-gated only; no production default change yet

## setup

- production default remains `GHOSTTY_PREWARM_DELAY_MS = 750`.
- added debug/perf-only localStorage key: `wolfpackGhosttyPrewarmDelayMs`.
- added perf env knob: `WOLFPACK_PERF_GHOSTTY_PREWARM_DELAY_MS`.
- broker: existing host broker `/Users/home/.wolfpack/broker.sock`.
- grid cells: `2`.
- samples: adjacent n20 default-baseline + n20 delay-0.
- raw:
  - `.plans/terminal-grid-prewarm-delay-baseline-n20-2026-07-19.raw.txt`
  - `.plans/terminal-grid-prewarm-delay-0-n20-2026-07-19.raw.txt`
- cleanup verified: no remaining `perf-*` sessions.

## comparison

| mode | scenario | group | n | prewarmed | reveal | setup→attach | ghostty | ws server | hydration | pty_ready→reveal | col mismatches | width changes |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline-750 | `single:1` | all | 20 | 20/20 | 275.8/397.0 | 53.9/159.3 | 0.3/2.5 | 141.1/258.9 | 243.4/337.0 | 45.2/70.1 | 8/20 | 20/20 |
| baseline-750 | `grid:2` | all | 40 | 20/40 | 165.0/313.5 | 70.7/220.8 | 21.2/93.0 | 40.7/124.7 | 112.2/223.4 | 46.5/70.5 | 0/40 | 0/40 |
| baseline-750 | `grid:2` | cell0 | 20 | 20/20 | 132.4/280.1 | 43.6/115.6 | 0.0/0.1 | 42.2/124.7 | 117.3/265.6 | 44.7/58.8 | 0/20 | 0/20 |
| baseline-750 | `grid:2` | cell1 | 20 | 0/20 | 170.1/336.0 | 80.0/254.2 | 54.8/196.5 | 38.8/66.9 | 98.5/210.8 | 52.6/70.5 | 0/20 | 0/20 |
| delay-0 | `single:1` | all | 20 | 20/20 | 272.8/306.0 | 38.4/98.9 | 0.3/0.3 | 171.5/215.7 | 243.1/280.4 | 51.0/66.9 | 5/20 | 20/20 |
| delay-0 | `grid:2` | all | 40 | 40/40 | 140.1/249.5 | 60.9/146.8 | 0.0/0.1 | 33.5/90.5 | 114.8/231.7 | 45.5/91.3 | 0/40 | 0/40 |
| delay-0 | `grid:2` | cell0 | 20 | 20/20 | 139.4/249.5 | 50.7/132.8 | 0.0/0.1 | 41.2/151.9 | 116.0/231.7 | 44.5/77.2 | 0/20 | 0/20 |
| delay-0 | `grid:2` | cell1 | 20 | 20/20 | 141.2/227.4 | 64.1/146.8 | 0.0/0.1 | 23.6/46.5 | 110.7/203.4 | 46.8/96.9 | 0/20 | 0/20 |

## deltas: delay-0 minus baseline-750

| scenario | reveal median | reveal p95 | setup→attach median | setup→attach p95 | ghostty median | ghostty p95 | hydration median | hydration p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `single:1` | -3.1ms | -91.0ms | -15.5ms | -60.4ms | 0.0ms | -2.2ms | -0.4ms | -56.6ms |
| `grid:2` | -24.9ms | -64.0ms | -9.8ms | -74.0ms | -21.2ms | -92.9ms | +2.6ms | +8.3ms |

## interpretation

This is the first terminal perf knob that improves the user-visible metric in the larger adjacent sample without a visible p95 regression:

- grid prewarm hit rate: `20/40 → 40/40`
- grid reveal: `165.0/313.5ms → 140.1/249.5ms`
- grid ghostty creation: `21.2/93.0ms → 0.0/0.1ms`
- grid col mismatches: `0/40` in both arms
- solo reveal did not regress: `275.8/397.0ms → 272.8/306.0ms`

The remaining grid p95 is now mostly outside ghostty creation. `pty_ready→reveal` did not improve and p95 worsened (`70.5ms → 91.3ms`), so do not combine this with hydration timing changes. The gain is specifically from avoiding cold Ghostty instance creation for the second grid cell.

## decision

Keep delay-0 debug/perf-gated for now.

This is a viable production candidate, unlike the server/layout/hydration knobs. Before changing the default, verify:

1. default desktop grid e2e still passes,
2. desktop session-switch e2e still passes,
3. no obvious page-load/CPU regression from starting two isolated Ghostty instances immediately,
4. full `bun test` remains green after the wiring.

If promoted, the minimal production change is lowering `GHOSTTY_PREWARM_DELAY_MS` from `750` to `0`. Do **not** add any user-visible grid delay.
