# combined immediate prewarm + refill perf sanity — 2026-07-20

status: measured
branch: post-take-ghostty-prewarm-replenishment
base stack: prewarm-ghostty-immediately + refill follow-up

## command shape

```sh
WOLFPACK_PERF_USE_EXISTING_BROKER=1 \
WOLFPACK_BROKER_SOCKET=/Users/home/.wolfpack/broker.sock \
WOLFPACK_PERF_GRID_CELLS=2 \
bun run scripts/terminal-load-perf.ts
```

Repeated 20 times after fixing perf-session cleanup in `scripts/terminal-load-perf.ts`.

## n20 summary

- runs parsed: 20/20
- failed runs: 0
- remaining `perf-*` sessions after run: 0
- page console errors: 0

### page load

| metric | p50 | p95 | min | max |
| --- | ---: | ---: | ---: | ---: |
| card visible | 531.7ms | 1261.1ms | 411.0ms | 1292.8ms |
| domContentLoaded | 68.7ms | 95.0ms | 45.6ms | 114.1ms |
| FCP | 88.0ms | 148.0ms | 60.0ms | 168.0ms |
| second prewarm ready | 111.1ms | 226.1ms | 71.7ms | 226.5ms |
| long task count | 0 | 2 | 0 | 2 |
| long task total | 0ms | 110ms | 0ms | 131ms |

### terminal reveal

| scenario | prewarm hits | ghostty create p50/p95 | reveal p50/p95 |
| --- | ---: | ---: | ---: |
| single | 20/20 | 0.3ms / 0.4ms | 206.0ms / 362.6ms |
| grid:2 | 40/40 | 0.0ms / 0.1ms | 197.6ms / 218.5ms |

### grid internals

| metric | p50 | p95 |
| --- | ---: | ---: |
| ws server | 83.6ms | 103.4ms |
| prefill done → reveal | 44.7ms | 51.2ms |

## conclusion

Combined stack keeps Ghostty creation off the grid reveal path: grid prewarm hit rate was 40/40 and Ghostty creation was effectively zero at p95.

The refill change also fixed the perf-loop safety issue by cleaning created `perf-*` sessions, preventing broker fd exhaustion during repeated measurement.

## artifacts

- raw: `.plans/terminal-combined-prewarm-refill-n20-2026-07-20.raw.txt`
- parsed summary: `.plans/terminal-combined-prewarm-refill-2026-07-20.summary.json`
