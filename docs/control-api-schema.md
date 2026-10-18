# control api schema

Wolfpack's public HTTP control API and `/ws/pty` control-message runtime behavior is owned by the server routes and WebSocket handlers. `src/control-api/schema.ts` owns the generated client-facing schema artifact.

Generated artifact:

- `docs/generated/control-api.schema.json`

Regenerate after contract changes:

```sh
bun run gen:schema
```

The generated schema is a client integration contract. Runtime routes remain authoritative for validation and behavior. The schema must not replace the existing server trust boundaries:

- project, session, branch, command, and plan validation stays in `src/validation.ts` and route-specific checks.
- named-project containment and explicit-directory canonicalization stay in `src/server/validate-project-dir.ts`; selector exclusivity stays in `src/server/project-selection.ts`.
- broker JSON/RPC wire compatibility stays covered by broker protocol/codec tests.

Compatibility rules:

- Additive changes are allowed for new optional fields, new stable operations, and new server-to-client event types.
- Breaking changes include removing or renaming stable fields/routes/messages, making optional fields required, changing auth expectations, or tightening stable enum/pattern constraints.
- Breaking changes need release notes that name the changed operation/message and migration path.

## tailnet discovery compatibility

`GET /api/tailnet/v1/candidates` is the canonical typed Tailnet candidate operation. It returns bounded local Tailscale-status facts only; clients probe candidate origins directly. The server never probes or proxies peer endpoints.

`GET /api/discover` remains the legacy `discoverPeers` operation for existing browser clients. Its `{ peers, error? }` envelope contains only candidates whose local `online` fact is `true`, mapped to `{ hostname, url, name }`. It sends `Deprecation: true` and a `Link` successor-version header for `/api/tailnet/v1/candidates`. Both routes preserve the same non-sensitive error when local Tailscale status is malformed or unavailable.

Schema compatibility checks live in `tests/unit/control-api-schema.test.ts`; representative runtime response checks live in integration tests.

## pi tasks relay (volatile-v1)

The durable task API (`/api/tasks/v1/*`) and the Pi Tasks relay are separate contracts. Task ledgers, completion, and recovery live only in `/api/tasks/v1/*`. The relay is a content-blind, memory-owned transport: it does not interpret task payloads, own task lifecycle, or survive restart.

`volatile-v1` is the only relay profile (`WOLFPACK_TASK_RELAY_PROFILE` accepts nothing else). Negotiation:

- `GET /api/task-relay/profile` returns `{ ok, profile: "volatile-v1", epoch, endpointPath: "/api/task-relay/volatile-v1", federation: "trusted-tailnet-v1" }`. `epoch` is an opaque ID for the relay's current RAM lifetime, not broker or worker readiness.
- `POST /api/task-relay/volatile-v1` takes one JSON command selected by `operation`. `connect` (`profile`, `callerSession`, `generation`, `protocolVersions`, optional `leaseMs`/`epoch`) returns the caller's opaque `endpoint` and `leaseExpiresAt`. Every later command carries the binding `profile`, `epoch`, `callerSession`, `endpoint` plus one of `resolve` (`target`), `send` (`envelope`), `receive` (`cursor`, optional `limit`), `acknowledge` (`envelopeId`), `disconnect`, or `health`.
- `POST /api/task-relay/volatile-v1/resolve-peer` (binding plus `origin`, `target`) qualifies a remote relay endpoint against current verified Tailnet topology and returns only an opaque peer-qualified alias. Peer Tailnet origins never appear in Pi Tasks records or endpoint fields; aliases are stable only within one epoch pair.
- `POST /api/task-relay/volatile-v1/peer` is trusted-peer ingress for relay-to-relay forwarding, never an endpoint client route.

Results are `{ ok, profile, epoch, value }` or `{ ok: false, profile, epoch?, error: { code, message, retryable, mayHaveBeenDelivered?, retryAfterMs? } }`; `src/task-relay/volatile-protocol.ts` and the generated schema are authoritative for shapes and codes.

Reset and loss: routes, registrations, mailboxes, receipts, and in-flight forwards exist only in memory. A Wolfpack or relay-worker restart creates a new epoch and loses all of it; Pi session history is never replayed. Any command bound to a stale epoch fails with `RELAY_RESET` (`mayHaveBeenDelivered: true`). Clients must re-read the profile, `connect` again, re-resolve peer aliases, and treat unacknowledged sends as possibly delivered or lost; anything that must survive restart belongs in `/api/tasks/v1/*`. Re-connecting with a different `generation` for the same session replaces the endpoint and drops its unreachable obligations.

Trust: the relay inherits Wolfpack's trusted local processes and trusted Tailnet machines boundary, requires loopback or trusted Tailnet access, and inherits optional global auth. It has no per-Pi-session authorization or per-session credentials, and peer forwarding has no signatures.

Migration from the retired relay v2: `/api/task-relay/v2/*` (including `peer/resolve`, `send`, `receive`, `delivery-ack`) and the durable relay route directory/forwarding outbox no longer exist and return 404; `durable-v2` profile selection is an error, not a compatibility mode. v2 clients should discover through `GET /api/task-relay/profile`, map `connect`/`resolve`/`send`/`receive`/`delivery-ack` to the corresponding `volatile-v1` operations (`delivery-ack` → `acknowledge`, `peer/resolve` → `resolve-peer`), and drop any assumption that queued relay mail survives restart.
