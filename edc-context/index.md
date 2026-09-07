# Wolfpack EDC Context Index

## How to use

Start here to route work, then open only the module document(s) for the paths or contracts you are changing:

- `edc-context/modules/wolfpack.md` for Bun server/CLI/browser/runtime, sessions, broker client boundary, terminal attach/inspection, Tailnet, tasks/relay/push, setup/service/install/build.
- `edc-context/modules/broker.md` for the Rust PTY broker daemon, socket protocol, registry/tombstones, PTY lifecycle, replay/snapshots, resize, and Ghostty VT FFI.
- `edc-context/modules/tests.md` for Bun/integration/Playwright/snapshot/schema fixtures and executable regression contracts.

Do not treat generated bundles, staged EDC artifacts, screenshots/media, generated schemas, site assets, or prior test results as source truth. Reports and contextless machine coverage are intentionally outside the normal human read path.

## Route by path/task

| Path or task | Read first | Notes |
| --- | --- | --- |
| `broker/**` | `modules/broker.md` | Broker owns PTY children, registry/tombstones, output sequence/replay, snapshots, resize transaction, socket codec/server, and Ghostty VT FFI bounds. |
| `src/**`, `public/**`, `bin/**`, `scripts/**` | `modules/wolfpack.md` | Covers server HTTP/WS auth, session/project APIs, broker client/backend, passive inspection, browser terminal/grid/session cards, Tailnet peers, tasks/relay/push, setup/service/install/build. |
| `tests/**` | `modules/tests.md` | Use for harness behavior and regression intent; production modules remain semantic authority. |
| Broker protocol, terminal attach/reconnect, passive snapshot, or conflict/take-control changes | `modules/broker.md` + `modules/wolfpack.md` + relevant `modules/tests.md` sections | Highest coupling: Rust protocol/session sequencing, TS broker client/backend, WS attach, browser hydration/inspection, and real-broker tests must stay aligned. |
| Auth, Tailnet, remote machine, or browser peer changes | `modules/wolfpack.md` | Stable machine identity/canonical origin are routing authority; labels and forwarded headers are not. |
| Tasks, relay, notifications, quiet alerts, Pi integration, child-agent model selection, or task-worker readiness | `modules/wolfpack.md` + `modules/tests.md` | Durable task/relay data and exact broker session IDs are authority; terminal output is not task/model readiness evidence. |
| Install, release, setup, service, provider detection, or broker artifact changes | `modules/wolfpack.md` + `modules/broker.md` + `modules/tests.md` | Preserve artifact provenance checks and server-only vs broker restart blast-radius claims. |

## Critical global invariants

- Broker UUIDs/session IDs are durable authority. Visible names are convenience selectors and must fail closed on ambiguity, reuse, or parent/child races.
- Terminal truth is broker-owned: `output_seq`, snapshots, replay, live output, final-output cutoff, exit ordering, and browser hydration all share one per-session sequence domain.
- Control frames/messages and raw PTY bytes must remain separated across broker and browser transports.
- Subscription replay/live output associated with a broker response must not be observable before that response is written.
- Project selection must stay unambiguous: named project, explicit existing directory, and new-project flows are mutually constrained and server-validated.
- Remote exposure is shell-equivalent host access. Tailscale/canonical-origin/device/user verification is the primary remote trust boundary; JWT is additive.
- Passive inspection is read-only exact-ID snapshotting: no PTY attach, no resize, no subscription, no input, and no take-control.
- Slow terminal consumers are shed rather than buffered indefinitely because broker snapshots/replay are the recovery mechanism.
- Durable task/relay serialization and hashes are migration-sensitive; canonical JSON ordering changes can invalidate stored ledgers or digests.
- Child-agent launch remains same-harness and parent-identity pinned; model override is a bounded Pi-only option.
- Pi task-worker readiness is exact live session + canonical root + Pi harness + relay endpoint registration, not model/task execution evidence.

## Cross-module coupling / blast radius

- **Server restart** should preserve sessions because PTYs live in the broker; it is the lower-blast-radius update path when broker protocol/state do not change.
- **Broker restart** terminates broker-owned PTYs/snapshots/replay and breaks live continuity unless a future tested handoff protocol exists.
- **Broker protocol/session changes** affect Rust broker, TS broker client/backend, terminal WS attach/reconnect, passive inspector, docs/protocol/session-control, and real-broker tests.
- **Terminal hydration/resize/inspection changes** jointly affect server WS/snapshot routes, browser socket/controller/loading/order logic, broker snapshot/resize behavior, Control API schema, and replay/prefill/takeover/e2e tests.
- **Auth/Tailnet changes** affect server routes/upgrades, browser peer registry/fetch behavior, CLI remote control, Pi skill guidance, docs/site exposure wording, and integration/e2e fixtures.
- **Task/relay/task-worker changes** affect durable server stores/gateways, canonical JSON, generated Control API schema/docs, Pi skill expectations, readiness cleanup, Tailnet federation tests, and notification/session-target routing.
- **Build/install/setup changes** affect scripts, optional broker artifacts, service staging paths, setup/service restart handoff, provider readiness, docs/site install guidance, and release/install policy tests.

## Architecture overview

Wolfpack is a self-hosted control room for persistent coding-agent terminals. The TypeScript server/CLI/browser layer authenticates users, validates project/session intent, exposes HTTP/WS/CLI surfaces, handles Tailnet peers, tasks, notifications, setup, and packaging. The Rust broker is the local daemon that owns PTY child processes and terminal state behind an owner-only Unix socket.
