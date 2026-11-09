# restart-safe task relay

status: blocked draft implementation. R1–R4/R6 ownership, presentation, compatibility and retention corrections remain open. the Claude recovery policy remains an unanswered user decision. this document is not release approval.

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

server stop/start reopens the same journal and epoch. worker timeout returns potentially committed `RELAY_UNAVAILABLE`. poisoned commits return typed `RELAY_STORAGE_UNCERTAIN`, `ownerFatal: true`, and `mayHaveBeenDelivered: true`; the worker stops rather than continuing from uncertain RAM. the facade confirms termination before single-flight replacement and never replays the interrupted request. callers retry only their recorded protocol identities.

recovery uses monotonic cooldowns of 1, 2, 4, 8, 16 and then 30 seconds. `RELAY_STORAGE_RECOVERING` rejects requests before admission and supplies `retryAfterMs`. only a successful connect from the still-current healthy owner resets recovery state; a delayed old success cannot clear a later failure. voluntary shutdown prevents replacement.

`RELAY_STORAGE_BUSY` reports another native owner; `RELAY_STORAGE_UNAVAILABLE` reports retryable opening I/O or access failure. neither implies acceptance or permits takeover. `RELAY_STORAGE_INVALID` permanently blocks unsupported/corrupt/unverifiable storage for that facade lifetime. `RELAY_STORAGE_RECOVERY_BLOCKED` preserves the root reservation when termination is unconfirmed. these failures never authorize a fresh epoch, an empty fallback or user-action replay.

endpoint journals belong to wolfpack-tasks, not this server. endpoint ownership and Pi insertion proof are still under R1–R3 correction: broker UUID alone and RAM history are insufficient. existing presentation-blocking behavior is unapproved WIP, including the unresolved Claude policy. relay durability does not establish model consumption, execution or successful side effects.

fresh sessions, reused names, missing/unsupported journals and real store-epoch discontinuities cannot adopt old work. parent verification and one logical parent ACK remain separate from protocol acceptance and session teardown. the source-level relay restart checks do not require `/reload`, a fresh assignment or manual rebind; complete installed endpoint lifecycle coverage remains required before that broader claim.

## trust and verification boundaries

existing optional global JWT authentication, loopback/trusted Tailnet admission, canonical TLS origins, current topology and both relay epochs remain required. no new principal/signature scheme is implied. do not expose these APIs through Funnel or an untrusted proxy.

focused source tests cover actual worker/process restart, timeout replacement, cross-host accepted-before-confirmation, duplicate/ACK identity, name/generation fencing, bounded retention and corrupt/unsupported storage. production HTTP tests exercise both profiles with configured/unconfigured JWT and the existing trusted-peer policy. these are not installed/live-service, physical two-host, filesystem power-loss, or package deployment evidence. native SQLite/filesystem guarantees remain the durability prerequisite; distributed exactly-once model/tool execution is not claimed.
