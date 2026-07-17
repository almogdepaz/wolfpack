# session control fast path

status: completed — implemented and verified; not committed, deployed, or released
branch: feat/session-control-fast-path
base: feat/session-open@7e3f968

## goal

make top-level session creation and child-agent spawning unambiguous, atomic, scriptable, and cheap for agents.

## success criteria

- `wolfpack session create <project> [--harness <agent>] [--prompt <instruction>] [--json]` creates one top-level session with one server request and argv-level prompt injection.
- `wolfpack agent spawn <project> [--prompt <instruction>] [--json]` creates one same-harness child; `wolfpack session open` remains a deprecated compatibility alias.
- create/spawn/list/status/read/send/wait/kill JSON responses expose stable broker session IDs.
- session-control selectors accept either active display names or stable IDs and fail closed on ambiguity.
- `wolfpack list --json` and `wolfpack session status <selector> --json` avoid human terminal scraping.
- help paths remain side-effect-free.
- the control skill has a short fast path and references detailed docs instead of embedding curl/protocol tutorials.
- docs prescribe short plan-referencing handoffs instead of duplicated prompts.

## constraints

- global/tailnet auth remains the trust boundary.
- no shell interpolation; initial prompts remain opaque argv.
- server owns validation, naming, collision retries, identity, and creation.
- existing browser `/api/create` and `session open` behavior remain compatible.
- no deployment, merge, release, or active-skill replacement in this task.
- the global pi-doc policy is a separate dotfiles change and is not part of this branch.

## work

- [completed] add failing CLI and server regressions for create, spawn, JSON list/status, IDs, selectors, and help.
- [completed] add server-owned top-level session creation and selector resolution.
- [completed] add CLI command surfaces and compatibility aliases.
- [completed] update schema, generated artifact, docs, README, and compact skill.
- [completed] run focused tests, full Bun/Rust suites, typechecks, generation checks, four-target builds, compiled CLI smoke, and security/delivery/quality review.
