# Memory-owned relay: proposed contract (#351)

Status: **defaults approved; implementation in progress, no production cutover**.
Based on merged #359 (`175861b49045e5c5e7859261f081aa8d912d0a4c`).
The user approved destination-mailbox-confirmed acceptance, bounded retries/hard
pre-admission limits, and best-effort private investigation logging on 2026-09-08.
Neither existing installations nor historical files are changed.

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

## Experimental same-host HTTP integration

`WOLFPACK_TASK_RELAY_PROFILE=volatile-v1` explicitly selects the memory engine when
the server singleton is first constructed. Unset selects `durable-v2`; unknown
values fail initialization rather than falling back. Selection is immutable for
that singleton, not a hot switch. This is experimental plumbing, not a deployment
instruction or completed #351 cutover.

- `GET /api/task-relay/profile` reports selected profile, endpoint path, and the
  volatile instance's epoch. This is **not readiness or liveness evidence**.
- `POST /api/task-relay/volatile-v1` exposes connect, local resolve/send,
  receive, individual acknowledge, disconnect and health. It inherits the actual
  server's origin/JWT policy; no new per-session tenant isolation is implied.
- Metadata and endpoint handlers share a 24-request pre-body/operation cap.
  Bodies are limited to 64 KiB, strict UTF-8 JSON, and a 5-second body-read deadline.
  Capacity failures are explicit; these encoded/application limits are not an RSS
  guarantee. HTTP slots are shared, not a reserved ACK lane.
- Legacy v2 routes fail `INCOMPATIBLE_PROTOCOL` before admission in this mode.
  Legacy endpoint-only RPC lookups intentionally return no volatile endpoint.
  Normal discovery/readiness now uses the explicit transport-registration path
  below, not those legacy lookups.
- HTTP peer ingress now additionally requires an epoch-bound Ed25519 signature
  verified against canonical HTTPS identity and host-controlled same-user Tailscale
  topology. A valid JWT, claimed origin or forwarded header is still insufficient.
  Ordinary endpoint ingress rejects peer/topology commands; nonlocal endpoint IDs
  must be aliases created through the host-verified `/resolve-peer` route.
- Source-owned Control API schemas describe these experimental routes. No legacy
  relay state is migrated, replayed, rewritten or removed. Existing `tasks/v1`
  persistence is a separate domain and is unchanged.

Validation uses private loopback HTTP, the real middleware and worker, synthetic
broker identities and explicitly pinned pi-tasks source/SQLite.
`tests/integration/task-relay-compiled-adapter.test.ts` additionally embeds the HTTP
host and named relay worker in a standalone Bun binary, removes its private build
source/dependency paths, verifies the binary hash before each launch and runs away
from the source checkout. The actual adapter/core/SQLite exercises lost accepted
send replies with identical retry, lost ACK replies and reopen, sparse ACK gaps,
worker replacement, durable reset/rebind, historical-task fences, a synthetic
canonical terminal lifecycle and rollback to the durable profile. JWT middleware
and unsigned-peer denial remain in the path; legacy-file sentinels stay unchanged.

This is compiled-host/worker fixture parity, not the packaged release CLI/native
broker, installed extension, live Tailnet/TLS/device, model execution or performance
proof. Both cross-repository tests require `WOLFPACK_PI_TASKS_SOURCE` (absolute
tracked-clean checkout) and `WOLFPACK_PI_TASKS_REVISION` (exact 40-hex HEAD); otherwise
they are explicitly skipped.

## Coordinated extension and registration readiness (cutover branch)

The paired pi-tasks cutover branch uses memory-owned transport in its normal
extension without an opt-in flag. It owns startup/polling/shutdown/SQLite close,
refuses automatic downgrade, and offers an explicit loss-accepting rebind command.
Existing legacy endpoints require deliberate rebind; history is not adopted.
This is source integration, not an installed extension or coordinated release.

Host-only `registrationsForSessions` reads one request-local batch from the active
engine and exposes only endpoint, profile, lease expiry and volatile epoch (never
registration generation). `session status` and `session list` retain opaque
`taskEndpoint` and add `taskTransport` with that registration. Both responses are
`Cache-Control: no-store`; dead/expired transport observations are not advertised.
Legacy endpoint-only RPC stays incompatible in volatile mode.

Both production task-worker creation routes select the actual server profile and
use the new registration lookup. Readiness checks exact live broker ID, canonical
root and Pi harness, then a live profile-compatible registration, re-inspects the
broker, and confirms the same profile/epoch/endpoint with a still-live lease before
returning the opaque endpoint. Lease renewal may extend expiry; replacement,
expiry and epoch/profile changes fail closed and clean up only the created ID.
This is a point-in-time transport observation, not a model-execution guarantee or
an exclusive lease. The endpoint-only lookup remains a low-level compatibility
input for pre-existing programmatic callers, not the production route path.

