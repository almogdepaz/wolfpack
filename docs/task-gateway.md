# Task gateway v1

Wolfpack owns durable Pi task routing. One server-owned singleton owns one machine-global store at `~/.wolfpack/tasks`; Pi extensions are clients and do not write task files, terminal assignments, or task truth. The singleton uses append-only sender ledgers and receiver replicas; rebuildable indexes are not authoritative.

This guide is the operational model. The generated [control API schema](generated/control-api.schema.json), tracked at `docs/generated/control-api.schema.json`, is the canonical request, response, bounds, and error contract. The route list below is navigation only; do not copy or maintain full schemas here.

## Trust and addressing

The boundary is trusted local processes and trusted Tailnet machines. v1 adds no task capability token or inter-session authorization layer. Wolfpack's ordinary global authentication is not bypassed.

A task target persists a stable broker `sessionId` plus a machine identity. Local callers supply `WOLFPACK_SESSION_NAME`; the local gateway resolves that selector through authoritative session identity and pins the resulting stable broker ID. Human-visible names are not persisted task addresses.

Use `machine: "local"` for same-machine work. A peer machine must be a canonical HTTPS Tailnet origin in the configured namespace, for example `https://worker.example.ts.net`. Origins with credentials, paths, query strings, fragments, unexpected ports, non-Tailnet hosts, or a different configured namespace are rejected. The gateway normalizes accepted addresses to its durable machine identity and observed canonical origin.

## Routes and federation

Every v1 route is served by the local Wolfpack gateway. Local Pi clients call these eight routes:

| Route | Role |
| --- | --- |
| `POST /api/tasks/v1/send` | create or reuse an assignment and obtain durable receipt |
| `GET /api/tasks/v1/status` | read canonical task state, history, result, and warnings |
| `GET /api/tasks/v1/inbox` | poll ordered delivery events |
| `POST /api/tasks/v1/message` | append a question, answer, or information event |
| `POST /api/tasks/v1/complete` | submit a receiver terminal result |
| `POST /api/tasks/v1/cancel` | request sender-owned cancellation |
| `POST /api/tasks/v1/delivered` | record structurally inserted Pi delivery |
| `POST /api/tasks/v1/ack` | perform parent terminal acknowledgment |

Peer gateways use these two routes:

| Route | Role |
| --- | --- |
| `POST /api/tasks/v1/peer/receive` | persist a provisional remote assignment receipt |
| `POST /api/tasks/v1/peer/event` | accept confirmed assignments and later task events |

Federation is direct fetch federation between trusted Wolfpack gateways. Pi always calls its own local gateway; it never fetches a peer directly. There is no queue or scheduler.

A remote initial send makes one initial attempt. The receiver first writes a provisional receipt and keeps it invisible to Pi. The sender records canonical `task.received` only after that receipt response, then sends receipt confirmation before the receiver promotes the assignment into its inbox. A lost initial response leaves the sender terminally failed and leaves the unconfirmed receiver record eligible for orphan cleanup after 10 minutes.

Receipt confirmation and later remote events use one initial attempt plus three retries: four total attempts around 1, 2, and 4 seconds with jitter. This bounded policy covers messages, terminal updates, cancellation, delivery notices, and parent acknowledgments. Exhaustion records a local `event.delivery_failed` and stops; v1 has no background retry or durable offline dispatch queue.

## Authority, recovery, and acknowledgment

The sender is authoritative for canonical task sequence, state, deadline, and terminal choice. The first accepted terminal event wins; late terminals are retained only as diagnostics. The sender alone evaluates expiry, emits timeout, and makes best-effort remote cancellation.

Questions, answers, and information are durable bidirectional events. Only one unresolved question may exist for a task, and an answer must identify that question. Gateway delivery is at-least-once; Pi structurally deduplicates inserted `{ taskId, eventId }` custom messages. On restart, gateway logs rebuild task state and pending delivery/outbox evidence; Pi replays missing structured events rather than parsing prose.

Parent acknowledgment is two-phase for remote tasks. The sender persists `task.parent_ack_pending`, the receiver durably acknowledges that event, then the sender records `task.parent_acknowledged`. If delivery or its response is lost, the task stays visible and an explicit later acknowledgment reuses the pending event ID. Do not clean up a parent-spawned session until the parent independently verifies the result and acknowledgment has succeeded.

## Retention and artifacts

All unresolved tasks are retained without eviction; operators must monitor store count and byte growth. An unacknowledged terminal task is also retained. After a completed two-phase parent acknowledgment, terminal payloads are retained for 10 days, then compact task-ID and assignment-hash tombstones remain for a further 10 days to prevent delayed duplicates from resurrecting work. Cleanup never escapes the configured task root.

