# memory-only relay performance — #339

## decision

initial matrix, 2026-09-23: retain the current worker/memory-owned architecture. the measured 1 kib local and loopback-peer workload meets the declared latency budgets. the initial evidence below was partial. the [remaining qualification report](memory-relay-qualification.md) now covers real history delivery, fixed-active-work memory, live native accounting and matched post-load recovery, and supersedes the remaining-gates decision below. it records budget misses and scoped follow-ups, not an unconditional performance pass. no production correction was made in this benchmark PR.

contracts: [memory-owned relay design](memory-owned-relay-design.md), [worker isolation and historical evidence](relay-worker-isolation.md). historical results are not substituted for this revision.

## pinned experiment

| component | identity |
| --- | --- |
| wolfpack | `21c10bf9a9916097d68bbc19183694652df7c56a`; main-based isolated worktree; only this harness/tests/report added |
| real adapter source | clean `fafd860a11a9b2b829e3d22fed15b33c720b7de7`, imported from its `src/index.ts`; not an installed-package parity claim |
| runtime | bun 1.4.2 (`744846f84`), macos darwin 25.6.0 arm64 |
| hardware | mac15,6 / apple m3 pro; 11 logical cpus; 18 gib ram |
| broker | existing release artifact sha256 `67c6f853ba913ddbcb64ca84dc64bf1bd7f8c01542899461d37f1d566c9894a2`; existing build receipt `52f92ab5`; broker sources/lock unchanged between that revision and measured head |
| dependencies | existing installation, no installs; `bun.lock` sha256 `f8858b8a5dfe765e40089f64fcc641832fa91a989b73e8d2af3da546af9bfc8d` |
| transport | production authenticated http/ws, relay worker, real broker/backend/pty; synthetic tailnet identities and https-to-loopback mapping |
| environment | shared workstation, not dedicated idle hardware; initial load averages 3.91/3.48/3.31, battery 87%; battery 80% after first matrix; ac power/76% at final check. power was not held constant |

one controller process, one adapter process containing **both** endpoint cores, and one host/worker plus one native broker per relay. each broker owns five raw-cat ptys; two total exchange measured input/output. endpoint ptys carry pi harness metadata but run no pi/model. idle/load process counts match within each topology; local-vs-peer fleet-memory savings are not inferred.

`WOLFPACK_TEST=1` permits backend/topology injection and uses test-mode cache timing. `createServerInstance` omits the full `startServer` notification observer. real production routing/auth/worker/native session inspection and terminal websocket paths run; physical tls, tailscale, browser rendering, full pi extension lifecycle and history insertion do not.

## declared workload and budgets

budgets were approved before measurements, not fitted to the results:

| normal-load metric | budget |
| --- | --- |
| terminal echo | p95 <=50ms and <= matched idle p95 +20ms; p99 <=100ms |
| host event-loop delay | p95 <=20ms; p99 <=50ms |
| destination-confirmed acceptance | p95 <=250ms |
| receiver incorporation / delivery acknowledgment | each p95 <=5,250ms (shipped 5,000ms poll +250ms) |
| unexpected failures / accepted work unacknowledged | zero |
| host+adapter cpu increment | <=100 percentage points / one core over matched idle |
| host+adapter rss increment | <=256 mib over matched idle; report absolute/peak separately |
| growth screening | final-minute median <= second-minute median +32 mib **with fixed bounded active work**; diagnostic warning, not leak proof |

- 10 offered task creations/second; four outstanding send lanes. overloaded lanes produce counted `controller_backpressure` outcomes, not a reduced offered schedule.
- payload means task-text bytes: 1,024 or 16,384. encoded envelope/state overhead is additional: populated mailbox health charged 3,130 and 33,850 bytes/envelope respectively; those are store-accounted sizes, not measured http content lengths.
- receiver and idle sender poll every 5s. one inbox page per poll; no accelerated drain during the measured interval. an additional 11s bounded drain follows it. incorporated/acknowledged counts can include this drain; outstanding work is right-censored, not called lost.
- two real terminal websocket/cat sessions, 20 fixed-width 16-byte probes/sec each. task and echo schedules retain planned timestamps and dispatch lateness.
- normal: 10s warmup +60s measurement; three independent idle/load pairs per topology; second pair reverses order. warmup sends are excluded from the measured send denominator but remain in receipt/task occupancy.
- 16 kib: three independent local trials, plus one stage-accounting confirmation. seeded mailbox: 128/256 tasks, paced at 10/sec before measurement, then 30s load/no warmup.
- faults: two relays, 30s/no warmup. `slow`: add 300ms before each forwarded peer request; `lost-reply`: destination accepts, then source receives synthetic 503 once; `outage`: synthetic 503 for forwarding for 15s from host configuration, then recovery. this is controlled transport injection, not a physical network fault.
- sustained: one 10s warmup +300s measured creation run per topology; lease renewal operates through the real adapter. task records/receipts accumulate, so these are **not fixed-active-work** leak screens.

