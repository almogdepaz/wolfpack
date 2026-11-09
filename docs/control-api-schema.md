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

## pi tasks relay (restart-safe-v1)

the durable task API (`/api/tasks/v1/*`) and the content-blind task relay remain separate contracts. endpoint-owned lifecycle, model incorporation and parent ACKs belong to wolfpack-tasks, not the relay.

`restart-safe-v1` is the default. `WOLFPACK_TASK_RELAY_PROFILE=volatile-v1` explicitly selects the old memory-only profile; neither profile silently changes guarantees. negotiation:

- `GET /api/task-relay/profile` returns `{ ok, profile, epoch, endpointPath, federation: "trusted-tailnet-v1" }`. restart-safe epochs identify the persisted relay store, not a process lifetime or worker readiness.
- `POST /api/task-relay/restart-safe-v1` accepts the versioned `RestartSafeRequest`. `connect` requires exact broker session and generation UUIDs, supported envelope protocols and optional lease/epoch. fresh broker inspection must return that same UUID. the receipt includes `sessionId`, `endpoint` and `leaseExpiresAt`.
- later commands carry `profile`, `epoch`, `callerSession`, `endpoint` plus `resolve`, `send`, `receive`, individual `acknowledge`, `disconnect` or `health`.
- `/resolve-peer` qualifies an endpoint only through host-verified current Tailnet topology. `/peer` is trusted relay ingress, not an endpoint route. immutable aliases bind both persisted epochs.
- `volatile-v1` uses the corresponding `/api/task-relay/volatile-v1` paths and `VolatileRequest/Response` schemas. wrong paths/profiles and retired `durable-v2` fail explicitly.

results remain `{ ok, profile, epoch, value }` or `{ ok: false, profile, epoch?, error: { code, message, retryable, mayHaveBeenDelivered?, retryAfterMs? } }`. see the generated schema and `src/task-relay/volatile-protocol.ts` for exact shapes.

restart-safe recovery preserves accepted mail, receipts, registrations, forwarding state and the store epoch in a private versioned SQLite journal. generation/session-name reuse cannot take over prior state. commits precede acceptance and external forwarding. a failed worker is replaced only after confirmed termination; the caller retries the same recorded protocol identity, not task execution. unresolved outcomes remain explicit. the [storage and recovery contract](task-recovery.md) defines private permissions, bounded retention, corruption/version refusal, compatibility and verification limits.

session reads continue to isolate optional relay metadata from broker truth. `taskRelay: { status: "unavailable", recovery }` omits endpoint/transport metadata without declaring a live broker session dead. missing registration alone is not degradation, and liveness is not model readiness. see [relay degradation and recovery](session-control.md#relay-degradation-and-recovery).

the existing optional global JWT and trusted local/Tailnet boundary remain unchanged. exact UUID ownership checks are not new per-session credentials or signed principals. canonical TLS, topology and both epochs still gate federation. do not expose owner APIs through Funnel or untrusted proxies.

no legacy store or API is migrated. `/api/task-relay/v2/*` remains absent; compatibility requires coordinated endpoint/server source versions. source tests do not establish installed or deployed behavior.
