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
- project directory containment stays in `src/server/validate-project-dir.ts`.
- broker JSON/RPC wire compatibility stays covered by broker protocol/codec tests.

Compatibility rules:

- Additive changes are allowed for new optional fields, new stable operations, and new server-to-client event types.
- Breaking changes include removing or renaming stable fields/routes/messages, making optional fields required, changing auth expectations, or tightening stable enum/pattern constraints.
- Breaking changes need release notes that name the changed operation/message and migration path.

## tailnet discovery compatibility

`GET /api/tailnet/v1/candidates` is the canonical typed Tailnet candidate operation. It returns bounded local Tailscale-status facts only; clients probe candidate origins directly. The server never probes or proxies peer endpoints.

`GET /api/discover` remains the legacy `discoverPeers` operation for existing browser clients. Its `{ peers, error? }` envelope contains only candidates whose local `online` fact is `true`, mapped to `{ hostname, url, name }`. It sends `Deprecation: true` and a `Link` successor-version header for `/api/tailnet/v1/candidates`. Both routes preserve the same non-sensitive error when local Tailscale status is malformed or unavailable.

A candidate response is discovery input, not dashboard content or routing authority. Browser clients must strictly classify the candidate's direct `/api/machine` response, retain a currently ready stable identity in memory, and successfully load its sessions before projecting the peer into the dashboard or sidebar. Failed, offline, generic, malformed, incompatible, or revoked candidates remain confined to Settings diagnostics and must not become offline control-room cards.

Rendered controls may use the verified hostname and handshake display name. They must not embed Tailnet node IDs, Wolfpack installation IDs, stable/transient machine identities, or canonical routing origins in text or DOM attributes. Action handlers resolve a rendered hostname back through the current ready-peer registry before routing. See [multi-machine control room](multi-machine-control-room.md) for the user-facing behavior and trust boundary.

Schema compatibility checks live in `tests/unit/control-api-schema.test.ts`; representative runtime response checks live in integration tests.
