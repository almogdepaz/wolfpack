# Audit Improvements Implementation Roadmap

Branch: `feat/audit-improvements`  
Worktree: `/Users/home/Dev/wolfpack-all-improvements`

This roadmap turns the performance/UX/rendering/reliability audit into independently testable changes. Preserve the broker ordering, snapshot, resize rollback, security, and bounded-queue invariants documented in `edc-context/`.

## P0 correctness and scaling

- [x] Ordered browser/server/broker resize acknowledgement; browser renderer commits dimensions only at the broker-confirmed cut; representative ANSI race regression.
- [x] Replace per-session dashboard snapshots with output-sequence invalidation and a shared observation cache; snapshot only when the sequence changes.
- [x] Batch runtime-state persistence to one write per observation; atomic private durable writes replace per-session rewrites.
- [x] Compact snapshot wire data by omitting default attributes, bound extraction before allocation, and cap concurrent broker snapshots.
- [ ] Move snapshot serialization outside the terminal lock and add broker-side sequence-keyed snapshot reuse.
- [x] Atomic snapshot+live attach broker operation or equivalent proven cut that cannot replay-truncate between separate RPCs.
- [x] Exit `final_seq` barrier and bounded exited-session tombstone so final output precedes lifecycle closure.

## Network, WebSocket, and auth reliability

- [x] Set transport-level WebSocket payload maximum and per-IP upgrade/connection quotas; validate pending viewers consistently.
- [x] Catch every attach task failure; distinguish legitimate empty snapshot from snapshot failure and close/retry with a typed reason.
- [x] Server pong deadlines terminate zombie pending/active viewers.
- [x] Reconnect budget resets only after authoritative terminal readiness, not TCP open; online/offline transitions are explicit.
- [x] All browser API requests have a composable hard timeout and preserve caller cancellation.
- [x] Abort superseded dashboard/preview refreshes and invalidate stale continuations before they can render.
- [x] Browser terminal input observes a strict WebSocket buffered-byte high-water mark.
- [x] Truthful draft lifecycle plus an ordered 4 MiB broker stdin queue and allocation-time per-kind frame limits.
- [x] Functional browser JWT flow with centralized fetch auth, explicit 401 UX, short-lived one-time WS tickets, and per-peer tab-scoped credentials.
- [x] Replace mixed-context inline event-handler construction with delegated DOM listeners and inert data/text contexts.
- [x] Private or memory-only session identity persistence modes with random exclusive temp files, owner-only permissions, fsync, and atomic rename.

## Rendering and frontend performance

- [x] Lazy-load Ghostty; idle/device-aware prewarm and compiled-module reuse where supported.
- [x] Adaptive grid scrollback/memory policy.
- [ ] Audit and enforce prompt disposal of every hidden terminal controller.
- [x] Production syntax/whitespace minification plus enforced raw/gzip bundle budgets.
- [ ] Replace the aggregate content version with per-asset content-hashed URLs.
- [x] PWA app-shell offline fallback; never cache API, WebSocket, or terminal authority data.
- [ ] Cache terminal recovery data with TTL, explicit clear control, and privacy disclosure/opt-out.

## Product and accessibility UX

- [x] Browser session creation supports an optional initial task prompt.
- [ ] Efficient cached session output preview when output sequence changes.
- [ ] Proper drawer buttons/list semantics, chip expanded state, input labels/descriptions, modal overlays, SPA landmarks/focus.
- [x] iOS safe-area layout and consistent manifest/document theme colors.
- [ ] WCAG contrast/touch-target/reduced-motion improvements and automated axe coverage.
- [ ] More robust visual-viewport keyboard geometry.
- [ ] Accessible selected/pressed/current states for settings and navigation.

## Broker resource performance

- [ ] Byte-bounded control/output queues, snapshot/connection/subscription caps, queue high-water metrics.
- [ ] Shared immutable output bytes and vectored framing to reduce fanout copies.
- [ ] Byte+chunk replay retention and weighted control/output fairness without violating response ordering.
- [ ] Scale session threads/stacks and registry creation contention; preserve atomic name reservation with pending state.

## Testing, release, CLI, and operability

- [ ] CI runs all integration tests and critical Chromium/mobile-WebKit E2E; remove stale test paths and verify explicit paths exist.
- [ ] Pin/freeze main CI toolchains/dependencies consistently.
- [ ] Reliable isolated E2E fixtures and useful trace-on-failure configuration.
- [ ] Installed-artifact/package/broker smoke before release publication.
- [ ] Performance harness enforces desktop/mobile cold/warm p95, heap, long-task, console-error, and bundle budgets.
- [ ] Axe active-view/dialog scans plus documented VoiceOver/TalkBack checklist.
- [ ] Safe explicit non-interactive setup that preserves existing config; complete subcommand help and `doctor --json`.
- [ ] Hermetic doctor unit tests; host inspection/fixes only in opt-in smoke tests.
- [ ] Authenticated/local health readiness, bounded JSON/Prometheus metrics, broker health state machine.
- [ ] Log rotation/retention, size warnings, and `wolfpack logs --follow/--json`.
- [ ] Split browser controller and route families behind existing facades; expand strict TypeScript coverage.

## Validation gates

- [ ] `bun run typecheck`
- [ ] full Bun unit/snapshot/integration suite
- [ ] broker `cargo test --locked --all`
- [ ] critical Playwright Chromium and mobile WebKit suites
- [ ] terminal load performance budgets
- [ ] package/install smoke in a temporary HOME
- [ ] clean worktree and review against every checkbox above