Server default selection remains staged until remote CLI/consumer integration and
rollout coordination are complete. Neither normal installed server nor broker is restarted
by these branches. Tests cover the real middleware/worker discovery path and
synthetic exact-ID readiness/reset races; native broker, real Pi process, packaged
release, two-machine and final-path performance gates remain separate.

## Signed same-user federation

The host owns an ephemeral Ed25519 key pair per relay epoch. It is never stored on
disk, exposed through a signing API or used as recovery authority. The authenticated
`GET /api/task-relay/volatile-v1/identity` returns only profile, epoch, canonical
origin, Tailscale node ID and public SPKI key. Metadata does not prove model/task
readiness. The identity handler has four separate HTTP admission slots, independent
of ordinary endpoint work and the four peer-ingress slots.

`POST /api/task-relay/volatile-v1/peer` preserves global CORS/JWT checks and requires
`x-wolfpack-relay-signature`. It signs a domain-separated tuple of destination
origin and the exact raw UTF-8 request, including source/destination epochs and
immutable wire envelope. Before mailbox admission, the receiver checks:

1. Local Tailscale status is Running; its configured canonical origin agrees with
   the online untagged Self node and a nonzero user ID.
2. The source is an unambiguous online untagged node of that same user, authorized
   by local control-plane status, not remote payloads or forwarded headers. The
   existing status cache has a one-second TTL; this is not instantaneous revocation.
   Foreign-user/shared/tagged nodes fail closed, rather than silently becoming
   trusted task senders. A broader policy needs separate review.
3. A no-redirect canonical HTTPS lookup yields that exact source node/origin,
   current source epoch and an Ed25519 public key. The response is strict UTF-8,
   bounded to 4 KiB, and never cached as durable routing/recovery authority.
4. The signature covers the exact raw body and this destination origin; local
   topology and the destination epoch are checked again after I/O.

All outbound attempts recheck peer topology/identity/epoch and sign only frames
from the worker-owned forwarding callback. Per-controller signing/verification
has eight slots, separate four-slot identity headroom, and a four-second total
operation bound inside the existing five-second peer callback. Timeouts/unknown
outcomes still use immutable retries and terminal exhaustion; no envelope metadata
is reconstructed. The worker remains responsible for complete-content conflicts,
individual ACKs, destination acceptance and deduplication of legitimate repeats.

`POST /api/task-relay/volatile-v1/resolve-peer` validates the caller's live local
binding before network lookup, derives the peer epoch from the verified identity,
and invokes host-only topology RPC. It never accepts caller-supplied peer epochs or
keys. JWT remains additive: configured peers must accept the deployment's existing
short-lived JWT credentials; machine signatures do not bypass a 401. Independent
JWT configurations require authentication coordination, just like remote CLI
control. No credentials are sent to an origin before local topology authorizes it.

Tests exercise signature/content/destination/epoch/node/topology failures,
revocation rechecks, bounded cancellation/admission and unchanged JWT enforcement.
Two fresh isolated processes run production HTTP/auth/worker routes and actual
pinned task cores through canonical completion, accepted-response loss/identical
retry, guest denial and tampering. Their Tailscale status, broker and HTTPS-to-
loopback network mapping are synthetic: **not live TLS/certificate, physical
Tailnet, installed extension, native broker or model-execution proof**.

## Staged gateway/worker integration (after #360)

`VolatileRelayGateway` now drives the bounded engine with fresh broker inspection,
explicit profile/epoch/endpoint bindings, true per-delivery cursors and
mailbox-confirmed acceptance. The initial slice exposed only explicit programmatic
`WorkerRelayGateway({ profile: "volatile-v1", ... })` construction. The experimental
same-host HTTP slice adds explicit server startup selection. The paired source
extension now switches its default, but installed adapters have **not** switched. Do not enable it on an installation
before coordinated adapter, discovery and release validation is complete.

The two worker modes are mutually exclusive. Volatile initialization does not
construct a legacy gateway or inspect/replay its ledger. Legacy registration
calls to a volatile worker fail incompatible protocol; volatile calls to a legacy
worker fail `RELAY_PROFILE_REQUIRED`. There is no durability fallback or new
worker replacement/replay loop. Existing worker ownership, transfer admission,
callback and termination rules remain.

The staged RPC contract is defined in `src/task-relay/volatile-protocol.ts`:

- `volatile`: endpoint commands. `connect` requires `profile`, caller, generation
  and protocol versions; a supplied old epoch fails before re-registration.
  Subsequent commands require the returned epoch **and exact endpoint**, not just
  caller name. A renewed/replaced generation cannot silently consume an old
  cursor/mailbox. Results carry the current profile/epoch and a tagged value.
- `volatileTopology`: host-only `resolvePeer`, from freshly verified topology.
  It must never accept an endpoint-supplied URL as routing authority. The gateway
  checks the caller binding and canonical origin; the integrating host still
  owns discovery/handshake verification. Ordinary endpoint ingress rejects this
  command.
- `volatilePeer`: trusted peer ingress, using the reserved worker queue/lane.
  The future production route must enforce the inherited Tailnet/JWT federation
  policy before calling it. Ordinary endpoint ingress cannot impersonate it.
- A peer alias binds **origin + peer epoch**, not origin alone. Both remain
  bounded by the route/metadata budgets. On forwarding, the target alias supplies
  the expected destination epoch; the receiver normalizes the source into an
  origin/source-epoch alias. Thus normalized envelope hashes bind remote
  lifetimes while endpoint IDs remain opaque UUIDs. Changed epochs produce new
  aliases, not an in-place rewrite of pending envelope identity/content.
- Successful send values never contain `pending`: they contain the actual
  destination acceptance ID. Pending/unknown peer delivery is retryable
  `PEER_UNREACHABLE`; final exhaustion is non-retryable
  `DELIVERY_UNCONFIRMED`, explicitly possibly delivered. Terminal receipts cannot
  rearm. Concurrent same-content sends share one attempt; different content is
  checked before coalescing.
- Endpoint retries drive forwarding. Five-second network deadlines include the
  response body; replies are bounded to 4 KiB and must match profile, epoch,
  envelope ID, acceptance ID and local destination disposition. Late replies
  cannot mutate a finalized attempt. Observing completion status never starts
  another network attempt. Broker inspection is bounded to 15 seconds.
- A one-second timer runs bounded engine expiry. Investigation cleanup requests
  coalesce through the writer at most once a minute, including while idle;
  sanitized degradation warnings are rate-limited to once a minute. Ordinary
  delivery does not wait for logs. Files are under the dedicated
  `investigation-volatile-v1` directory; historical ledger files are untouched.
  Graceful inline close may drain logs, but worker termination can lose them.

The `/api/task-relay/volatile-v1` paths are **provisional integration-fixture
paths, not mounted production routes or a published stable Control API**.
`tests/integration/task-relay-volatile-process.test.ts` runs two disposable Bun
processes, each with its own real relay worker, using loopback HTTP. It withholds
confirmation after actual destination acceptance, retries immutable content,
checks sparse delivery/ACK and process-epoch reset, and preserves malformed old
ledger sentinels. Broker inspection and canonical-origin-to-loopback routing are
explicit test doubles; this is not production auth/discovery, live Tailnet or
Pi task/model execution. The existing compiled-worker test also exercises the
volatile local send/receive/ACK path from a standalone binary outside source cwd.

