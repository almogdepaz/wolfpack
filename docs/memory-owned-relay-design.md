# Memory-owned relay: proposed contract (#351)

Status: **design/compatibility gate, not implemented or approved for cutover**.
Based on merged #359 (`175861b49045e5c5e7859261f081aa8d912d0a4c`).
This document proposes the decisions needed before replacing the operational
store. Neither existing installations nor historical files are changed.

## Scope and ownership

Each relay worker owns its registrations, opaque peer routes, pending mailboxes,
forwarding attempts and compact receipts in memory. No SQL, shared filesystem,
spool, crash journal, startup replay or full-state snapshot rewrite is involved.
Investigation output is separate and never read to authorize normal delivery.

The existing worker admission/transfer limits, caller/session/generation/lease
validation, peer trust boundary, content-blind payload validation, canonical
content conflicts and forwarding single-flight remain. This is not a new
inter-session security boundary. `tasks/v1` and endpoint-owned `pi-tasks/v2`
task records, events and task authority are not redesigned.

Restart durability was already ruled out by #351. Loss of a relay process can
lose even accepted messages. Endpoint task storage surviving that loss does not
mean transport replay or successful delivery is guaranteed.

## 1. Recommended acceptance and retry contract

**Transfer ownership only after the destination mailbox accepts**, not when the
source merely queues an outbound attempt. This works with the endpoint core's
existing distinction between pending and relay-accepted outbox entries:

- Local success: this process owns the destination mailbox entry.
- Remote success: the destination relay confirmed its mailbox acceptance. The
  source may release its forwarding payload and retain a compact receipt.
- Remote unresolved: return a retryable transport error, **not successful
  acceptance with `forwarding: pending`**. The endpoint keeps its pending outbox.
- Response loss is an unknown outcome, not proof of rejection. Retry identical
  content/identity; a destination that already accepted returns the same receipt.
- Retry calls coalesce on one in-flight attempt per identity. Capacity and
  cooldown rejections do not consume a network attempt. Propose four actual
  attempts, at least one second apart, within two minutes of first admission;
  retries do not refresh that deadline.
- Exhaustion returns a stable terminal `DELIVERY_UNCONFIRMED` outcome, including
  that delivery may have occurred. It must never return misleading `pending`.
- Initially, **no same-ID rearm after exhaustion**. Keep that result throughout
  the receipt window. A genuinely new logical operation is an explicit endpoint
  decision, with duplicate-effect risk disclosed; never invent one automatically.

Source-side background attempts, if retained, obey those same limits and cannot
cause the endpoint outbox to become accepted before the client sees confirmation.
A simpler first implementation can let endpoint retries drive forwarding and
retain only bounded in-flight/attempt metadata between calls.

Destination mailbox acceptance is not endpoint persistence, Pi insertion, model
execution or task completion. Accepted, unacknowledged mailbox payloads are **not
silently age-evicted** to make room. Hold them until transport acknowledgment or
process loss; full mailboxes backpressure new admissions. Expired leases prohibit
delivery but do not themselves discard accepted payloads. Endpoint generations
with outstanding obligations remain separately indexed; a new generation cannot
consume the old generation's mailbox. Explicit abandonment/retirement, if added,
needs an observable terminal transport result rather than silent reclamation.
This conservative policy can leave capacity occupied by an abandoned endpoint;
that is a deliberate tradeoff, not unlimited memory or a recovery guarantee.

## 2. Proposed bounds and receipts

Initial values for review, not measured memory/SLO claims:

| Resource, per worker | Count ceiling | Encoded-data ceiling |
| --- | ---: | ---: |
| All active envelope payloads, including forwarding | 4,096 | 64 MiB |
| One destination mailbox (subset of global) | 256 | 8 MiB |
| One peer's pending forwarding (subset of global) | 128 | 8 MiB |
| Compact receipts/attempt outcomes | 50,000 | 8 MiB |
| Registrations and retained generations | 2,048 | Shared metadata pool |
| Peer routes | 2,048 | Shared metadata pool |
| Other operational metadata/index keys | Bounded by owner counts | 16 MiB |
| Investigation queue, independent of active payload pool | 1,024 | 4 MiB |