Durable task JSON now uses locale-independent UTF-16 code-unit key ordering. Existing task ledgers, tombstones, and caches remain structurally readable with no operator action; new appends and rewrites simply use the deterministic ordering going forward. Relay durability is stricter: on first access, Wolfpack validates a legacy version-1 `relay-state.json` and then replaces it with an empty deterministic version-2 state. Legacy relay registrations, mailbox records, peer routes, outbox items, and acceptance IDs are discarded. A malformed legacy state or an unsupported state version fails closed and is not reset.

Artifacts are paths-only metadata. A receiver may declare up to 20 project-relative regular-file paths; the receiver gateway derives machine and project provenance and returns warnings that identify each rejected submitted path. v1 transfers no artifact bytes, snapshots, hashes, or download state. A parent verifies a remote artifact through an appropriate remote inspection, reviewer, or normal source-control transfer.

## Live-peer readiness checklist

Before scheduling an existing live smoke sequence against a specific peer, complete this read-only checklist and record the evidence with that verification:

1. Record the expected Wolfpack version and expected Pi Tasks version for this run, plus the peer's canonical HTTPS Tailnet origin. Do not substitute a display name, arbitrary URL, or a previous run's result.
2. Inspect `GET /api/info` at that origin. Record that it is reachable and its JSON `version` and `machineId`; the version must match the expected Wolfpack version and the machine identity must be the peer being assessed.
3. Probe the task route without creating work. Request `GET /api/tasks/v1/status` without required query parameters:

   ```bash
   set -e
   origin="https://worker.example.ts.net"
   headers="$(mktemp)" body="$(mktemp)"
   trap 'rm -f "$headers" "$body"' EXIT
   status="$(curl -sS -D "$headers" -o "$body" -w '%{http_code}' \
     "$origin/api/tasks/v1/status")"
   test "$status" = 400
   grep -qi '^content-type: application/json' "$headers"
   jq -e '.ok == false and .error.code == "INVALID_REQUEST"' "$body"
   ```

   Run this as one fail-closed shell block; any failed assertion rejects readiness. The expected structured `400` JSON `INVALID_REQUEST` proves the task route exists. This is intrinsically read-only: the status route cannot create a task. A `404`, HTML/non-JSON response, or a `400` without that structured code is not a pass; stop before task creation.
4. Record authentication blockers separately. `401/403`, a credential prompt, unavailable Tailnet/DNS, or a TLS failure is a blocker, not evidence that the route or peer is ready; resolve normal Wolfpack authentication before any live task.
5. Use structured Wolfpack session control to select the receiver and record its stable broker `sessionId`. A terminal label or copied pane text is not a target identity.
6. On every participating Pi host, record `pi list` output for the configured/installed pinned Pi Tasks package version/spec. This does not prove that the current Pi process loaded the package. Install the approved exact package version when needed, for example `pi install npm:@sgtbeatdown/pi-tasks@0.1.1`, then retain a separate operator record confirming a fresh Pi start or `/reload` completion before dispatch.

All records must pass before task creation permits the existing live smoke sequence. Any wrong version, missing route, authentication blocker, absent stable session ID, missing configured/installed package record, or missing fresh Pi start or `/reload` evidence stops before task creation and is reported as fixture-only verification. Isolated two-server coverage is the deterministic acceptance gate, while a specific live peer still requires current readiness at the time of use.

## Limits and unsupported scope

Initial limits are 16 KiB UTF-8 each for task instructions and Markdown context summary, 48 KiB for the combined assignment envelope, and 64 KiB for an HTTP request body. The schema publishes character ceilings; runtime enforces UTF-8 byte limits. Inbox pages are capped at 50 events and 256 KiB serialized.

JWT federation is unsupported. If Wolfpack global JWT is configured, normal authentication still applies locally; credential-free peer delivery fails clearly instead of weakening auth.

v1 has no queue, scheduler, artifact transfer, or transcript transfer. It also has no exact Pi runtime registration, heartbeat/capability leases, semantic model-start detection, or progress streaming.

## Deferred follow-up

Keep these as operational debt, not production TODOs: runtime registration and heartbeat/capability leases; durable offline initial dispatch; JWT/authenticated peer federation; artifact transfer and retention; representative payload benchmarking before changing limits; automated recovery summaries; and summary caching only after measured repeated-generation waste. Isolated two-server coverage is the deterministic acceptance gate; current readiness is still required for any specific live peer.
