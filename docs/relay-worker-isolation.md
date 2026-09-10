# Relay worker isolation

The server's memory-only `volatile-v1` singleton runs on one dedicated Bun worker (stable Bun >=1.4.2). HTTP admission/authentication and broker-owned session inspection remain on the server thread. The worker asks that thread for a fresh inspection at the original gateway inspection boundary; it does not maintain a second session registry or infer caller identity from terminal text.

The [memory-only design](memory-owned-relay-design.md) now supersedes the original durable engine. Relay and Pi task state are RAM-owned; Pi session history is an archive, never a replay queue. There is no durable compatibility engine or default disk spool. The worker has the server's local-user authority; it is not a sandbox or an inter-session security boundary.

## Bounds and failure semantics

- Maximum 28 ordinary requests / 3 MiB of encoded argument accounting, plus a reserved 4 peer-receive requests / 1 MiB. An individual request is capped at 256 KiB; a worker result or host callback value at 1 MiB. These byte units are UTF-8 JSON accounting, extended with 9 bytes for `undefined` and a tagged entry representation for result Maps—not native structured-clone buffer or JS heap sizes. These are new internal overload limits, not new public wire fields. Oversized or overloaded operations fail closed; no silently evicted accepted delivery is claimed.
- At most four ordinary operations and two peer-receive operations execute concurrently. Peer ingress has separate capacity so simultaneous outbound forwarding on two machines does not consume every ingress slot. The bounded existing forwarding/single-flight logic remains in the worker.
- Maintenance expires bounded RAM indexes; there are no background history scans or delivery replay. Endpoint retries drive forwarding with original deadlines and bounded actual attempts.
- Bootstrap validates the original options object before any option read or spread: only known enumerable own data properties on a plain, non-Proxy object are admitted. Accessors (including non-enumerable ones), inherited/unknown/hidden fields and Proxies reject without execution. Scalars are type-checked and snapshotted under the 256 KiB cap; the two explicit host callbacks may be function references but are never transferred. Before any request, callback value or result is passed to `postMessage`, a budgeted snapshot admits only finite-number/string/boolean/null/undefined scalars, dense plain arrays and plain data-property objects. String-keyed Maps are additionally allowed for worker results. Buffers, typed arrays, Sets, Dates, custom prototypes, Proxies, accessors, symbols, hidden properties, cycles and functions fail closed—even in ignored extra fields. The snapshot never invokes getters, `toJSON` or custom iterators. It owns all transferred containers, so mutation after capture cannot change admission or content. The worker retains existing protocol/JSON-payload/lease/caller validation. No cross-call parsed-payload cache is introduced.
- Startup deadline is 30 seconds; admitted-request deadline is 60 seconds, including queue time. A deadline or worker failure stops admission, rejects outstanding callers, and terminates the owner. The singleton remains unavailable until server restart; it does not silently replay requests or start a competing writer.
- Interrupted delivery **may already have reached the destination**. A dead worker reports `RELAY_RESET`; its replacement has a fresh epoch and cannot deduplicate from history. Within a live epoch, retry unknown outcomes with the same envelope identity/content. After loss, explicit rebind discards endpoint RAM; never silently replay old tasks.
- Ownership is reserved with a per-instance token before native worker construction. Synchronous construction failure releases only that token; failure after a worker starts requests termination and holds ownership until it is confirmed. Close uses the private original root/token, never a caller-writable public label. Close rejects unresolved requests and waits for confirmed worker termination before permitting an explicit replacement of that resolved root. Server shutdown does not restart the broker. A new worker starts empty; no partial durable recovery exists.
- The production singleton is the sole in-process worker owner for its normalized root namespace. This is not an inter-process lock, filesystem-alias fence, or cross-process linearizability guarantee.

These limits bound the admitted data domain, its encoded accounting and concurrent calls, **not native clone allocations, total RSS or retained file size**. Caller/backend-owned input construction and property inspection can allocate before rejection; they are not a process-memory sandbox. The active store uses bounded RAM indexes. A worker does not protect the server against process-wide memory exhaustion.

Host inspection callbacks are bounded and late results cannot reach a closed/replaced worker. Production peer forwarding uses host-side trusted Tailnet topology and canonical HTTPS without signatures. The complete response is bounded to 4KiB within a four-second policy deadline and five-second callback deadline, including cancellation on worker close.

## Packaging and verification

`build.ts` includes the worker as a second compiled entrypoint with flat `[name].js` entry naming. Bun source runs resolve the `.js` worker URL to TypeScript; standalone builds load the embedded JavaScript. A standalone integration test compiles the actual gateway/worker, hides its probe source and executes from an unrelated temporary cwd. This is necessary: merely compiling the server entry or retaining a `.ts` URL fails in a standalone Bun binary.

Focused coverage includes delivery/ACK/restart loss, alias and map ownership, invalid payloads, live-epoch duplicate/conflict semantics, isolated peers with lost replies, reserved ingress, host-inspection failure, untouched obsolete files, deadline/termination, late callback fencing and compiled execution. All stores and callbacks in these tests are isolated; no live Tailnet or broker service is accessed.

## Historical review correction and measurement provenance

