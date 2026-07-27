# Wolfpack application

## When to read this
Read this for browser/PWA behavior, Bun server/CLI behavior, session identity/control, or the TypeScript side of the broker boundary. Pair it with `broker.md` for any change that changes broker RPCs, session lifecycle, terminal snapshots, or output ordering. The Rust broker—not this module—owns PTYs and terminal state.

## Authority and boundaries
The Bun server is a broker client and HTTP/WebSocket policy boundary; it must not acquire a fallback PTY implementation (`src/server/backend.ts`, `src/server/broker-backend.ts`). The browser is a renderer/controller, not an authority for terminal history: it connects to `/ws/pty`, receives a broker-derived snapshot/prefill plus output, and must recover by reconnecting when continuity is lost (`src/server/websocket.ts`, `public/app.ts`).

The CLI owns installation/setup/service orchestration and deliberately restarts only the server during ordinary upgrades so broker-owned sessions survive (`src/cli/index.ts`, `src/cli/service.ts`). Persistent user configuration and session identity are separate local files; preserve their validation and atomic-write behavior rather than treating either as browser state (`src/cli/config.ts`, `src/server/session-identity.ts`, `src/server/persistence.ts`).

## Security and trust contracts
- The HTTP server accepts localhost and configured tailnet HTTPS origins. Its special no-Origin path trusts Tailscale's injected login header; forwarding arbitrary client headers through another reverse proxy would invalidate that assumption (`src/server/index.ts`). JWT is optional, but an explicitly invalid configured secret is fatal before bind; a missing secret is intentionally unauthenticated and loudly logged (`src/auth.ts`, `src/server/index.ts`).
- API authentication is applied before route dispatch and WebSocket upgrade; session control has no per-session ACL. Tailnet/global Wolfpack access is therefore equivalent to authority over all visible local-agent sessions (`src/server/index.ts`, `src/server/http.ts`).
- Session creation validates project selection/name and command shape, but selected commands execute as the local user in the selected directory. Keep command validation, project-directory validation, and server-owned initial-prompt delivery together (`src/validation.ts`, `src/server/session-create.ts`, `src/server/broker-backend.ts`).
- Identity persistence may retain an external-agent identifier locally, but public API projection must redact it. Parent-session lineage is passed to the broker as environment metadata and reconstructed across server restart (`src/server/session-identity.ts`).

## Broker integration and recovery
`BackendRouter` is the lifecycle owner for the persistent Unix-socket client. It probes the socket synchronously at startup, verifies a handshake before serving, tears down a wedged client after consecutive RPC timeouts, and has a single-flight watchdog to recreate it (`src/server/backend.ts`, `src/broker/client.ts`). Do not move retry policy into arbitrary route callers: callers know idempotency, while the client preserves subscriptions across reconnects.

`BrokerBackend` maintains the server-local name-to-broker-ID cache, converts control operations to RPCs, and derives display prefill from snapshots. Its subscriptions are refcounted: the first viewer subscribes and the last unsubscribes; reconnect reissues active subscriptions. A `replay_truncated`/subscription failure is a visual-consistency failure, not a harmless log condition (`src/server/broker-backend.ts`, `src/broker/client.ts`).

## Terminal attach invariants
- A browser attach is a staged transition: settle dimensions, apply one resize, wait for redraw quiescence, take a broker snapshot, then stream ordered post-snapshot output (`src/server/websocket.ts`). Bypassing the settle/quiescence path reintroduces stale or half-redrawn terminal flashes.
- One active viewer owns a session; takeover displaces the previous viewer. Slow viewers are closed at the bounded output queue rather than retaining unbounded terminal bytes, because a fresh snapshot is the recovery source of truth (`src/server/websocket.ts`).
- Prefill is chunked for mobile responsiveness and initial overlap with live output is stripped only when byte identity proves it. Treat `prefill_done`, close codes, resize/attach frames, and reconnect as a protocol; changing one requires browser and server tests (`src/server/websocket.ts`, `public/app.ts`, `src/ws-constants.ts`).
- Grid/viewport attach intentionally uses smaller scrollback and shorter settle budgets than a full terminal. Preserve those mode distinctions when tuning terminal-load performance (`src/server/websocket.ts`, `public/app-grid.ts`, `src/terminal-prefill.ts`).

## Session creation, identity, and control
Top-level creation chooses a collision-resistant display name then retries only broker duplicate-name races; the broker session UUID returned by create is the durable identity (`src/server/session-create.ts`, `src/server/broker-backend.ts`). Child/delegated sessions carry parent identity without copying the parent transcript. CLI control requests are server-owned calls and should use UUID-aware selector/identity paths rather than infer identity from a rendered session name (`src/cli/session-control.ts`, `src/server/session-selector.ts`, `src/server/session-identity.ts`).

## Source pointers and verification
- Public route surface and request policy: `src/server/index.ts`, `src/server/routes.ts`, `src/server/http.ts`, `src/auth.ts`.
- Broker boundary, reconnection, snapshots, and subscriptions: `src/server/backend.ts`, `src/server/broker-backend.ts`, `src/broker/client.ts`, `src/broker/codec.ts`.
- Browser terminal lifecycle and grid: `public/app.ts`, `public/app-grid.ts`, `public/app-state.ts`.
- CLI/setup/service release behavior: `src/cli/index.ts`, `src/cli/setup.ts`, `src/cli/service.ts`, `bin/run.cjs`, `scripts/build.ts`.
- Exercise cross-boundary behavior with `tests/integration/broker-*.test.ts`, `tests/e2e/terminal*.ts`, `tests/e2e/broker-*.ts`, and `tests/unit/*identity*`, `*reconnect*`, `*terminal*` tests; typecheck with `bun run typecheck`.