## normal latency results

all six one-minute loaded trials: 600/600 accepted and acknowledged each, zero measured accepted work outstanding, zero duplicate envelope observations, 2,400/2,400 echo probes each. both sustained runs add 3,000/3,000 accepted and acknowledged each: 9,600 measured successful sends in total. normal accepted throughput is 10/sec.

quantile tuples below are **p50 / p95 / p99 / max**, milliseconds. task timestamps have 1ms resolution; echo uses a monotonic clock. nearest-rank quantiles are retained per trial rather than pooled.

| topology / trial | acceptance | incorporation | delivery ack | echo p95 idle → load | echo p99 / max |
| --- | --- | --- | --- | --- | --- |
| local / 1 | 4 / 7 / 9 / 11 | 2508 / 4805 / 5004 / 5007 | 2534 / 4807 / 5007 / 5010 | 17.59 → 17.56 | 17.96 / 20.22 |
| local / 2 | 3 / 6 / 9 / 67 | 2509 / 4803 / 5004 / 5011 | 2533 / 4808 / 5006 / 5013 | 17.53 → 17.44 | 17.85 / 44.04 |
| local / 3 | 5 / 8 / 12 / 17 | 2516 / 4806 / 5006 / 5016 | 2552 / 4812 / 5009 / 5019 | 17.50 → 17.64 | 18.33 / 21.49 |
| peer / 1 | 4 / 7 / 9 / 67 | 2507 / 4804 / 5003 / 5007 | 2528 / 4806 / 5005 / 5008 | 17.50 → 17.39 | 17.68 / 43.64 |
| peer / 2 | 5 / 7 / 10 / 37 | 2510 / 4803 / 5004 / 5008 | 2535 / 4806 / 5005 / 5009 | 17.42 → 17.39 | 17.58 / 18.55 |
| peer / 3 | 6 / 9 / 12 / 40 | 2511 / 4806 / 5005 / 5010 | 2556 / 4809 / 5006 / 5011 | 17.59 → 17.48 | 17.69 / 66.04 |

acceptance is measured through the real `createTask` return, which waits for relay admission; peer admission is destination-confirmed. incorporation is when `core.receive` returns and the task exists in endpoint state; this is an upper bound on its earlier internal transaction. delivery ack is the subsequent relay cursor acknowledgment response. **none means task completion, pi insertion, or parent acknowledgment.**

## resources

host rss includes its worker; never add worker rss again. cpu is cumulative process user+system deltas over sampled time, where 100% is one core. rss is sampled once/sec. below, rss is the **sum of process medians**, not a synchronized fleet median. controller is recorded separately, not attributed to relay cost.

| topology / trial | host+adapter cpu % | increment vs idle, pp | host+adapter rss mib | increment vs idle, mib | worst host loop p99 ms |
| --- | --- | --- | --- | --- | --- |
| local / 1 | 8.22 | 5.96 | 143.02 | 25.77 | 1.21 |
| local / 2 | 6.95 | 5.14 | 141.23 | 57.61 | 1.35 |
| local / 3 | 9.99 | 8.23 | 177.61 | 58.14 | 1.33 |
| peer / 1 | 9.91 | 6.97 | 255.28 | 52.05 | 1.44 |
| peer / 2 | 10.41 | 7.76 | 221.52 | 85.63 | 1.22 |
| peer / 3 | 12.64 | 8.95 | 280.67 | 132.06 | 1.40 |

all host loop p95 values are <=1.04ms. measured host+adapter increments are within budgets; rss variation and changing host power/load argue against small-effect comparisons.

native exit receipts record each broker's cumulative cpu and high-water rss separately; normal broker peaks are about 15.6–16.3 mib each. live broker cpu/rss trajectories and raw-cat child rss are not sampled, so **complete process-tree steady-state resource qualification is partial**, not a full fleet pass. bun `resourceUsage.maxRSS` is bytes; cpu total is microseconds. per-process high-water values are not simultaneous peaks.

| sustained topology | accepted | acceptance p95 | ack p95 | echo p95 | adapter cpu % | adapter rss second → final minute, mib | adapter native peak, mib |
| --- | --- | --- | --- | --- | --- | --- | --- |
| local | 3000/3000 | 29ms | 4837ms | 18.05ms | 21.72 | 140.03 → 315.50 | 320.89 |
| peer | 3000/3000 | 31ms | 4840ms | 18.69ms | 21.80 | 148.28 → 247.69 | 293.19 |

