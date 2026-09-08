# Relay worker isolation

The server's task-relay v2 singleton runs its existing gateway/store on one dedicated Bun worker. HTTP admission/authentication and broker-owned session inspection remain on the server thread. The worker asks that thread for a fresh inspection at the original gateway inspection boundary; it does not maintain a second session registry or infer caller identity from terminal text.

This is responsiveness isolation, **not** the memory-owned transport redesign in #351. The relay's version-2 file, canonical digests, atomic replacement/fsync, leases, first-active registration selection, cursors, deduplication, retention, peer routes and restart recovery remain authoritative. Task ledgers and endpoint-owned Pi lifecycle are unchanged. The worker has the server's local-user authority; it is not a sandbox or an inter-session security boundary.

## Bounds and failure semantics

- Maximum 28 ordinary requests / 3 MiB of encoded argument accounting, plus a reserved 4 peer-receive requests / 1 MiB. An individual request is capped at 256 KiB; a worker result or host callback value at 1 MiB. These byte units are UTF-8 JSON accounting, extended with 9 bytes for `undefined` and a tagged entry representation for result Maps—not native structured-clone buffer or JS heap sizes. These are new internal overload limits, not new public wire fields. Oversized or overloaded operations fail closed; no silently evicted accepted delivery is claimed.
- At most four ordinary operations and two peer-receive operations execute concurrently. Peer ingress has separate capacity so simultaneous outbound forwarding on two machines does not consume every ingress slot. The bounded existing forwarding/single-flight logic remains in the worker.
- Background outbox maintenance has one in-flight pass; slow forwarding does not accumulate another retained history scan each second. Retry attempt limits and time eligibility are unchanged.
- Bootstrap options use the same inert snapshot under the 256 KiB cap. Before any request, callback value or result is passed to `postMessage`, a budgeted snapshot admits only finite-number/string/boolean/null/undefined scalars, dense plain arrays and plain data-property objects. String-keyed Maps are additionally allowed for worker results. Buffers, typed arrays, Sets, Dates, custom prototypes, Proxies, accessors, symbols, hidden properties, cycles and functions fail closed—even in ignored extra fields. The snapshot never invokes getters, `toJSON` or custom iterators. It owns all transferred containers, so mutation after capture cannot change admission or content. The worker retains existing protocol/JSON-payload/lease/caller validation. No cross-call parsed-payload cache is introduced.
- Startup deadline is 30 seconds; admitted-request deadline is 60 seconds, including queue time. A deadline or worker failure stops admission, rejects outstanding callers, and terminates the owner. The singleton remains unavailable until server restart; it does not silently replay requests or start a competing writer.
- An interrupted mutation **may already have committed**. `STORE_UNAVAILABLE` is retryable but is not proof of rejection before acceptance. Retry with the same envelope identity and unchanged content; existing durable deduplication resolves a lost response. No new task-adapter guarantee is implied.
- Close rejects unresolved requests and waits for confirmed worker termination before permitting an explicit replacement of that resolved root. Server shutdown does not restart the broker. Long startup recovery/backlogs can hit the new deadline; partial durable progress is preserved for a subsequent server restart.
- The production singleton is the sole in-process worker owner. Concurrent inline `TaskRelayGateway`/`TaskRelayStore` access to its root is unsupported. This is not an inter-process lock, filesystem-alias fence, or new cross-process linearizability guarantee.

These limits bound the admitted data domain, its encoded accounting and concurrent calls, **not native clone allocations, total RSS or retained file size**. Caller/backend-owned input construction and property inspection can allocate before rejection; they are not a process-memory sandbox. Each active store operation still parses/rewrites history. A worker does not protect the server against process-wide memory exhaustion.

Host inspection callbacks are bounded and late results cannot reach a closed/replaced worker. A bounded injectable peer-fetch bridge exists for isolated transport tests; the production singleton uses the existing fetch/redirect/timeout and canonical peer-origin policy inside the worker.

## Packaging and verification

`build.ts` includes the worker as a second compiled entrypoint with flat `[name].js` entry naming. Bun source runs resolve the `.js` worker URL to TypeScript; standalone builds load the embedded JavaScript. A standalone integration test compiles the actual gateway/worker, hides its probe source and executes from an unrelated temporary cwd. This is necessary: merely compiling the server entry or retaining a `.ts` URL fails in a standalone Bun binary.

Focused coverage includes delivery/ack/restart, alias and map ownership, invalid payloads, durable duplicate/conflict semantics, two isolated peers with lost response and reply, reserved ingress under saturation, real host-inspection failure, fresh malformed state, deadline/termination, late callback fencing, and compiled execution. All stores and callbacks in these tests are isolated; no live Tailnet or broker service is accessed.

## Review correction and measurement provenance

Sol's medium finding was reproduced: a 4 MiB ArrayBuffer in a request or inspection result projected to a few JSON bytes and crossed the old bridge. The data-only, budgeted capture above replaces that JSON-projection loophole rather than merely relabeling it. Regression coverage rejects the request and callback independently, retains valid Map/undefined/opaque-key behavior, and verifies aggregate credits recover after completion.

The historical measurements below predate this capture correction. They remain evidence for the reviewed `f1a6654` implementation, **not exact-revision measurements of the corrected boundary**. Correction verification and any new measurements must be separately pinned. The harness emits exploratory budgets as metadata; post-run analysis, not an executable harness timing gate, checked the terminal/event-loop comparisons. Retained-history delivery exceeded the exploratory 250 ms budget.

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