Upstream [pi-tasks#19](https://github.com/almogdepaz/pi-tasks/pull/19) separately
implements stable owner-persisted timestamps and documents legacy pending-row
quarantine. It is not a volatile adapter: actual sparse cursors, live-process
reset/rebind, terminal transport-error quarantine and coordinated release/parity
remain outstanding. No claim of production activation, end-to-end adapter
compatibility, measured latency/RSS improvement or #351 completion follows from
this staged gateway slice.

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

1. Acceptance/no-rearm, hard bounds and logging-loss defaults are approved.
   Finish the coordinated wire field/error/expiry and compatibility-cutover
   contracts in Wolfpack and adapter docs; do not silently cut over old clients.
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

### First implementation slice (not connected to production)

- `src/task-relay/memory-store.ts`: instance-owned epoch, registration/generation
  and route indexes, owned encoded active envelopes, per-mailbox monotonic decimal
  cursors, atomic multi-budget admission, ACK release, compact receipts, and
  token-owned forwarding attempts. No root/path, filesystem, network or timers.
- `src/task-relay/expiry-index.ts`: indexed min-heap with exactly one node per
  expiring owner. Renewals replace nodes; maintenance processes a bounded batch.
- `src/task-relay/investigation.ts`: data-only capture into an independently
  bounded async queue. Queue accounting includes the in-flight write. A fixed-slot
  private writer rotates before overflow; partial historical records are never
  appended into on restart. A coalesced cleanup request uses the same writer queue
  to avoid races and permit idle retention cleanup. Gateway timer wiring remains.
- `tests/unit/task-relay-memory.test.ts` and
  `tests/unit/task-relay-investigation.test.ts`: budget/ownership/expiry/cursor,
  retry and log-failure tests, including two independent engine instances with
  a lost peer response and 5,000 completed payloads. These are **not** real HTTP,
  worker packaging, actual adapter, two-host, or performance measurements.

The engine keeps routes stable for its lifetime rather than silently evicting
aliases. Expired registrations remain pinned by obligations/receipts. Its current
retry policy uses the immutable wire creation timestamp with 30 seconds of clock
skew allowance, a two-minute admission/attempt-start horizon, and the agreed
15-minute terminal receipt window. No new network attempt starts after deadline;
a still-owned bounded in-flight call may subsequently confirm acceptance.
The gateway must enforce network deadlines; worker loss instead loses its epoch.

Receipt byte reservations are conservative upper bounds for retained metadata,
not native allocation measurements. Registration and receipt counts also bound
secondary indexes. The byte ceiling can bind before the count ceiling; the
receipt window limits sustained admission rate and must be benchmarked/tuned
rather than advertised as unlimited throughput.

The writer retains at most 16 × 16 MiB fixed segments. Age is measured from
segment creation, never refreshed by appends. Unknown filesystem creation times
expire conservatively. Cleanup requires the gateway timer while running and
rechecks old slots on next startup; no cleanup service runs while Wolfpack is
stopped. Investigation health exposes dropped/invalid records, dropped bytes,
write/maintenance failures and bounded error categories, without raw exception
messages. Exporting health and rate-limited warnings at the gateway remains.

`TaskRelayGateway`, its worker entry, HTTP routes and the installed adapter still
use the existing contract. The new engine is deliberately not a drop-in store
facade: negotiation, broker-authorized gateway integration, explicit cursors,
live-process reset handling and upstream immutable timestamp/terminal-error
handling must land together before changing production behavior. No benchmark or
release-readiness claim follows from this isolated engine slice.

### Initial engine validation and remaining failures

At `4d5b3f971f60953902f33372fe647fa1f3022ec6`, typecheck passed and the
full unit suite reported **1,698 pass, 1 skip, 0 fail**. Three private mutants
were rejected by their focused regressions: retained ACKed payload/mailbox rows,
exhaustion disguised as pending, and a stranded logger completion wake.

The full integration suite reported **427 pass, 22 broker-dependent skips,
1 fail**. The unchanged `control-api-schema-temp-cleanup.test.ts` child hit its
3-second timeout (exit 137). The same failure reproduced in a clean worktree at
merged base `175861b49045e5c5e7859261f081aa8d912d0a4c`; that isolated probe was
also marked incomplete because the executor terminated lingering descendants.
No timing bound or unrelated test was weakened. The temporary baseline worktree
was removed after preserving evidence. This is **not** an all-green integration
or native validation result. Subsequent hardlink rejection in the investigation
writer is additional source hardening, not a fix for that baseline failure.

The cleanup regression is now isolated from the operator's login-shell startup
and installed provider CLIs: its child has private shell/executable-probe/Pi
fixtures, while still executing the real schema HTTP suite and provider version
probe. The original 3-second child and 4.5-second outer deadlines are unchanged.
Instrumentation established that the stdin gate completed; server login-shell
initialization followed by real `/api/providers` probes consumed the deadline.
Merely setting the inherited PATH was insufficient because server import restores
the login-shell PATH. The fixed test additionally checks unchanged sentinel
contents and that the owned provider was actually probed. A private unsafe-cleanup
mutant completed the eight schema tests but failed on the deleted sentinel,
confirming this is not a weakened or vacuous cleanup regression.

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

Recorded on audit revision `43dc7af3ca74c1ad452eb6cd155d609a0d07f475`, using
installed `@sgtbeatdown/pi-tasks` 0.1.7 (adapter source SHA-256
`42380e582702b59071f26323c6fd1fec41b198954f289379317f8e5dd0b2605d`):

- Injected lost response produced `RELAY_UNAVAILABLE`; retrying the same logical
  envelope produced **`ENVELOPE_CONFLICT`** because wire `createdAt` changed.
- The real gateway accepted the original only once; exact-wire retry returned
  `duplicate`, and genuinely changed payload still returned `ENVELOPE_CONFLICT`.
- Simulated removal of cursor 1 exposed a real second-page envelope at cursor 2;
  the installed adapter assigned it **cursor 1**, confirming incompatibility with
  pending-only pages, not demonstrating a current retained-row paging failure.
- Audit exit **1** (defects reproduced). Typecheck and diff checks passed on that
  revision. No production behavior was changed; neither bug is fixed by this
  design/audit commit. This is not an end-to-end task-core or live-network test.
