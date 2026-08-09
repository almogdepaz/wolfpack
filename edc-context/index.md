# wolfpack context index

## How to use
- Read this file first, then select module docs by changed path or task.
- For cross-boundary work, read only the related module named by routing/coupling guidance.
- Contextless entries are machine coverage only; reports are reserved for explicit review/audit workflows.

## Route by path/task
| touching / task | read first | also inspect | why |
| --- | --- | --- | --- |
| `src/`, `public/`, `scripts/`, `bin/`, or TypeScript tests | `modules/wolfpack.md` | `modules/broker.md` only for broker wire/lifecycle/snapshot changes | Bun server, CLI, PWA, persistence, and TypeScript broker client |
| `broker/` | `modules/broker.md` | `modules/wolfpack.md` for client-visible wire, snapshot, or lifecycle changes | Rust PTY daemon and Ghostty terminal authority |
| Tailnet setup, CORS, discovery, machine identity, remote routing, or notification deep links | `modules/wolfpack.md` | its Tailnet verification selection | Candidate facts, verified handshakes, stable identity, and current origin authority form one trust flow |
| terminal attach, resize, replay, hydration, grid, or reconnect | `modules/wolfpack.md` | its terminal verification selection; `modules/broker.md` only when broker sequencing/snapshot semantics change | Snapshot-to-live continuity spans browser, WebSocket server, and broker |
| session create/open/control, runtime status, or identity | `modules/wolfpack.md` | `modules/broker.md` when adding broker fields/RPCs | Server validates and persists identity; broker owns the PTY |
| `src/tasks/`, task routes, Pi task delivery, retention, or federation | `modules/wolfpack.md` | its task source pointers and focused unit/integration harness | Durable ledgers and canonical event transitions are server-owned |
| public API/schema or generated browser assets | `modules/wolfpack.md` | its generated-contract verification selection and generation scripts | Generated artifacts must remain synchronized with their source authority |
| broker protocol/codec or terminal snapshot | `modules/broker.md` | `modules/wolfpack.md` | Both sides must agree on frames and recovery semantics |

## Critical global invariants
- The broker is the sole PTY and authoritative terminal-state owner; server restarts must not kill or replace sessions.
- A terminal snapshot covers a broker output sequence. Attach/replay/reconnect must preserve that cut or force a fresh snapshot when replay is truncated.
- Broker UUIDs are durable session identity. Display names are selectors, and external-agent IDs must be redacted from public output.
- A remote browser origin is routable only after current local candidate enumeration plus a matching bounded machine handshake. Stale metadata, local storage, and request headers are not origin authority.
- Tailnet/global access is shell-level authority over visible sessions. Preserve canonical CORS/origin checks, optional global JWT, project containment, and command validation across REST and WebSocket paths.
- Task ledgers and canonical events are durable authority; caches and browser state are not. Browser stable machine identities and task-federation origin addresses are separate contracts.
- Bounded queues, probes, bodies, candidate sets, and caches intentionally favor explicit recovery over unbounded memory or silently stale state.

## Cross-module coupling / blast radius
- `broker/src/protocol.rs` and `broker/src/codec.rs` changes cascade through `src/broker/codec.ts`, `src/broker/client.ts`, `src/server/broker-backend.ts`, WebSocket behavior, browser recovery, and integration tests.
- Broker output sequencing, snapshot, resize, or Ghostty changes alter browser attach/reconnect correctness, not merely daemon internals.
- Tailnet machine-contract changes cascade through setup/config validation, server CORS and discovery routes, browser peer registry, remote REST/WebSocket routing, notification links, generated API schema, and E2E fixtures.
- HTTP origin/JWT/session-control changes affect both REST and `/ws/pty`; test localhost, direct sibling Tailnet origins, and Tailscale Serve origin recovery.
- Public API/message changes require coordinated runtime, `src/control-api/schema.ts`, generated schema, compatibility docs, and contract tests.
- Task domain/store/gateway changes can affect crash recovery, inbox/outbox ordering, Pi injection, peer federation, retention, and public schema even without broker changes.

## Architecture overview
Browser PWA → Bun HTTP/WebSocket and durable control plane → per-user Unix socket → Rust broker → local PTYs. Tailnet peers are contacted directly without a Wolfpack relay; the browser control room routes only through fresh verified peer handshakes.
