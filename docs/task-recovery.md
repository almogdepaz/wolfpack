# restart-safe task relay

## wire and ownership

`restart-safe-v1` is the default relay profile. its endpoint path is `/api/task-relay/restart-safe-v1`; peer ingress and host-only resolution use `/peer` and `/resolve-peer`. `GET /api/task-relay/profile` advertises the selected profile, persisted store epoch and matching endpoint path. the inner opaque envelope protocol remains version 2.

`volatile-v1` remains an explicit memory-only profile. it never gains durable guarantees under its old name. mismatched paths/profiles and the retired `durable-v2` API fail; neither server nor endpoint silently downgrades. set `WOLFPACK_TASK_RELAY_PROFILE` only as a deliberate deployment choice. compatible source changes do not install, migrate or activate packages.

restart-safe connect requires canonical session and generation UUIDs. the host freshly inspects that exact broker session UUID and requires the returned UUID to match. the connection receipt includes `sessionId`. reusable names are never identity. a different generation cannot replace a persisted owner or inherit its mailbox. ordinary operations still require the correct epoch, endpoint ownership, live lease and fresh broker proof. an expired target lease may renew only after fresh exact-UUID proof; an unavailable broker is not evidence of death.

## storage contract

- the worker owns `restart-safe-v1.sqlite` under its configured relay root (normally `${WOLFPACK_DIR:-~/.wolfpack}/task-relay`). the independent storage format is `wolfpack-relay/restart-safe-v1`, SQLite `user_version=1`. no retired relay ledger is read, converted or deleted.
- owner-private directories (0700), files (0600), ownership and regular-file checks precede opening. SQLite EXCLUSIVE locking fences other processes, including overlapping old/new workers. DELETE journals and FULL synchronization commit before success responses and external forwarding.
- primary records contain the store epoch, session/generation registrations, endpoint cursors, peer aliases/epochs, receipts, immutable envelopes and forwarding state. mailbox, expiry and byte-accounting indexes rebuild from validated primary records. changed primary rows commit atomically with per-row SHA-256 checksums. unsupported formats, identity/origin mismatch, database corruption and invalid relationships stop recovery; they do not create an empty successor store.
- an in-flight forwarding token is not success. reopening removes the obsolete attempt token, retains the original envelope and dedup identity, and retries only when its endpoint reoffers that recorded operation. destination-confirmed acceptance must match the original identity. unknown/rejected/expired forwarding reports `DELIVERY_UNCONFIRMED` rather than guessed acceptance.
- existing bounded item/byte ceilings remain authoritative. accepted unacknowledged mail and identity registrations are not silently expired. admission fails at capacity instead of dropping obligations. new envelope admission has a seven-day horizon; completed receipt tombstones remain eight days after completion. after tombstone eviction, the original creation timestamp prevents the old envelope from being admitted again. SQLite page limits also bound disk growth; rollback files are bounded by the transaction/database size.

## restart lifecycle

server stop/start reopens the same journal and epoch. a server-owned worker timeout returns retryable `RELAY_UNAVAILABLE` with an explicit potentially committed outcome. the owning recovery facade confirms termination before creating a replacement worker; it does not replay the interrupted request. endpoint polling retries only its committed protocol envelope/ACK IDs. voluntary gateway shutdown fences replacement.

endpoint journals belong to wolfpack-tasks, not this server. compatible endpoints restore assignments, event/message identities, pending outbox, insertion receipts, sparse delivery ACKs and terminal/parent-ACK reservations under the same broker UUID. Pi reconciles durable structured session entries before model insertion or wake. an interrupted wake without authoritative harness evidence is explicit `TASK_PRESENTATION_UNCONFIRMED`, never an automatic duplicate assignment execution. user tool actions are not recovery operations.

fresh sessions, reused names, missing/unsupported journals and real store-epoch discontinuities cannot adopt old work. parent verification and one logical parent ACK remain separate from protocol acceptance and session teardown. no `/reload`, fresh assignment or manual rebind is required for an interruption whose identity and committed state remain recoverable.

## trust and verification boundaries

existing optional global JWT authentication, loopback/trusted Tailnet admission, canonical TLS origins, current topology and both relay epochs remain required. no new principal/signature scheme is implied. do not expose these APIs through Funnel or an untrusted proxy.

focused source tests cover actual worker/process restart, timeout replacement, cross-host accepted-before-confirmation, duplicate/ACK identity, name/generation fencing, bounded retention and corrupt/unsupported storage. production HTTP tests exercise both profiles with configured/unconfigured JWT and the existing trusted-peer policy. these are not installed/live-service, physical two-host, filesystem power-loss, or package deployment evidence. native SQLite/filesystem guarantees remain the durability prerequisite; distributed exactly-once model/tool execution is not claimed.
