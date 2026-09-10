# Memory-only Pi task relay

Wolfpack's only Pi task transport is `volatile-v1` (`pi-tasks/v2`, relay ID
`wolfpack-pi-tasks-v2`). Both relay and endpoint bookkeeping live in RAM. Pi session
history is the historical record, not a recovery queue.

This deliberately assumes honest Tailnet machines. There is no durable-v2 engine,
SQLite endpoint database, signed peer protocol, key discovery, or compatibility
fallback. Existing files are not imported, replayed, migrated or deleted.

## Ownership and loss

- One dedicated Bun worker owns relay registrations, routes, mailboxes, receipts,
  retry attempts and its random epoch. HTTP and broker inspection stay on the host.
- One configured Pi core owns fresh bounded RAM task/event/outbox/receipt/ACK state.
  Closing/reloading that lifecycle discards it. A new process/session lifecycle
  gets a fresh generation and endpoint, even if old Pi session history is loaded.
- Relay restart changes the epoch. An existing endpoint fences its old handles and
  reports `RELAY_RESET`; a lost response may already have reached its destination.
- `/task-relay-rebind --accept-relay-loss` explicitly clears current endpoint RAM
  and establishes a fresh binding. It does not reconstruct or resend old tasks.
- Installing a new generation retires the old endpoint, its unreachable mailbox,
  forwarding attempts and completed receipts, reclaiming their capacity. Accepted
  mail at another live endpoint survives its sender's replacement. Ordinary lease
  expiry alone does not discard accepted mail. A closed worker cannot advertise
  its retired epoch as a successful live profile.
- Old task IDs are unknown after endpoint loss/rebind. They do not regain status,
  wait, ACK or tool-execution authority from old session messages.
- Pi records complete received task events in `pi-tasks-event` message details,
  plus ordinary tool calls/results. Non-waking receipts, parent ACKs and
  late-terminal facts use `pi-tasks-event-record` custom entries before transport ACK. History supports human/agent inspection; it
  is neither a separate task-history database nor an automatic replay authority.
  An event never incorporated into the session may have no surviving record.
- Restarting a relay server is not restarting its native broker. Deployment must
  preserve broker terminals and deliberately reload compatible extensions.

Normal relay operation writes neither a ledger nor an investigation/history
spool. `root` is a normalized worker-ownership namespace; it does not select a
persistence engine. Lower-level tests can explicitly inject bounded diagnostic
sinks, but no diagnostic output participates in acceptance or recovery.

## Honest Tailnet, ordinary owner protection

All locally visible online Tailscale peers are trusted, including tagged machines
and other users' machines. Local Tailscale status must be Running, match the
configured canonical Self origin, and yield unambiguous node/origin routes.
Offline, missing and ambiguous routes fail closed. Local status may be cached for
up to one second. This is routing validation, not a per-user authorization system.

Relay HTTP accepts direct loopback/owner access or Tailnet source addresses.
For a loopback Tailscale Serve proxy, only a single Tailnet `X-Forwarded-For`
address is accepted. Public/Funnel addresses and ambiguous proxy chains are
rejected; arbitrary forwarded headers on public direct connections cannot grant
access. Do not expose this transport behind an untrusted proxy or on a public
network. Tailnet ACLs, canonical HTTPS/TLS and this deployment boundary replace
request signatures. Endpoint IDs are routing identities, not tenant credentials.

Existing global Wolfpack JWT policy is unchanged: **optional**, enforced only when
configured. It still protects ordinary APIs and relay requests. Peer transport
uses the existing owner token when available; it introduces no new JWT issuer,
secret, signature header or key exchange. Deployments enabling owner JWT must
configure compatible peer access. Browser CORS/origin policy is unchanged.

Before sending a peer body, the host confirms the canonical destination against
local topology and fetches its current memory profile/epoch over HTTPS without
redirects. The receiving host checks the current source and destination epochs
and the locally known source route. Topology/epoch changes during lookup abort
admission. No old alias is automatically rebound to a successor epoch.

## HTTP and discovery

- `GET /api/task-relay/profile`: `{ ok, profile: "volatile-v1", epoch,
  endpointPath: "/api/task-relay/volatile-v1", federation: "trusted-tailnet-v1" }`.
- `POST /api/task-relay/volatile-v1`: endpoint operations with profile/binding.
- `POST /api/task-relay/volatile-v1/resolve-peer`: host-controlled, epoch-bound
  local alias for a known remote endpoint.
- `POST /api/task-relay/volatile-v1/peer`: separately admitted peer envelopes.

The old `/api/task-relay/v2/*` and `/volatile-v1/identity` handlers are absent.
Unset `WOLFPACK_TASK_RELAY_PROFILE` selects the only supported profile; any other
value except `volatile-v1` is a startup error. Selection cannot change an existing
singleton's lifetime. See the generated [control API schema](control-api-schema.md).