The measurements below describe the retired durable engine and earlier Bun1.3.9,
**not** current memory-only performance or qualification. Boundary regressions
have been ported to the memory-only worker.

Sol's medium finding was reproduced: a 4 MiB ArrayBuffer in a request or inspection result projected to a few JSON bytes and crossed the old bridge. The data-only, budgeted capture above replaces that JSON-projection loophole rather than merely relabeling it. Regression coverage rejects the request and callback independently, retains valid Map/undefined/opaque-key behavior, and verifies aggregate credits recover after completion.

A follow-up review found bootstrap fields were still read directly before capture, allowing a non-enumerable accessor to re-enter construction in the ownership gap. Original-option descriptor admission and token-based pre-construction reservation close that path. Regression tests cover all option getters/Proxies, duplicate ownership, repeated close after replacement, constructor setup failure and asynchronous startup failure.

The historical measurements below predate these capture/bootstrap corrections. They remain evidence for the reviewed `f1a6654` implementation, **not exact-revision measurements of the corrected boundary**. Correction verification and any new measurements must be separately pinned. The harness emits exploratory budgets as metadata; post-run analysis, not an executable harness timing gate, checked the terminal/event-loop comparisons. Retained-history delivery exceeded the exploratory 250 ms budget.

## Measured production bridge (not the earlier fixture adapter)

A private revision-asserting harness imported the actual `WorkerRelayGateway` at `bd71bd43716f97ad5254c62e890297913fd4a699` and compared it with the inline engine at the same revision. Unlike the earlier prototype measurement, real `initialize()`/background maintenance ran, each relay root had its own worker, and calls crossed the production admission/inspection/result bridge. Inputs were the original two echo PTYs, two delivery lanes, periodic renewal, 0/1,000/5,000 retained 1 KiB envelopes and 1,000 retained 16 KiB envelopes. Three six-second trials alternated inline/worker case order, with an independent controller offering input every 50 ms.

On macOS x64 / i7-9750H / 16 GiB / Bun 1.3.9, the final 54-case run completed **6,480/6,480 echoes and 583 deliveries**. Every worker case passed the predeclared absolute and idle-relative terminal/event-loop budgets. Traffic echo p95 was 0.7–1.7 ms with the bridge. Controller dispatch lateness max was 35.2 ms; echo timing begins at actual dispatch, not at a physical/browser keystroke.

| Workload | Inline echo p95 ms | Worker echo p95 ms | Inline sampled RSS peak MiB | Worker sampled RSS peak MiB |
|---|---:|---:|---:|---:|
| Idle | 0.7–1.1 | 0.7–1.1 | 35.8–36.5 | 45.9–46.6 |
| Local, 1,000 × 1 KiB | 302.7–393.7 | 0.7–1.0 | 158.9–172.0 | 176.6–178.6 |
| Local, 5,000 × 1 KiB | 2,491.8–3,141.4 | 0.7–1.4 | 254.1–269.4 | 284.8–327.9 |
| Local, 1,000 × 16 KiB | 2,036.9–2,604.6 | 0.8–1.4 | 372.6–425.9 | 400.3–448.1 |
| Simulated peer, 5,000 × 1 KiB | 4,377.4–4,664.1 | 0.7–1.7 | 257.3–268.7 | 472.7–527.0 |
| Simulated peer, 1,000 × 16 KiB | 3,820.8–7,168.0 | 0.8–1.6 | 421.6–531.2 | 697.4–756.0 |

**Memory/CPU and relay latency are not uniformly improved.** Local 5,000-envelope delivery p95 increased from 1.84–2.49 s to 2.07–2.91 s; CPU remained about one core. Even empty-history local delivery p95 ranged 21.7–116.8 ms with the bridge versus 10.0–18.1 ms inline. The combined peer case used up to roughly two cores and substantially more memory. Those peer figures compare two inline engines sharing one heap with two relay workers in one process; they are **not** a live two-host/fleet memory comparison. One production server owns one relay root.

The RSS figures are experimental process samples, not retained-memory/leak evidence or clean production forecasts. History was seeded in the measured process before timing; allocator/GC carryover can affect RSS. Sampling can miss peaks, and the runtime high-water includes setup (Bun 1.3.9 macOS reports native bytes, unlike Node's documented KiB). Heap fields represent only the measuring VM; RSS/CPU include workers. Transport and session inspection were simulated; HTTP/TLS/browser overhead and live Tailnet behavior were not measured. A preceding complete run at `e52a266` also passed responsiveness budgets but had variable absolute values and a 318 ms controller-dispatch outlier; it is not used as a stable latency forecast.

Final raw JSONL SHA-256: `c9934ddcf4f9d9613eee3d1936303a9f2cbc0d69d0e3be0ade32ea1a1a8db343`. Native broker input was the previously verified #352 build, SHA-256 `fffe78a9fffde8051354d92c01d03425ea841627d589f4573c4aff5660c6ed9e`; broker/lock/patch sources remain unchanged from that build. The private harness and raw logs are retained with the performance-series verification evidence.

This supports responsiveness isolation with explicit costs, not a memory-optimization claim. No merge, installation or deployment is part of this change.