both sustain 10 accepted/sec, have no measured accepted work outstanding after drain, renew leases (16 connect operations across both endpoints during each run), and end with 3,100 receipts including warmup. host final-minute medians decline rather than grow. adapter growth exceeds 32 mib numerically but the fixed-active-work precondition is absent: live task records, retained receipts and harness measurement arrays all grow. **investigate; do not call this a leak or a passed bounded-memory test.** no matched five-minute idle pair was run.

## saturation and fault outcomes

these are outside normal-path latency budgets. success-only latency is never an overall success rate.

| case | measured send outcomes | endpoint observations after bounded drain |
| --- | --- | --- |
| 16 kib, trial 1 | 182 accepted; 30 `RELAY_CAPACITY`; 186 `RELAY_PROFILE_REQUIRED`; 202 `TASK_CAPACITY` | 170 accepted tasks have no recorded successful ack |
| 16 kib, trial 2 | 182 accepted; 30 capacity; 184 profile; 204 task capacity | 170 accepted tasks have no recorded successful ack |
| 16 kib, trial 3 | 182 accepted; 32 capacity; 182 profile; 204 task capacity | 170 accepted tasks have no recorded successful ack |
| 16 kib, stage confirmation | 182 accepted; 28 capacity; 185 profile; 205 task capacity | 170 accepted tasks neither incorporated nor acked; final relay holds 247 envelopes / 8,360,950 active bytes |
| seeded 128 | 300 accepted | 28 accepted tasks still outstanding; ack p95 17.62s among observed acks; final mailbox has 28 envelopes |
| seeded 256 | 27 capacity; 273 profile; zero accepted returns | final mailbox remains at 256; 37,780 http 429 responses |
| slow peer | 99 accepted; 201 controller-backpressure | all accepted tasks acked; acceptance p95 1246ms, ack p95 6108ms; 3.3 accepted/sec |
| lost accepted reply | 299 accepted; 1 `PEER_UNREACHABLE` | the failed-return task also incorporates/acks; no duplicate envelope observation |
| outage / recovery | 62 accepted; 37 peer-unreachable; 201 profile | all 62 accepted tasks acked; another 166 failed-return tasks incorporate; 72 remain unobserved; 72 typed `DELIVERY_UNCONFIRMED` request responses |

normal/fault/occupancy terminal p95 remains below 18.70ms, with no missing measured echo frames. this demonstrates terminal responsiveness under these cases, not successful relay recovery for every task. retry exhaustion is explicit in raw request responses even when the earlier `createTask` return had a different failure. a failed send return is not proof of nondelivery.

### measured correction candidates — not implemented

1. **preserve typed retryable http admission failures.** `src/server/index.ts` applies a 120/sec per-client global limiter before relay routing and returns generic `{error: "rate limit exceeded"}` / 429. pinned adapter `src/volatile-task-session.ts` treats a response without the volatile profile as nonretryable `RELAY_PROFILE_REQUIRED`. the large confirmation generated 22,747 adapter requests, including 18,450 http 429s. correcting this boundary is smaller and more useful than an architectural rewrite; preserve actual profile refusals as permanent.
2. **bound retry work under pressure.** pinned adapter `src/task-core.ts` `flush` visits the entire pending outbox on each task creation. after capacity/outage, repeated calls amplify traffic and consume admission needed for receive/ack. seeded-256 generated 42,224 requests for 300 offered sends. propose a focused retry/admission regression, then bounded per-cycle retry/backoff without changing immutable identities, exhaustion or uncertainty semantics.
3. **measure a bounded page-drain alternative.** `INBOX_PAGE_BYTES` is 256 kib, while this large envelope consumes about 33.85 kb. one page every 5s cannot sustain 10 such envelopes/sec; item/byte limits must remain intact. investigate draining available pages within a fixed operation/time budget rather than weakening capacity or merely hiding overload by reducing offered rate. full extension history/insertion work must be included before selecting the fix.

no production changes, external adapter edits, live service restarts or installation were performed. the benchmark/report is published in PR#374. correction1 is separately owned by pi-tasks#25; measured follow-ups2/3 are now pi-tasks#26/#27.

## reproducible commands

run only in an isolated checkout after authorizing native broker/benchmark execution. require the pinned clean adapter checkout, existing dependencies and the validated broker artifact; do not substitute the running service's socket. the harness binds ephemeral loopback ports, uses private homes/config/jwt/session roots, validates adapter revision and broker hash, and refuses non-loopback adapter requests. do not publish the raw directory: it contains synthetic credentials and exact endpoint identities.

