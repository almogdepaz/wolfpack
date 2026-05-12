# Issues Report — Wolfpack Codebase

> Last updated: 2026-05-12. Branch: fix/broker-zombie-recovery.

## Status

All audit findings from the original 2026-05-10 sweep have been triaged. The
breakdown:

- **29 fixed in-branch** (commit batches 1–6)
- **10 declined as no-op or accepted by-design** (intentional behavior)
- **6 tracked as GitHub issues** (complex / non-trivial; require design or
  upstream coordination)

The branch is closeable from this report's standpoint. Open issues below
carry the residual work.

---

## Open issues (tracked on GitHub)

| # | Severity | Title |
|---|---|---|
| [#128](https://github.com/almogdepaz/wolfpack/issues/128) | MEDIUM | M2: ralph lock TOCTOU window between stale-unlink and wx retry |
| [#129](https://github.com/almogdepaz/wolfpack/issues/129) | MEDIUM | M5: quiescence loop produces stale snapshot for animated TUIs |
| [#130](https://github.com/almogdepaz/wolfpack/issues/130) | MEDIUM | M10: forceRepaint() accesses ghostty-web private internals |
| [#131](https://github.com/almogdepaz/wolfpack/issues/131) | LOW | L10: broker WRITER_QUEUE_CAPACITY can backpressure the read loop |
| [#132](https://github.com/almogdepaz/wolfpack/issues/132) | LOW | L12: injectAgentContext silent fallback on --append-system-prompt rejection |
| [#133](https://github.com/almogdepaz/wolfpack/issues/133) | LOW | L16: audit-regressions.test.ts inlines a copy of validateProjectDir |

Each issue includes location, impact, and concrete fix candidates. None are
blocking; the practical risk for each is documented in the issue body.

---

## Open follow-ups from broker zombie/wedge investigation

Commit `f27d436` addressed the TS client side of the 8h broker zombie via two
defensive layers (`BrokerClient` request-timeout circuit breaker + `BackendRouter`
recovery watchdog). Broker-side root causes documented in `broker_stall.md` are
deferred:

| # | Severity | Title | Location |
|---|---|---|---|
| BS1 | MEDIUM | Peers keep re-entering EPIPE every few hours — eviction on write error already happens (`server.rs:307` breaks on first failure); open question is *why* peers reach this state so often (likely TS circuit-breaker reconnects from `f27d436` racing peer close). Diagnostic, not mechanical. | `broker/src/server.rs` writer task |
| BS2 | MEDIUM | Chronic-lag subscribers — `subscription_dropped` is emitted but no policy prevents immediate re-lag (potential busy loop) | `broker/src/output_bus.rs`, `broker/src/server.rs` |
| BS3 | MEDIUM | Handshake / request path fate-sharing — `list_sessions` can succeed while later request-handler tasks are starved/stuck (the root-cause shape of the 8h zombie) | `broker/src/server.rs` per-conn dispatcher |
| BS4 | LOW | Potential RSS leak — 686 MB observed after 5 days uptime; source (ring buffer, broadcast backlog, or elsewhere) not yet identified | `broker/src/` (broad) |

Suggested next actions: request-path liveness probe in addition to handshake,
investigate the EPIPE-reconnect cadence (correlate with TS circuit-breaker
trips), lag-subscriber policy (force-disconnect or drop backlog). None
promoted to GitHub issues yet.

---

## Resolved findings (history)

### Pre-existing fixes (before this branch)

- SIGINT ralph cleanup
- SW open-redirect (sanitizeNotificationUrl)
- broker WS subscribe failure (onSubscribeError mitigation)
- grid WASM isolation guard
- JWT startup misconfiguration silent
- ralph srt-settings PID race
- broker subscribe RPC dead-viewer
- sinceSeq bigint truncation (clamped)
- reconnect resubscribe seq loss
- hydration write epoch

### Resolved in fix branch

| Batch | Items |
|---|---|
| 1 | review-task fixes: broker codec doc-paths, sinceSeq max-prev, ralph shutdown re-entry, onSubscribeError required, test hardening (refcount probe, deadPid helper, regex hardening) |
| 2 | H5 isSessionAlive list() refresh, H6 parseRalphLog PID-reuse via ps cmdline filter |
| 3 | M1 CLI short-secret warning, M3 broker reconnect jitter, M6 PTY teardown order, M7/L14 onReplayTruncated wiring, M8 config.json mode 0600, M11 Enter retry duplicate, M12 localStorage URL validation |
| 4 | L1 icon-192.png, L3 _wfTrace gating, L9 broker JSON TextDecoder fatal, L13 settings agentCmd normalization |
| 5 | L2 sw.js rename, L4 resolveRipgrepBin memoized, L6 worktree mtime sort fallback, L8 setup non-interactive announcement |
| 6 | M9 push subscription dir fsync |

### Declined (no-op or accepted by-design)

| Finding | Reason |
|---|---|
| H1 dev-mode auth bypass | Intentional — JWT enforced only when configured |
| H2 Tailscale-User-Login trust | Intentional — assumes Tailscale ingress |
| H3 broker socket per-conn auth | Declined — 0600 + same-UID threat model = noop ROI |
| H4 ralph sandbox optional | Intentional — sandbox is opt-in |
| M4 since_seq protocol gap | Clamped; residual unfixable without protocol change |
| L7 removeWorktree --force fallback | Warning added; no recovery possible |
| L15 CLOSE_CODE_SERVER_ERROR doc gap | Constant added; classifyDisconnect falls through correctly |
| L17 uninstall flag position | Guard added; position-insensitive intentional |
| L5 peer health no persistence across reload | Reverted — stale failure state self-fulfills (slow-but-healthy peer permanently stuck at 1.5s budget once it crosses threshold). Per-tab in-memory is correct scope. |
| L11 server peer-fetch adaptive timeouts | Reverted — same self-fulfilling-prophecy trap on the server side. Health check should be a small heartbeat, not a piggyback on the aggregate fetch. Fixed 3s timeout retained. |
