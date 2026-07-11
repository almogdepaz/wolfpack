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
- peer Ralph loop responses remain sanitized before aggregation.

Compatibility rules:

- Additive changes are allowed for new optional fields, new stable operations, and new server-to-client event types.
- Breaking changes include removing or renaming stable fields/routes/messages, making optional fields required, changing auth expectations, or tightening stable enum/pattern constraints.
- Breaking changes need release notes that name the changed operation/message and migration path.

Schema compatibility checks live in `tests/unit/control-api-schema.test.ts`; representative runtime response checks live in integration tests.