```sh
umask 077
evidence=$(mktemp -d /private/tmp/w339.XXXXXX)
export EVIDENCE="$evidence"
export ADAPTER=/absolute/path/to/pinned/pi-tasks-checkout
export BROKER=/absolute/path/to/validated/wolfpack-broker
bun -e 'import {writeFileSync} from "node:fs";
writeFileSync(process.env.EVIDENCE+"/case.json", JSON.stringify({
  output:process.env.EVIDENCE, source:process.env.ADAPTER,
  revision:"fafd860a11a9b2b829e3d22fed15b33c720b7de7",
  broker:process.env.BROKER,
  brokerSha256:"67c6f853ba913ddbcb64ca84dc64bf1bd7f8c01542899461d37f1d566c9894a2",
  relays:1, load:true, payloadBytes:1024,
  warmupMs:10000, durationMs:60000, fault:"none", seedMailbox:0
}));'
bun scripts/relay-perf/run.ts "$evidence/case.json" \
  >"$evidence/driver.jsonl" 2>"$evidence/driver.stderr.log"
# preserve/check the actual exit status before summarizing.
trial=$(bun -e 'const rows=(await Bun.file(process.argv[1]).text()).trim().split("\n").map(JSON.parse); console.log(rows.find(x=>x.kind==="trial").root)' "$evidence/driver.jsonl")
bun scripts/relay-perf/summarize.ts "$trial" >"$evidence/summary-command.log" 2>&1
```

repeat using fresh driver invocations, not reused relay state:

| config changes from example | repetitions |
| --- | --- |
| `relays:1` and `2`, each with `load:false` and `true` | three paired trials each; reverse idle/load order in pair two |
| `payloadBytes:16384`, local | three trials |
| `seedMailbox:128` and `256`, `warmupMs:0`, `durationMs:30000` | one each |
| `relays:2`, `fault:"slow"` / `"lost-reply"` / `"outage"`, `warmupMs:0`, `durationMs:30000`; outage additionally `recoverAfterMs:15000` | one each |
| `durationMs:300000`, `relays:1` and `2` | one each |

focused checks used: `bun test tests/unit/relay-perf-measurement.test.ts tests/unit/relay-perf-summary.test.ts` (4 pass, 0 fail, 20 assertions; exit 0), and `./node_modules/.bin/tsc --noEmit` (exit 0). no repository-wide test suite was run for this harness-only addition.

## initial evidence ledger and remaining gates

historical status at the first publication; see the [qualification supplement](memory-relay-qualification.md#acceptance-map) for current disposition.

the private evidence root is recorded in `.plans/339-evidence-path` with the current handoff in `.plans/314-relay-performance.md`; neither is a portable/public evidence bundle. preserve it before temporary-directory cleanup. raw artifacts include per-trial `run.json`, `adapter/adapter-metrics.json`, host metrics, process stdout/stderr, matrix configs, source fingerprints, environment receipts, and summaries.

- first matrix: 15 measured cases exited 0, then unpaced occupancy setup exited 1; driver duration 1,225s. setup error retained and excluded from workload results.
- resumed matrix: 8 cases exited 0 in 975s after pacing seed creation. includes large-payload stage-accounting confirmation. three earlier large trials recorded incorporation only for ack-success rows; their incorporation coverage is incomplete, but accepted/unacknowledged counts remain usable.
- final summarizer separates incorporated and acknowledged tasks and takes the earliest evidence per stage. null means unknown, not zero. subprocess exit 0 means the harness completed, **not that the workload met its budgets**.
- prior smoke attempts exposed native usage getters/bigint serialization and asynchronous pty reaping; their failures remain in private logs. final cleanup probe found all 306 recorded owned process/pty pids absent. original checkout tracked-diff digest stayed identical; adapter checkout stayed clean.

| #339 criterion | disposition |
| --- | --- |
| revisions, workload, budgets, reproduction | recorded; harness fingerprints distinguish measurement revisions |
| real adapter local/peer acceptance → incorporation → delivery ack | measured core path; installed pi insertion/model/parent-ack path not claimed |
| idle, leases, occupancy, concurrent terminal io, sustained load | measured; fixed active work plus 0/1000/10000 archived-history comparison **not run** |
| distributions, cpu, process-tree/peak rss | host/worker, adapter, controller and native exit usage recorded; live broker/pty resource attribution incomplete |
| capacity, slow peer, outage, recovery, exhaustion | measured; request amplification/profile misclassification observed; resource return-to-idle not established by a matched post-fault interval |
| budget comparison and smallest correction | normal measured scope passes; saturation candidates above need separate approval/regressions |
| physical tls/tailnet/devices | unverified; remains #254 |

these initial evidence gaps are addressed in the qualification supplement at the production inbox/history boundary. full installed-pi/model/rebind behavior remains explicitly outside the measured scope; it is not inferred from a synchronous history facade.
