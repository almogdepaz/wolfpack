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

## pi tasks relay v2 boundary

`/api/task-relay/v2/*` is the Pi Tasks adapter contract. It preserves the v1 task routes and ledgers; relay v2 is a separate, content-blind transport and does not interpret task payloads or own task lifecycle.

The relay inherits Wolfpack's trusted local processes and trusted Tailnet machines boundary. It does not provide per-Pi-session authorization or per-session relay credentials in v2. Normal Wolfpack HTTP/JWT and Tailnet admission remain the authority for peer requests.

Relay endpoint fields are opaque IDs. A trusted local adapter qualifies a remote relay's local endpoint through `POST /api/task-relay/v2/peer/resolve`; its canonical Tailnet origin is persisted only in the local relay route directory, and the response contains only the opaque peer-qualified endpoint. Peer Tailnet origins never appear in generic Pi Tasks records or endpoint fields. Remote envelopes persist only in the sender's forwarding outbox until the target relay accepts them; the recipient mailbox is created solely by the target relay. Forwarding retries are single-flight per envelope, bounded, durable, and retain exhaustion diagnostics for cleanup.
