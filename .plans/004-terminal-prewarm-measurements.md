# task 4 terminal prewarm measurements

## method

- date: 2026-07-29
- host: macOS arm64
- browser: Playwright Chromium 1.58.2
- samples: 3 fresh broker/server/browser processes per device and pool size
- pool sizes: 0, 1, 2 isolated Ghostty instances
- mobile: Chromium mobile emulation at 390×844, scale factor 3, touch enabled
- desktop: Chromium at 1280×720
- grid: two desktop cells
- command shape:
  - `WOLFPACK_PERF_RUNS=1 WOLFPACK_PERF_DEVICE=<desktop|mobile> WOLFPACK_PERF_GHOSTTY_PREWARM_POOL_SIZE=<0|1|2> WOLFPACK_PERF_GRID_CELLS=2 bun scripts/terminal-load-perf.ts`
- responsiveness: card-visible, FCP, terminal setup-to-reveal, and Ghostty creation traces
- memory proxy: CDP `Runtime.getHeapUsage`; backing-storage bytes include browser-managed backing stores and expose the incremental isolated-WASM cost more clearly than JS heap alone

Values are p50/p95 unless noted.

## results

| device | pool | card visible ms | FCP ms | page JS heap MiB | backing storage MiB | solo reveal ms | solo Ghostty ms | solo warm hits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| desktop | 0 | 79.7/82.8 | 36/36 | 3.60/3.60 | 3.55/3.55 | 209.2/214.1 | 11.8/18.1 | 0/3 |
| desktop | 1 | 105.0/119.2 | 48/56 | 3.64/3.64 | 5.14/5.14 | 200.0/212.2 | 0.3/0.4 | 3/3 |
| desktop | 2 | 152.0/183.2 | 36/56 | 3.67/3.67 | 6.73/6.73 | 172.3/196.3 | 0.3/0.5 | 3/3 |
| mobile | 0 | 104.3/119.5 | 60/64 | 3.61/3.61 | 3.55/3.55 | 154.3/188.6 | 9.3/12.6 | 0/3 |
| mobile | 1 | 124.7/174.5 | 72/80 | 3.64/3.65 | 5.14/5.14 | 165.9/166.3 | 0.3/0.3 | 3/3 |
| mobile | 2 | 135.4/151.3 | 72/80 | 3.68/3.68 | 6.73/6.73 | 155.5/173.2 | 0.6/0.6 | 3/3 |

| desktop pool | two-cell grid reveal ms | grid Ghostty ms | warm hits |
|---:|---:|---:|---:|
| 0 | 201.4/242.3 | 33.7/43.3 | 0/6 |
| 1 | 192.9/223.2 | 0.0/56.6 | 3/6 |
| 2 | 202.7/210.2 | 0.0/0.1 | 6/6 |

## decision

Set the production pool to **1**.

- It saves about **1.59 MiB** of idle backing storage versus two instances on both profiles.
- Solo Ghostty creation remains effectively eliminated: 0.3 ms p50 on desktop and mobile, with 3/3 warm hits.
- Mobile solo reveal remains inside the no-prewarm sample range and has a lower observed p95 than both zero and two instances.
- The two-cell grid intentionally warms only its first cell. Its 192.9/223.2 ms reveal is better than the zero-pool 201.4/242.3 ms baseline and does not regress grid correctness.
- Two instances improve the second cell's Ghostty creation time, but the extra idle backing store does not buy a corresponding grid reveal improvement at p50.

The debug-only pool override remains bounded to 0–2 so this decision can be remeasured without changing production policy.

## limits

- n=3 is directional, not a release-grade benchmark distribution.
- Mobile results are emulated Chromium, not physical iOS Safari or Android hardware.
- CDP heap/backing-storage metrics are not whole-process RSS.
- WebKit compatibility is tested separately; this Chromium harness is retained for comparable timing and CDP memory metrics.
