# Wolfpack EDC Context Index

## How to use

Start here to route work, then open only the module document(s) for the paths or contracts you are changing:

- `edc-context/modules/wolfpack.md` for Bun server/CLI/browser/runtime, broker client boundary, sessions, Tailnet, tasks, packaging.
- `edc-context/modules/broker.md` for the Rust PTY broker daemon, Unix-socket protocol, PTY lifecycle, snapshots, replay, resize, Ghostty FFI.
- `edc-context/modules/tests.md` for test harnesses, CI/e2e fixtures, and executable regression contracts.
- `edc-context/modules/docs.md` for docs/site/API-publication wording and doc authority boundaries.
- `edc-context/modules/skills.md` for the bundled Pi control skill and agent-facing Wolfpack instructions.

Do not treat generated bundles, staged EDC artifacts, screenshots, or prior test results as source truth. Reports and contextless machine coverage are intentionally outside the normal human read path.

## Route by path/task

| Path or task | Read first | Notes |
| --- | --- | --- |
| `broker/**` | `modules/broker.md` | Broker owns PTY children, registry, output sequence/replay, snapshots, resize transaction, socket codec/server, and Ghostty VT FFI bounds. |
| `src/**`, `public/**`, `bin/**`, `scripts/**` | `modules/wolfpack.md` | Covers server HTTP/WS auth, session/project APIs, broker client/backend, browser terminal hydration, Tailnet peers, tasks/relay/push, setup/service/build. |
| `tests/**` | `modules/tests.md` | Use for harness behavior and regression intent; production modules remain semantic authority. |
| `docs/**`, `site/**` | `modules/docs.md` | Docs/site publish user contracts but do not override runtime validation, auth, broker, service, or installer behavior. |
| `skills/**` | `modules/skills.md` | Skill is a policy wrapper over public Wolfpack CLI/API, not an independent protocol/auth authority. |
| Broker protocol or terminal attach/reconnect changes | `modules/broker.md` + `modules/wolfpack.md` + relevant `modules/tests.md` sections | Highest coupling: Rust protocol/session sequencing, TS broker client/backend, WS attach, browser hydration, and real-broker tests must stay aligned. |
| Auth, Tailnet, remote machine, or browser peer changes | `modules/wolfpack.md` + `modules/docs.md` + `modules/skills.md` as needed | Stable machine identity/canonical origin are routing authority; labels and forwarded headers are not. |
| Tasks, relay, notification, or Pi integration changes | `modules/wolfpack.md` + `modules/docs.md` + `modules/skills.md` + task tests in `modules/tests.md` | Wolfpack owns durable task/relay stores; Pi skills/extensions are clients over public surfaces. |
| Install, release, service, or broker artifact changes | `modules/wolfpack.md` + `modules/broker.md` + `modules/docs.md` + `modules/tests.md` | Preserve server-only vs broker restart blast-radius warnings and artifact provenance checks. |

## Critical global invariants

- Broker UUIDs/session IDs are durable authority. Visible names are convenience selectors and must fail closed on ambiguity, reuse, or parent/child races.
- Terminal truth is broker-owned: `output_seq`, snapshots, replay, live output, exit ordering, and browser hydration all share one per-session sequence domain.
- Control frames/messages and raw PTY bytes must remain separated across broker and browser transports.
- Project selection must stay unambiguous: named project, explicit existing directory, and new-project flows are mutually constrained and server-validated.
- Remote exposure is shell-equivalent host access. Tailscale/canonical-origin/device/user verification is the primary remote trust boundary; JWT is additive.
- Generated/staged artifacts, public bundles, generated schemas, media, and test results are not source truth; route back to owning source/contracts.
- Slow terminal consumers are shed rather than buffered indefinitely because broker snapshots/replay are the recovery mechanism.
- Durable task/relay serialization and hashes are migration-sensitive; canonical JSON ordering changes can invalidate stored ledgers or digests.

## Cross-module coupling / blast radius

- **Server restart** should preserve sessions because PTYs live in the broker; it is the lower-blast-radius update path when broker protocol/state do not change.
- **Broker restart** terminates broker-owned PTYs/snapshots/replay and breaks live continuity unless a future tested handoff protocol exists.
- **Broker protocol changes** affect Rust broker, TS broker client/backend, terminal WS attach/reconnect, docs/broker-protocol, and real-broker integration/e2e tests.
- **Terminal hydration/resize changes** jointly affect server WS handling, browser socket/controller/order logic, broker snapshot/resize behavior, and tests for replay, prefill, takeover, slow viewers, and reconnect.
- **Auth/Tailnet changes** affect server routes/upgrades, browser peer registry/fetch behavior, CLI remote control, Pi skill guidance, docs/site exposure wording, and integration/e2e fixtures.
- **Task/relay changes** affect durable server stores/gateways, generated Control API schema/docs, Pi skill expectations, Tailnet federation tests, and notification/session-target routing.
- **Build/install changes** affect scripts, optional broker artifacts, service staging paths, docs/site install guidance, and release/install policy tests; broker binary provenance must remain aligned.

## Architecture overview

Wolfpack is a self-hosted control room for persistent coding-agent terminals. The TypeScript server/CLI/browser layer authenticates users, validates project/session intent, exposes HTTP/WS/CLI surfaces, handles Tailnet peers, tasks, notifications, setup, and packaging. The Rust broker is the local daemon that actually owns PTY child processes and terminal state behind an owner-only Unix socket.
