# memory-only relay — remaining qualification for #339

## decision

2026-09-23: the remaining **measurement** gates are covered. keep the worker/memory-owned architecture; do not claim every workload passes. the real history-delivery path meets measured latency/resource targets, but six peer trials violate the zero-unexpected-failure target. saturation still amplifies retries and the large-payload backlog does not recover within the declared window. follow-ups: [bounded retry/receipt scheduling](https://github.com/almogdepaz/pi-tasks/issues/26) and [bounded byte-aware draining](https://github.com/almogdepaz/pi-tasks/issues/27).

this supplements, rather than replaces, the [initial experiment, approved budgets and saturation/fault results](memory-relay-performance.md). #339 is an evidence gate, not a requirement to implement every optimization. the report/harness PR can close it when merged; no production fix or merge is performed here. physical qualification remains [#254](https://github.com/almogdepaz/wolfpack/issues/254).

## additional pins and method

unchanged hardware, production wolfpack base `21c10bf9a9916097d68bbc19183694652df7c56a`, broker, runtime, dependencies and trust-boundary setup are documented in the initial report. these runs record harness base `b8b76f5133d1583d52b274420a3279ea4c7ff5da` plus the benchmark-only additions in this PR; pre/post source fingerprints match.

- real adapter candidate: clean `4258e593e883761e0af2cbfd14b35469780508dc` ([pi-tasks#25](https://github.com/almogdepaz/pi-tasks/pull/25)); control: clean `fafd860a11a9b2b829e3d22fed15b33c720b7de7`. the candidate changes generic HTTP429 classification, not polling or retry policy. it is a pinned open PR, not an installed/released version claim.
- real pi `SessionManager`: existing SDK `0.80.10`; `dist/core/session-manager.js` sha256 `879e80cc6e2371e4b06887e6fb041c323ba4e86f7687bfdac6474c9f61486112`. persisted synthetic historical task-event entries are reopened through the actual loader, not placed in unrelated files. they never restore operational tasks.
- production `deliverTaskInbox` runs at both endpoints with its actual insertion, wake-evidence, canonical receipt and cursor logic. the synchronous pi facade appends to real history; it does **not** run a model, TUI, the whole extension scheduler or automatic rebind. insertion/wake evidence is not model execution, task completion or parent acknowledgment.
- native macos `libproc` samples exact owned host, adapter, broker and all raw-cat pty pids once/sec; process start identity is checked across samples. host already includes the worker. totals sum one batch of live counters, not independently peaked processes. controller is separate; transient sampler processes are observer cost, not relay cost. Mach CPU ticks are converted using `mach_timebase_info` and checked against runtime CPU counters.
- request, failure, health and runtime sampling streams to private JSONL. finite task/echo outcomes remain counted; no growing telemetry arrays in the measured host/adapter memory screen. health/state probes add two HTTP requests and count reads per5s poll. this observer overhead is present in matched controls; do not interpret the totals as instrumentation-free production cost.
- 34 sequential runs:24 archive trials including six idle controls, four fixed-cohort screens, four recovery trials and two matched core-only recovery controls. all processes start fresh. the32-case matrix took4,124s; the two recovery controls took403s. all driver and summary exits were0, which means completed measurement, NOT passing budgets.
- shared workstation; macos26.6.2/build25G83, Bun1.4.2. pre-matrix load3.43/3.39/3.34, battery91%; final32-case check2.15/2.39/2.73, AC/85%. power/background load were not held constant. no causal small-effect or old-vs-new performance improvement claim.

## archive-volume workload

1 kib task text, one creation/sec, four send lanes, shipped5s poll,10s warmup +60s measured. each endpoint starts with0/1,000/10,000 archived events; the active input schedule stays identical:70 tasks including warmup,60 measured. this is a separate full-inbox workload, **not** a lowered-rate rerun of the original core-only10/sec capacity test. two real terminal streams continue at20 probes/sec each.

three trials per topology/volume; volume and idle order reverse in trial two. every loaded trial ends with70 tasks at each endpoint, zero pending outbox and empty receiver relay queue. all1,080 measured assignments are accepted, inserted and delivery-acked. sender archive cursor bookkeeping differs slightly in capacity-error trials, so those trials are not a perfectly isolated constant-work CPU experiment. no claim that every intermediate canonical history entry is identical.

latency tuples are **p50 / p95 / p99 / max**, milliseconds.60 task samples/trial are an empirical distribution, not strong evidence for a production p99 SLO. complete per-process samples and distributions remain in the private artifacts.

| topology / trial / archived events | acceptance | history insertion | delivery ack |
| --- | --- | --- | --- |
| 1-1-0 | 11 / 34 / 42 / 42 | 3062 / 5033 / 5044 / 5044 | 3065 / 5040 / 5051 / 5051 |
| 1-1-1000 | 6 / 24 / 30 / 30 | 3054 / 5027 / 5029 / 5029 | 3060 / 5036 / 5039 / 5039 |
| 1-1-10000 | 5 / 28 / 30 / 30 | 3100 / 5023 / 5033 / 5033 | 3107 / 5032 / 5044 / 5044 |
| 1-2-10000 | 5 / 22 / 30 / 30 | 3104 / 5021 / 5030 / 5030 | 3112 / 5032 / 5039 / 5039 |
| 1-2-1000 | 12 / 36 / 42 / 42 | 3070 / 5035 / 5045 / 5045 | 3074 / 5045 / 5052 / 5052 |
| 1-2-0 | 11 / 36 / 42 / 42 | 3066 / 5039 / 5042 / 5042 | 3069 / 5045 / 5049 / 5049 |
| 1-3-0 | 11 / 36 / 41 / 41 | 3063 / 5039 / 5041 / 5041 | 3066 / 5045 / 5048 / 5048 |
| 1-3-1000 | 11 / 34 / 39 / 39 | 3069 / 5034 / 5045 / 5045 | 3074 / 5042 / 5055 / 5055 |
| 1-3-10000 | 12 / 40 / 41 / 41 | 3119 / 5037 / 5046 / 5046 | 3125 / 5049 / 5058 / 5058 |
| 2-1-0 | 16 / 31 / 41 / 41 | 3077 / 5036 / 5050 / 5050 | 3084 / 5049 / 5061 / 5061 |
| 2-1-1000 | 16 / 33 / 39 / 39 | 3083 / 5039 / 5042 / 5042 | 3090 / 5052 / 5057 / 5057 |
| 2-1-10000 | 18 / 38 / 399 / 399 | 3154 / 5044 / 5416 / 5416 | 3165 / 5061 / 5448 / 5448 |
| 2-2-10000 | 17 / 32 / 35 / 35 | 3150 / 5038 / 5047 / 5047 | 3164 / 5055 / 5064 / 5064 |
| 2-2-1000 | 17 / 31 / 37 / 37 | 3085 / 5039 / 5041 / 5041 | 3093 / 5051 / 5054 / 5054 |
| 2-2-0 | 17 / 31 / 38 / 38 | 3078 / 5036 / 5043 / 5043 | 3086 / 5048 / 5054 / 5054 |
| 2-3-0 | 18 / 34 / 37 / 37 | 3080 / 5037 / 5043 / 5043 | 3087 / 5050 / 5056 / 5056 |
| 2-3-1000 | 18 / 32 / 38 / 38 | 3080 / 5039 / 5046 / 5046 | 3089 / 5051 / 5055 / 5055 |
| 2-3-10000 | 20 / 34 / 41 / 41 | 3097 / 5041 / 5051 / 5051 | 3103 / 5053 / 5063 / 5063 |

resource totals include native brokers/ptys; CPU100% is one core. RSS is a median of batch totals. echo columns are p95/p99 milliseconds. errors are caught receive/ACK-path `RELAY_CAPACITY` exceptions, not lost assignments.

| topology / trial / archived events | echo p95 / p99 | tree CPU % | tree median / peak RSS, mib | transient errors |
| --- | --- | --- | --- | --- |
| 1-1-0 | 19.00 / 19.84 | 17.40 | 222.75 / 260.92 | 0 |
| 1-1-1000 | 18.64 / 19.13 | 11.65 | 234.02 / 272.39 | 0 |
| 1-1-10000 | 18.53 / 18.73 | 11.27 | 330.78 / 361.30 | 0 |
| 1-2-10000 | 18.51 / 18.69 | 10.77 | 324.14 / 349.12 | 0 |
| 1-2-1000 | 19.03 / 19.92 | 18.20 | 236.42 / 266.33 | 0 |
| 1-2-0 | 18.98 / 19.62 | 17.76 | 218.34 / 255.47 | 0 |
| 1-3-0 | 19.02 / 19.55 | 17.76 | 220.28 / 259.27 | 0 |
| 1-3-1000 | 18.97 / 19.93 | 18.29 | 235.17 / 260.28 | 0 |
| 1-3-10000 | 18.96 / 19.67 | 20.01 | 346.88 / 371.28 | 0 |
| 2-1-0 | 18.82 / 19.23 | 26.05 | 344.03 / 393.19 | 10 |
| 2-1-1000 | 18.86 / 19.32 | 26.04 | 361.34 / 397.17 | 6 |
| 2-1-10000 | 18.83 / 23.79 | 29.24 | 373.16 / 435.64 | 0 |
| 2-2-10000 | 18.05 / 19.10 | 30.62 | 473.38 / 490.53 | 0 |
| 2-2-1000 | 18.09 / 18.83 | 27.67 | 358.59 / 397.55 | 0 |
| 2-2-0 | 18.06 / 18.57 | 27.20 | 347.25 / 390.62 | 4 |
| 2-3-0 | 18.85 / 19.75 | 28.19 | 348.52 / 401.55 | 7 |
| 2-3-1000 | 18.88 / 19.48 | 28.43 | 367.91 / 394.08 | 2 |
| 2-3-10000 | 19.13 / 19.85 | 30.80 | 456.00 / 489.80 | 11 |

budget decisions:

- acceptance p95<=40ms; history insertion p95<=5,044ms; delivery ack p95<=5,061ms. all below the declared250ms /5,250ms targets.
- maximum loaded echo-p95 increase over paired idle:0.41ms local,0.20ms peer. worst host loop p95/p99 across the qualification matrix:2.08/2.81ms. no missing/undispatched echo frames. archive task dispatch lateness max20ms; echo lateness p95<=5ms, max69ms. scheduled-time distributions remain separate from send-to-return latency.
- process-tree CPU increment over matched idle ranges -1.98–12.10 percentage points local and7.81–12.12 peer, below100pp. negative/noisy deltas are not savings. median RSS increments45.33–171.92mib local and68.73–198.55mib peer; worst peak-to-idle-peak increments190.95/210.64mib, below256mib.
- **zero-unexpected-failure target misses:**40 transient capacity exceptions across six of nine peer loaded trials. all assignments eventually insert/ack. the first observed429 is a sender ACK before that poll's diagnostic health calls. loopback aggregates adapter/forwarded traffic under one per-client120req/s token bucket; distinct physical IP behavior is untested. issue26 includes receipt bursts, not just failed create retries.
- history is NOT proven operationally constant-cost. the real helper repeatedly scans entries. peer10k-vs0 CPU differences are +3.19/+3.42/+2.61pp across the three trials; histories also occupy memory. latency/resource budgets still hold at these volumes. local comparisons are noisier; receipt exceptions and uncontrolled power preclude a clean scaling-law estimate. no architecture change is justified by these figures alone.

component attribution at10k archived events, median across three trials per topology (CPU% / RSS mib). each role's RSS first sums its processes in the same native batch; these independently summarized role medians must not be added to reconstruct the fleet median.

| topology | host, including worker | adapter, both endpoints/history | brokers | raw-cat ptys |
| --- | --- | --- | --- | --- |
| local |4.11 /109.02 |6.54 /206.08 |0.55 /15.91 |0.08 /5.81 |
| peer |17.65 /208.75 |11.15 /202.64 |1.13 /31.45 |0.12 /11.59 |

worker-only CPU/RSS cannot be isolated from process counters; no double counting or invented thread attribution.

## fixed-active-work memory screen

real inbox/history setup is fully drained before warmup. compare zero retained tasks against four retained tasks at **each** endpoint, then10s warmup +300s measurement with no new tasks. five-second polling/lease renewal and terminal IO continue. all sampled task/pending/quarantine/history counts stay unchanged, not merely equal at the endpoints of the run. history volume is0 here; this is a bounded-work screen separate from the archive-volume comparison.

| topology / tasks per endpoint | second-minute tree RSS median, mib | final-minute median, mib | growth, mib | initial → final tasks / pending |
| --- | --- | --- | --- | --- |
| local /0 |181.05 |186.08 |5.03 |0/0 →0/0 |
| local /4 |193.08 |196.69 |3.61 |4/0 →4/0 |
| peer /0 |220.44 |231.47 |11.03 |0/0 →0/0 |
| peer /4 |309.23 |315.28 |6.05 |4/0 →4/0 |

all four satisfy final-minute <= second-minute +32mib. the local retained-work relay holds52 receipts throughout; peer receiver holds36. all queues/outboxes remain empty, quarantines0. this is one five-minute screen per condition, not a leak proof, near-capacity lifetime test or fleet-memory saving claim. observed native broker peaks across the matrix are15.80–17.34mib each.

## post-load and outage recovery

core path,10 creations/sec for70s including10s warmup, then120s without new admission; total measured180s, then the existing11s bounded drain. polling/retry behavior is unchanged. large case uses16kib/local; peer outage lasts30s from host configuration (slightly before adapter workload start). each control/candidate comparison is one trial, not a statistically established performance comparison.

| case / adapter | measured600-send outcomes | final receiver queue / bytes | final sender pending / quarantine | accepted but unacked |
| --- | --- | --- | --- | --- |
| large / control |182 accepted;30 capacity;184 profile;204 task-capacity |222 /7,514,700 |0 /0 |9 |
| large / candidate |182 accepted;213 capacity;205 task-capacity |222 /7,514,700 |0 /0 |9 |
| outage / control |210 accepted;378 profile;12 peer-unreachable |0 /0 |0 /205 |0 |
| outage / candidate |249 accepted;344 capacity;7 peer-unreachable |0 /0 |0 /199 |0 |

counts exclude warmup; final state includes it. accepted throughput during the60s admission measurement is3.03/sec for both large runs and3.50/4.15/sec for outage control/candidate; a full180s-window average would also include intentional idle time. large runs retain495 sender/273 receiver tasks. outage runs retain700 sender tasks and495/501 receiver tasks.285/252 measured failed-return sends later arrive in the outage control/candidate: failure return still does not prove nondelivery. typed HTTP `DELIVERY_UNCONFIRMED` responses number208/200; these are response counts, not unique exhausted envelopes. final quarantines205/199 are envelope counts and are not silently retried/rearmed.

- large: seven33,850-byte envelopes fit each256kib page, giving observed7/5s drain. ack p95 among completed observations is169.03/169.01s. sender pending reaches0, but222 relay envelopes remain at stop; recovery is **not** complete. outstanding work is right-censored, not called lost. issue27 owns the bounded page-drain investigation.
- large HTTP429 counts:18,492 control /18,473 candidate; typed capacity responses4,460 /4,432. outage429 counts29,050 /28,656. the classification fix removes misleading profile outcomes in these reruns, not retry amplification; issue26 owns that correction.

matched core-only idle controls use equivalent process counts and instrumentation, without the SDK/history-mode overhead. below:60s admission interval versus final60s of the no-new-send interval. CPU is percent of one core; RSS is median of batch totals, mib.

| case | load CPU / RSS | final-minute CPU / RSS |
| --- | --- | --- |
| local idle |16.17 /144.25 |16.01 /153.78 |
| large control |33.92 /386.84 |18.32 /565.16 |
| large candidate |33.76 /409.59 |17.86 /626.96 |
| peer idle |22.72 /243.58 |22.07 /254.75 |
| outage control |42.64 /363.36 |24.55 /414.58 |
| outage candidate |41.68 /375.00 |24.75 /432.14 |

CPU approaches idle after load stops; RSS does **not** return to the fresh-idle baseline. retained tasks, receipts, quarantined envelopes and allocator high-water are still present. large-case peak tree RSS reaches659.30mib. this is measured non-recovery, not a leak attribution and not a normal-load budget pass. the four-task screen cannot establish stability for these much larger retained cohorts.

## reproduction and verification

use the initial report's private-root/broker/revision setup and commands. additionally compile the macos-only owned-pid sampler (no installation):

```sh
cc -O2 -Wall -Wextra -Werror scripts/relay-perf/native-resources.c \
  -o "$EVIDENCE/native-resources"
# add nativeSampler:"$EVIDENCE/native-resources" to every case config.
# candidate source must resolve to clean revision4258e593e883761e0af2cbfd14b35469780508dc.
RELAY_PERF_NATIVE="$EVIDENCE/native-resources" PI_TASKS_SOURCE="$ADAPTER" \
  bun test tests/unit/relay-perf-measurement.test.ts \
  tests/unit/relay-perf-summary.test.ts tests/unit/relay-perf-native.test.ts \
  tests/unit/relay-perf-archive.test.ts
```

`nativeSampler` is a JSON string containing the expanded absolute path, not a literal shell variable. source/revision and existing SDK must be explicitly pinned. final focused result:6 pass,0 fail,41 assertions, no skips; TypeScript no-emit and diff whitespace checks exit0. native test skips without its binary; archive test skips without `PI_TASKS_SOURCE`, so default skip results are not qualification. no repository-wide suite was run for this benchmark-only addition.

| config changes from initial example | cases |
| --- | --- |
| candidate pin; `archiveEvents:0`, `sendIntervalMs:1000`; relays1/2, `load:false` | three matched idle trials each |
| same; `load:true`, `archiveEvents:0`,1000,10000 | three per topology/volume; reverse order in trial two |
| candidate; `archiveEvents:0`, `fixedCohort:true`, `load:false`, `seedMailbox:0` or4, `durationMs:300000` | four screens; reverse cohort order for peer |
| omit `archiveEvents`; `sendIntervalMs:100`, `loadDurationMs:70000`, `durationMs:180000`, warmup10000; payload16384/local OR1024/peer + `fault:"outage"`, `recoverAfterMs:30000` | one each on control/candidate |
| omit `archiveEvents`; candidate, `load:false`, duration180000, warmup10000 | one idle control per topology |

one initial native pilot exposed Mach-tick conversion error; its CPU figures are excluded. the focused regression failed at a0.0243 ratio before conversion and passed after. full artifacts preserve pilot failures, not just successful runs. private evidence also contains per-run configs, exact exits/durations, source/environment receipts, native samples, structured HTTP/failure/health traces and all distributions. the local `.plans/314-relay-performance.md` records durable evidence locations and cleanup receipts. do not publish synthetic credentials or endpoint/session identities.

## acceptance map

| #339 criterion | disposition |
| --- | --- |
| exact pins, hardware, workloads, budgets, reproducibility | initial report + this supplement |
| real local/peer acceptance → incorporation → delivery ACK | core matrix plus actual inbox/history insertion; model/task-completion/parent-ACK explicitly distinct |
| idle, leases, queue/receipt occupancy, terminal IO, sustained load, archive comparison | initial matrix;18 volume trials + six controls; four fixed-work screens |
| distributions, repeated trials, event loop/CPU/tree/peak RSS | per-trial reports/raw evidence; live exact-pid native accounting; worker not double-counted |
| capacity, slow peer, outage, exhaustion, recovery/outcomes | initial fault cases + old/candidate post-load trajectories; incomplete recovery disclosed |
| budget decisions / smallest corrections | timing/resource targets meet measured scope; peer transient-failure target misses; issues26/27 before any production optimization |
| preserved delivery/security contracts for later corrections | explicit acceptance constraints in26/27; production code untouched here |
| tested/unverified boundaries and private evidence | this section; physical TLS/tailnet/devices remain254; installed/full-extension/model/rebind behavior not claimed |