Existing HTTP/payload/page and worker transfer limits remain independent caps.
Retain each active envelope in an owned encoded representation, not a retained
parsed object graph plus a historical full-state array. Budget headers and
payload, not just payload. Validate scalar/key lengths, use exact counters and
bounded expiry indexes; repeated renewal must not accumulate stale heap entries.
Encoded bytes and object counts are not native heap or total-RSS guarantees.

Reserve message, metadata and eventual receipt credits atomically **before**
acceptance. Reject with retryable `RELAY_CAPACITY` and a retry hint when full;
never evict an accepted entry or an unexpired receipt to admit another. Repeated
duplicates must not consume additional credits. Acknowledgment releases the
active payload charge; separate logging references remain charged to logging.

Propose a **15-minute compact receipt window after terminal disposition**, pinned
longer while the associated payload is active. Retain identity, canonical digest,
acceptance/result, scope and expiry, but no completed payload. Duplicate retries
do not extend expiry. Terminal outcomes also reserve bounded receipt capacity.
Deduplication is not forever and not across process lifetimes. A retry outside
the agreed horizon is not promised duplicate acceptance. The coordinated protocol
needs immutable, owner-persisted creation/deadline metadata so a conforming late
retry is rejected even after its receipt expires. A forgotten ID alone cannot
prove that a request is old. Define clock-skew tolerance, check existing receipts
before treating an identity as new, and test expired-retry rejection. Deliberate
ID/content reuse after the window is not covered by a forever-deduplication claim.

## 3. Investigation policy — requires explicit agreement

Recommendation: bounded, private, **best-effort** append-only investigation logs,
not a second delivery authority. Capture validated payload once for an admitted
message and metadata for acceptance, forwarding attempts/outcomes, ACK, rejection
and process epoch. Do not log arbitrary malformed/unauthorized request bodies.

- Local-user-only directory/files (0700/0600). Payloads may contain sensitive task
  content; neither automatic upload nor a public log-reading endpoint is added.
- Propose 24-hour retention and 256 MiB total rotated output, whichever binds
  first; rotation must bound temporary overshoot. Existing historical relay files
  are outside this new writer's rotation/deletion scope.
- Bounded asynchronous queue; ordinary delivery does not await log writes/fsync.
- Queue overflow/disk failure drops investigation records, **not accepted work**.
  Expose degraded health, dropped-record/byte counts and bounded error metadata;
  warnings are rate-limited. No silent assertion of complete audit coverage.
- Abrupt exit can lose queued records. Even a successful relay acceptance is not
  proof its investigation record reached disk. No crash-recovery replay.

If complete investigation coverage is required instead, choose fail-closed
pre-admission logging backpressure explicitly. That is a different availability
contract and should be resolved before implementing the writer.

## 4. Cursor, epoch and adapter contract

Use a negotiated new transport profile (working name **`volatile-v1`**) rather
than silently replacing v2 guarantees underneath old clients/peers. Old clients
must fail explicitly before registration/acceptance; do not fall back to a
file-backed or silently compatible-looking mode. Final wire/schema naming and
adapter release coordination are implementation gates.

- Each worker lifetime has a fresh epoch. Registration/receive/ACK/send scope is
  checked against it; opaque endpoint/routing identities cannot silently alias
  old lifetimes. Startup does not inspect legacy relay-state contents.
- Epoch mismatch is an explicit reset error, not an empty inbox or acceptance of
  a stale endpoint. Re-registration does not authorize rewriting old task source
  or target identities. The owning adapter must stop/surface stale bindings and
  perform its explicit rebind flow; no transparent task recovery is promised.
- Cursor counters are monotonic per mailbox. Return each delivery's **actual
  decimal cursor**; deleting completed rows creates gaps, not renumbering.
  Keep decimal strings end-to-end, with no safe-integer conversion or synthesized
  `requestCursor + arrayIndex`. Reject out-of-scope/future cursors explicitly.
