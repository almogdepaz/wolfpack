# control api schema

Wolfpack's public HTTP control API and `/ws/pty` control-message contracts are owned by `src/control-api/schema.ts`.

Generated artifact:

- `docs/generated/control-api.schema.json`

Regenerate after contract changes:

```sh
bun run gen:schema
```

The generated schema is a client integration contract. It must not replace the existing server trust boundaries:

- project, session, branch, command, and plan validation stays in `src/validation.ts` and route-specific checks.
- project directory containment stays in `src/server/validate-project-dir.ts`.
- broker JSON/RPC wire compatibility stays covered by broker protocol/codec tests.
- peer Ralph loop responses remain sanitized before aggregation.

Compatibility rules:

- Additive changes are allowed for new optional fields, new stable operations, and new server-to-client event types.
- Breaking changes include removing or renaming stable fields/routes/messages, making optional fields required, changing auth expectations, or tightening stable enum/pattern constraints.
- Breaking changes need release notes that name the changed operation/message and migration path.

Schema compatibility checks live in `tests/unit/control-api-schema.test.ts`.
