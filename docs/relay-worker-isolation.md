# Relay worker isolation

The server's task-relay v2 singleton runs its existing gateway/store on one dedicated Bun worker. HTTP admission/authentication and broker-owned session inspection remain on the server thread. The worker asks that thread for a fresh inspection at the original gateway inspection boundary; it does not maintain a second session registry or infer caller identity from terminal text.

This is responsiveness isolation, **not** the memory-owned transport redesign in #351. The relay's version-2 file, canonical digests, atomic replacement/fsync, leases, first-active registration selection, cursors, deduplication, retention, peer routes and restart recovery remain authoritative. Task ledgers and endpoint-owned Pi lifecycle are unchanged. The worker has the server's local-user authority; it is not a sandbox or an inter-session security boundary.

## Bounds and failure semantics

- Maximum 28 ordinary requests / 3 MiB of submitted arguments, plus a reserved 4 peer-receive requests / 1 MiB. An individual request is capped at 256 KiB; a worker result at 1 MiB. These are new internal overload limits, not new public wire fields. Oversized or overloaded operations fail closed; no silently evicted accepted delivery is claimed.
- At most four ordinary operations and two peer-receive operations execute concurrently. Peer ingress has separate capacity so simultaneous outbound forwarding on two machines does not consume every ingress slot. The bounded existing forwarding/single-flight logic remains in the worker.
- Background outbox maintenance has one in-flight pass; slow forwarding does not accumulate another retained history scan each second. Retry attempt limits and time eligibility are unchanged.
- Argument ownership is captured before waiting. Structured cloning, not JSON normalization, preserves invalid values for the existing validator. No cross-call parsed-payload cache is introduced.
- Startup deadline is 30 seconds; admitted-request deadline is 60 seconds, including queue time. A deadline or worker failure stops admission, rejects outstanding callers, and terminates the owner. The singleton remains unavailable until server restart; it does not silently replay requests or start a competing writer.
- An interrupted mutation **may already have committed**. `STORE_UNAVAILABLE` is retryable but is not proof of rejection before acceptance. Retry with the same envelope identity and unchanged content; existing durable deduplication resolves a lost response. No new task-adapter guarantee is implied.
- Close rejects unresolved requests and waits for confirmed worker termination before permitting an explicit replacement of that resolved root. Server shutdown does not restart the broker. Long startup recovery/backlogs can hit the new deadline; partial durable progress is preserved for a subsequent server restart.
- The production singleton is the sole in-process worker owner. Concurrent inline `TaskRelayGateway`/`TaskRelayStore` access to its root is unsupported. This is not an inter-process lock, filesystem-alias fence, or new cross-process linearizability guarantee.

Host inspection callbacks are bounded and late results cannot reach a closed/replaced worker. A bounded injectable peer-fetch bridge exists for isolated transport tests; the production singleton uses the existing fetch/redirect/timeout and canonical peer-origin policy inside the worker.

## Packaging and verification

`build.ts` includes the worker as a second compiled entrypoint with flat `[name].js` entry naming. Bun source runs resolve the `.js` worker URL to TypeScript; standalone builds load the embedded JavaScript. A standalone integration test compiles the actual gateway/worker, hides its probe source and executes from an unrelated temporary cwd. This is necessary: merely compiling the server entry or retaining a `.ts` URL fails in a standalone Bun binary.

Focused coverage includes delivery/ack/restart, alias and map ownership, invalid payloads, durable duplicate/conflict semantics, two isolated peers with lost response and reply, reserved ingress under saturation, real host-inspection failure, fresh malformed state, deadline/termination, late callback fencing, and compiled execution. All stores and callbacks in these tests are isolated; no live Tailnet or broker service is accessed.

The preceding benchmark-only comparison showed millisecond terminal echo despite history-sized relay work, but often higher RSS and unchanged expensive relay completion. Those results do not establish this production bridge's performance. Verify this implementation separately before making a production latency or memory claim; a second VM and bounded concurrency can increase RSS. No merge, installation or deployment is part of this change.