- `nextCursor` reflects the last returned delivery, not a discarded/truncated
  suffix; empty pages do not fabricate advancement. Respect requested page limits
  on the server and existing item/byte caps. ACKs remain identity- and owner-bound.
- Restart/reset negotiation must be handled while an existing Pi process is
  still running, not only when `createWolfpackTaskCore` first initializes it.

The installed pi-tasks 0.1.7 adapter currently regenerates wire `createdAt` in
`toWolfpackEnvelope`, synthesizes numeric delivery cursors and ignores forwarding
status when an acceptance ID is present. Its core marks successful sends accepted
and subsequently flushes pending rows only. It currently quarantines terminal
`TARGET_NOT_REGISTERED` specifically, not every new terminal transport code.
Adding a new error name alone will therefore not stop its repeated flushes.

Recommended timestamp contract: persist immutable transport creation/deadline
metadata with the originating endpoint's outbox envelope, and derive the wire
`createdAt` from that value on every send. Receipt/admission time remains separate.
The existing envelope serialization can own this transport metadata without a
second database or redesigning canonical task events. Its exact upstream schema
and treatment of preexisting outbox entries need coordinated source review.
**Do not exclude `createdAt` from conflict hashing**, invent a new timestamp on
retry, or rely on an adapter in-memory cache that disappears on restart. Every
admitted immutable header and opaque payload remains part of content identity.

Required upstream changes are narrow transport encoding/cursor/reset/error
handling, reusing existing endpoint task authority and quarantine mechanisms.
Do not edit the installed package as the implementation or introduce a second
endpoint task database. Release and installed-package parity need separate,
authorized coordination.

## 5. Verification and implementation sequence

1. Resolve the acceptance/no-rearm, logging-loss and compatibility-cutover choices
   above. Record final field/error/expiry contracts in Wolfpack and adapter docs.
2. Add behavior tests for a bounded, instance-owned engine: atomic multi-budget
   admission, credit recovery, ownership, opaque keys, genuine content conflicts,
   strict leases, cursor gaps, duplicate ACKs, expired receipts and bounded expiry
   indexes. No filesystem reads or full-state reconstruction in hot paths.
3. Integrate the engine behind #359's worker boundary and the negotiated profile.
   Implement bounded investigation output independently. Preserve old files in
   place; do not import them as live state or delete them during startup.
4. Coordinate the adapter source change. Test actual adapter → actual relay
   acceptance followed by lost response, identical retry, changed-content
   conflict, sparse/truncated pages, live-process epoch reset and terminal retry
   handling. Check adapter restarts, not merely an in-process timestamp cache.
5. Verify local and isolated two-process/two-relay delivery → receive → ACK;
   concurrent retries, outage/recovery/exhaustion, renewal, capacity and logging
   failure. Replace obsolete persistence expectations without dropping live
   routing/authority coverage. Run broad integrations including task-gateway and
   real compiled-worker packaging, not just the earlier selected #359 suites.
6. Benchmark exact revisions with fixed active work and varying archived history,
   including empty/1k/5k × 1 KiB and 1k × 16 KiB histories, local and simulated
   peer traffic. Measure complete delivery/ACK, renewal, event-loop latency, CPU,
   process RSS including workers and accounting high-water marks. Publish commands,
   input hashes, hardware, latency budgets, failures and regressions. Archive size
   must not change operational parse/scan/write work; this is not live-fleet proof.

### Compatibility reproduction

`scripts/relay-memory-compat-audit.ts` accepts an explicit absolute adapter source
path. It creates a private real gateway/store, injects response loss *after*
acceptance, retries the same logical envelope and checks exact-wire deduplication
and genuine changed-content rejection. It separately simulates the proposed
post-ACK cursor gap using a real second-page response; that gap is not a claim
about current v2's retained-row behavior. No task core/store, live HTTP/Tailnet,
broker, installed-package modification or service restart is involved.

The audit exits nonzero when it reproduces compatibility defects. This is a
pre-change diagnostic, not a passing regression proving the redesign works.
