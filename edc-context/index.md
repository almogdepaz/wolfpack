# Wolfpack EDC Context Index

## How to use

Start here, then open only the module sections for the paths or contracts you are changing. `edc-context/manifest.json` is routing authority; the workflow selectors below do not change path ownership.

Do not treat generated bundles, staged EDC artifacts, screenshots/media, generated schemas, site assets, or prior test results as source truth. Reports and contextless machine coverage are intentionally outside the normal human read path.

## Route by path/task

| Path or task | Read first | Notes |
| --- | --- | --- |
| `broker/**` | `modules/broker.md` | Rust PTY daemon, protocol, terminal state, and FFI. |
| `src/**`, `public/**`, `bin/**`, `scripts/**` | `modules/wolfpack.md` | Server/CLI/browser runtime and packaging; select the relevant internal section. |
| `tests/**` | `modules/tests.md` | Harness selection and regression intent, not production authority. |
| Auth or Tailnet | `modules/wolfpack.md` | Authority Boundaries; Browser App, Grid, and Session Cards. |
| Tasks, relay, or task-worker readiness | `modules/wolfpack.md` + relevant `modules/tests.md` sections | Separate durable tasks from volatile relay; select worker/compiled/process/package coverage as needed. |
| Setup, install, service, or release | `modules/wolfpack.md` + relevant `modules/tests.md` sections | Separate package launch, foreground startup, and managed installation. |

## Global boundaries

- Broker UUIDs/session IDs identify sessions; names are convenience selectors. The broker owns PTYs and terminal truth.
- Remote exposure is shell-equivalent host access. Owner-API auth does not replace trusted Tailnet/canonical-origin verification.
- Tasks are durable authority; relay is volatile, epoch-bound transport, not restart recovery or task-execution evidence.

## Conditional cross-boundary reads

- For protocol, attach/reconnect, resize, or passive inspection changes, read the matching broker and wolfpack sections plus real-broker test guidance.
- For restart/install changes, consult broker lifecycle guidance only when broker ownership or replacement is affected. Server-only restarts preserve broker PTYs, not volatile relay state; broker restart terminates PTYs.
- For relay worker changes, select compiled/process checks; for packaged delivery or installation, also select artifact/lifecycle checks in `modules/tests.md`. Skips are not verification.

## Architecture overview

Wolfpack is a self-hosted control room for persistent coding-agent terminals. The TypeScript server/CLI/browser layer authenticates users, validates project/session intent, exposes HTTP/WS/CLI surfaces, handles Tailnet peers, tasks, notifications, setup, and packaging. The Rust broker is the local daemon that owns PTY child processes and terminal state behind an owner-only Unix socket.
