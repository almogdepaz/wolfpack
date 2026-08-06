# Audit Improvements Implementation Roadmap

Branch: `feat/audit-improvements`  
Worktree: `/Users/home/Dev/wolfpack-all-improvements`

This roadmap turns the performance/UX/rendering/reliability audit into independently testable changes. Preserve the broker ordering, snapshot, resize rollback, security, and bounded-queue invariants documented in `edc-context/`.

## P0 correctness and scaling

- [x] Ordered browser/server/broker resize acknowledgement; browser renderer commits dimensions only at the broker-confirmed cut; representative ANSI race regression.
- [x] Replace per-session dashboard snapshots with output-sequence invalidation and a shared observation cache; snapshot only when the sequence changes.
- [x] Batch runtime-state persistence to one write per observation; atomic private durable writes replace per-session rewrites.
- [x] Compact snapshot wire data by omitting default attributes, bound extraction before allocation, and cap concurrent broker snapshots.
- [x] Keep JSON framing/serialization on the connection writer outside the terminal lock and reuse immutable broker snapshots by sequence and request shape.
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
- [x] Audit and enforce prompt disposal of hidden single, grid, collapsed, removed, suspended, and delegation terminal controllers.
- [x] Production syntax/whitespace minification plus enforced raw/gzip bundle budgets.
- [x] Replace aggregate query versions in browser asset URLs with each asset's own content hash.
- [x] PWA app-shell offline fallback; never cache API, WebSocket, or terminal authority data.
- [x] Cache terminal recovery data with a 24-hour TTL, explicit clear control, and privacy disclosure/opt-out.

## Product and accessibility UX

- [x] Browser session creation supports an optional initial task prompt.
- [x] Efficient bounded session output preview derived only when the output sequence changes and reused from the observation cache.
- [x] Proper drawer buttons/list semantics, chip expanded state, input labels/descriptions, modal overlays, SPA landmarks/focus.
- [x] iOS safe-area layout and consistent manifest/document theme colors.
- [x] WCAG contrast/touch-target/reduced-motion improvements and automated axe coverage.
- [x] More robust visual-viewport keyboard geometry using height and offset changes on resize/scroll.
- [x] Accessible selected/pressed/current states for settings and navigation.

## Broker resource performance

- [x] Byte-bounded control/output queues, snapshot/connection/subscription caps, and fixed-cardinality queue high-water metrics.
- [x] Shared immutable output bytes from replay through fanout and scatter/gather codec writes without payload materialization.
- [x] Byte+chunk replay retention and bounded-burst weighted control/output fairness without violating per-queue response ordering.
- [x] Scale session thread stacks and move process spawning outside registry contention while preserving atomic pending name reservations.

## Testing, release, CLI, and operability

- [x] CI discovers every integration test and runs critical Chromium/mobile-WebKit E2E without stale explicit paths.
- [x] Pin/freeze main CI actions, Bun, Rust, Zig, and dependency installation consistently.
- [x] Reliable isolated random-port E2E fixtures and retained trace/screenshot-on-failure configuration.
- [x] Installed-package plus native CLI/broker artifact smoke gates release publication in a temporary HOME.
- [x] Performance harness enforces desktop/mobile cold/warm p95, heap, long-task, console-error, and bundle budgets.
- [x] Axe active-view/dialog scans plus documented VoiceOver/TalkBack checklist.
- [x] Safe explicit non-interactive setup preserves existing config; complete subcommand help and `doctor --json`.
- [x] Hermetic doctor unit tests use injected checks; host inspection and fixes remain opt-in CLI smoke behavior.
- [x] Authenticated-or-loopback health readiness, fixed-cardinality JSON/Prometheus metrics, and an explicit broker health state machine.
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