Session status/list exposes fresh lease-bound `taskTransport` metadata including
profile, epoch and endpoint, but never the private process generation. Worker
readiness also proves the exact broker ID, canonical root, Pi harness and liveness,
then rechecks the same transport identity. Registration is not proof that a model
is executing an assignment.

A remote CLI launch/status qualifies its endpoint through the coordinator's local
live registration and the trusted Tailnet route. Remote lists do not allocate
routes. If qualification fails, the successfully created remote session and ID
remain; unsafe `taskEndpoint` is omitted and `REMOTE_TASK_ENDPOINT_UNAVAILABLE`
is reported. No invented cleanup or implicit remote session kill.

## Delivery guarantees within one lifetime

- Immutable message ID, creation timestamp, complete-header/payload digest and
  source/destination epoch prevent changed-content retries and epoch aliasing.
- Local acceptance means the mailbox admitted the envelope in RAM. Forwarded
  acceptance means the **destination confirmed** it. It is not durable storage,
  receiver Pi incorporation, completed work or parent acknowledgment.
- Receiver incorporation, assignee terminal intent, transport ACK and parent task
  ACK are distinct events. Pi calls its local receipt a “receiver receipt (RAM)”.
- Individual ACKs retain sparse cursors and advance only a safe contiguous
  frontier. Repeated ACKs do not free unrelated mail; polling alone does not ACK.
- Concurrent identical forwarding coalesces. Retries keep identity/content and
  the original deadline; no retry call rearms exhausted work. Four actual failed
  attempts end in `DELIVERY_UNCONFIRMED`, never success-shaped pending acceptance.
- `PEER_UNREACHABLE` can include `mayHaveBeenDelivered: true`. After state loss the
  outcome remains unknown; do not silently resubmit a task with a new ID.

## Bounds and isolation

Relay defaults are upper bounds, not performance/SLO measurements:

| State | Limit |
| --- | --- |
| Active envelopes | 4096 / 64 MiB |
| One mailbox | 256 / 8 MiB |
| One peer outbox | 128 / 8 MiB |
| Receipts | 50,000 / 8 MiB |
| Registrations / routes | 2048 each; 16 MiB metadata |
| Envelope / opaque payload | 64 KiB / 48 KiB |
| Inbox page | 50 items / 256 KiB |
| Pi endpoint RAM state | 16,384 records / 32 MiB encoded state; lower-only limits |

Forward retries use a one-second interval, original 120-second deadline, four
actual attempts, 15-minute receipt horizon and 30-second clock skew allowance.
No accepted mailbox is silently evicted to make room. Capacity failure is explicit.
Pi RAM mutations use synchronous rollback transactions and copied snapshots.
Encoded-state budgets do not claim exact JS heap/RSS bounds.

Worker admission reserves 28 ordinary requests / 3 MiB and 4 peer requests / 1 MiB;
active execution is 4 ordinary plus 2 peer. Request/response captures are bounded
before structured cloning (256 KiB / 1 MiB). Proxies, accessors, exotic objects,
cycles and hidden non-wire payloads fail before transfer. Bootstrap options are
captured before root ownership acquisition; the root stays owned until worker exit.

Peer host callbacks have eight slots and a five-second abort/deadline. Trusted
peer policy work has eight slots and a four-second total deadline including the
**complete** response body. Metadata and peer replies are bounded to 4 KiB, with
strict UTF-8 and fixed-size host storage before cloning. Redirects, oversized or
stalled bodies fail closed. Cancellation and worker close release readers and
slots without awaiting a cancellation promise that may never settle.

HTTP has 24 shared ordinary admission slots, a separate four-slot peer lane,
64 KiB strict-UTF8 bodies and a five-second body deadline. This is not a separate
HTTP ACK reservation. Worker startup/request defaults are 30/60 seconds; host
inspection callbacks are bounded to 15 seconds.

## Runtime and qualification

Stable Bun >=1.4.2 is required for source startup, workers and builds; CI/release
pin 1.4.2. Earlier Bun1.3.9 exhibited a native worker-teardown crash in fresh-process
stress. The newer pin is a measured mitigation, not an upstream root-cause claim
or crash-free guarantee.

Tests cover RAM isolation/rollback/capacity, no default disk output, no history
replay, immutable conflicts, sparse ACKs, explicit reset/rebind, worker ownership
and callback bounds, trusted topology with other users/tags, optional owner JWT,
public/Funnel denial, real HTTP peers and source-free compiled worker/adapter
lifecycles. Tests use private roots, loopback fixtures and explicit source pins.

Local synthetic tests do not establish physical two-machine TLS/Tailscale behavior,
production-model operation, final-path CPU/RSS/latency, fresh native release
provenance or safe live activation. Those gates remain separate. A changed design
requires fresh review; approval of the prior signed/durable-compatible pair is not
approval of this implementation.
