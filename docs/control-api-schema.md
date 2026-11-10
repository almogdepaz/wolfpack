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

## child harness selection

`POST /api/session-open` (`openSession`) accepts optional `harness: "pi" | "claude" | "codex" | "gemini" | "cursor"`. Omission inherits the parent's harness; `shell` is not accepted for children. The parent must still use a supported agent harness. Child selection preserves parent ID/name lineage, naming, and notification behavior; success `harness` reports the child's harness.

`model` and `taskWorker` require a Pi child, not a Pi parent. A non-Pi parent can select `harness: "pi"` with `model`; an explicit non-Pi child with either option is rejected before creation. Invalid child harnesses return HTTP 400 `INVALID_REQUEST`. Runtime routes enforce these child-option requirements, including when the harness is inherited from parent identity.

## tailnet discovery compatibility

`GET /api/tailnet/v1/candidates` is the canonical typed Tailnet candidate operation. It returns bounded local Tailscale-status facts only; clients probe candidate origins directly. The server never probes or proxies peer endpoints.

`GET /api/discover` remains the legacy `discoverPeers` operation for existing browser clients. Its `{ peers, error? }` envelope contains only candidates whose local `online` fact is `true`, mapped to `{ hostname, url, name }`. It sends `Deprecation: true` and a `Link` successor-version header for `/api/tailnet/v1/candidates`. Both routes preserve the same non-sensitive error when local Tailscale status is malformed or unavailable.

Schema compatibility checks live in `tests/unit/control-api-schema.test.ts`; representative runtime response checks live in integration tests.

## pi tasks relay (volatile-v1 wire, independent server storage)

the durable task API (`/api/tasks/v1/*`) and the content-blind task relay remain separate contracts. endpoint-owned lifecycle, model incorporation and parent ACKs belong to wolfpack-tasks, not the relay.

native SQLite is the default server storage; `WOLFPACK_TASK_RELAY_STORAGE=memory` explicitly selects weaker memory-only storage. both use the existing `volatile-v1` wire interface without endpoint durability negotiation:

- `GET /api/task-relay/profile` returns `{ ok, profile: "volatile-v1", epoch, endpointPath: "/api/task-relay/volatile-v1", federation: "trusted-tailnet-v1" }`. the epoch identifies the store, not worker readiness or endpoint durability.
- `POST /api/task-relay/volatile-v1` accepts `VolatileRequest`. `connect` accepts the baseline caller selector, generation, supported protocols and optional lease/epoch. fresh broker inspection resolves the canonical UUID; the receipt retains `endpoint` and `leaseExpiresAt`.
- later commands carry `profile`, `epoch`, `callerSession`, `endpoint` plus `resolve`, `send`, `receive`, individual `acknowledge`, `disconnect` or `health`.
- A `send` or peer envelope whose payload `kind` is `wolfpack.child_event/v1` fails `SOURCE_MISMATCH`: only the server sends that kind, and only to endpoints whose `protocolVersions` include the capability marker `1001` (see [delivery to the parent agent](session-control.md#delivery-to-the-parent-agent)).
- `/resolve-peer` qualifies an endpoint only through host-verified current Tailnet topology. `/peer` is trusted relay ingress, not an endpoint route. immutable aliases bind both persisted epochs.
- wrong/retired profiles, including the removed WIP `restart-safe-v1` profile, are not negotiated or advertised.

results remain `{ ok, profile, epoch, value }` or `{ ok: false, profile, epoch?, error: { code, message, retryable, mayHaveBeenDelivered?, retryAfterMs?, ownerFatal? } }`. see the generated schema and `src/task-relay/volatile-protocol.ts` for exact shapes.

server SQLite recovery preserves accepted mail, receipts, registrations, forwarding state and the store epoch in a private versioned SQLite journal. session-name reuse cannot access a different canonical UUID's endpoint. live plugins keep semantic state and outbox in RAM; plugin-process recovery is excluded. commits precede acceptance and external forwarding. a failed worker is replaced only after confirmed termination; the caller retries the same recorded protocol identity, not task execution. unresolved outcomes remain explicit. the [storage and recovery contract](task-recovery.md) defines private permissions, bounded retention, corruption/version refusal, compatibility and verification limits.

session reads continue to isolate optional relay metadata from broker truth. `taskRelay: { status: "unavailable", recovery }` omits endpoint/transport metadata without declaring a live broker session dead. missing registration alone is not degradation, and liveness is not model readiness. see [relay degradation and recovery](session-control.md#relay-degradation-and-recovery).

the existing optional global JWT and trusted local/Tailnet boundary remain unchanged. exact UUID ownership checks are not new per-session credentials or signed principals. canonical TLS, topology and both epochs still gate federation. do not expose owner APIs through Funnel or untrusted proxies.

no legacy store or API is migrated. `/api/task-relay/v2/*` remains absent. baseline RAM clients can use the new server without upgrading; new clients retain old servers' weaker restart-loss behavior. source tests do not establish installed or deployed behavior.
