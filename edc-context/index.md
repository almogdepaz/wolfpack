# wolfpack context index

## How to use
- read this file first
- choose module docs by changed path/task
- for cross-boundary work, read only the related modules named by routing/coupling guidance
- contextless.entries are machine coverage only and must not appear in the human index read path
- reports are not part of the ordinary index read path

## Route by path/task
| touching / task | read first | also inspect | why |
| --- | --- | --- | --- |
| `src/`, `public/`, `scripts/`, `bin/`, or `tests/` | `modules/wolfpack.md` | `modules/broker.md` for broker protocol/lifecycle changes | Bun server, CLI, and browser terminal client |
| `broker/` | `modules/broker.md` | `modules/wolfpack.md` for any wire, snapshot, or session behavior exposed to clients | Rust PTY daemon and Ghostty terminal authority |
| terminal attach, resize, replay, reconnect | `modules/wolfpack.md` | `modules/broker.md` | Snapshot-to-live continuity spans WebSocket and broker sequencing |
| session create/open/control or identity | `modules/wolfpack.md` | `modules/broker.md` when adding broker fields/RPCs | server validates and persists identity; broker starts the PTY |
| broker protocol/codec or terminal snapshot | `modules/broker.md` | `modules/wolfpack.md` | both sides must agree on frames and recovery semantics |

## Architecture overview
Browser PWA → Bun HTTP/WebSocket server → per-user Unix socket → Rust broker → local PTYs. The browser renders; the server enforces HTTP policy and brokers calls; the Rust daemon owns PTY lifecycle, output order, and Ghostty-derived terminal state. Tailscale/global API access is the security boundary, with optional JWT layered on top.

## Critical global invariants
- The broker is the sole PTY and authoritative terminal-state owner; server restarts must not kill or replace sessions.
- A terminal snapshot covers a broker output sequence. Attach/replay/reconnect must preserve that cut or force a fresh snapshot when replay is truncated.
- Session identity is broker-UUID based; display names are collision-prone labels and external agent IDs must be redacted from public output.
- Browser, server, and broker all assume access equals authority over sessions. Do not weaken origin/JWT/project-command validation or treat arbitrary reverse-proxy headers as trusted Tailscale headers.
- Bounded queues intentionally favor recovery from a snapshot over unbounded memory or a silently stale viewer.

## Cross-module coupling / blast radius
- `broker/src/protocol.rs` and `broker/src/codec.rs` changes cascade through `src/broker/codec.ts`, `src/broker/client.ts`, `src/server/broker-backend.ts`, WebSocket behavior, and integration tests.
- Broker output sequencing, snapshot, resize, or Ghostty changes alter the browser’s attach/reconnect correctness, not merely daemon internals.
- Broker lifecycle events and reconnect rules feed server caches, session identity restoration, CLI control, and browser state; preserve idempotency and event ordering across the boundary.
- HTTP origin/JWT/session-control changes affect both REST and `/ws/pty` upgrade paths; test the remote Tailscale path as well as localhost.
