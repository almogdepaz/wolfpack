# take-control output lag loop — 2026-07-22

status: second-review findings fixed and fully verified; awaiting final review
branch: fix/take-control-output-lag
base: PR #196 head 88f603d2d1da3cf9be05fc06e42bf3b6e79c1506

## goal

high-volume tui output during takeover must not overflow the broker subscription forwarder, trigger repeated `replay_truncated` reconnects, or expose a continuous redraw stream.

## evidence

- live server logs during repro repeatedly report `replay_truncated — forcing client reconnect for fresh snapshot`.
- broker logs at matching timestamps report `subscription forwarder lagged broadcast`, dropping 203–1980 chunks per cycle.
- `OutputBus` broadcast capacity is 256 chunks.
- `forward_output` stops draining the broadcast receiver while awaiting a full per-connection writer queue, so a short high-volume burst can overflow even when total bytes are manageable.

## success criteria

- deterministic broker regression fills the writer queue, publishes beyond broadcast capacity, then receives every byte without `SubscriptionDropped`.
- forwarder keeps draining during writer backpressure and coalesces contiguous chunks into bounded output frames.
- seq watermark advances to the last coalesced chunk without gaps or duplication.
- ordinary replay/live ordering remains intact.
- broker/unit/integration/full suites pass.
- broker restart requires explicit approval because active sessions are lost.

## verification

- focused regression red before fix: `SubscriptionDropped`, lagged 1 chunk in the deterministic backpressure case.
- focused regression green after fix: 2,000 one-byte chunks arrive in one coalesced frame with seq 2,000 and no drop event.
- full Rust broker suite after final ordering fix: 178 passed, 0 failed (142 lib + 3 bin + 27 socket integration + 6 fixtures).
- full Bun suite on the final stacked candidate: 1,828 passed, 0 failed.
- full Playwright run: 100 passed, 123 skipped, 2 failures in `broker-shell-reconnect`; the same `/tmp/marker.txt` → `/tmp/markerxt` mobile-proxy failure reproduces unchanged on pristine 921e46e and is unrelated to broker output forwarding.
- real-browser multi-session redraw takeover is red against the old broker (four lagged subscriptions) and green 3/3 against the updated broker.
- full Playwright after final fixes: 105 passed, 126 expected skips.
- sidebar-hover test synchronization now waits for initial hydration opacity; reproduced red twice in full runs, then passed focused 5/5 and in the final full run.
- clippy remains blocked by six pre-existing warnings in untouched files; no new clippy finding points at `broker/src/server.rs`.
- full broker deploy completed: broker PID 34586 → 28214. No post-restart `subscription forwarder lagged broadcast` event has been logged.
- initial deployed version still allowed output to fill the shared writer queue; server logged broker request timeouts and one later `replay_truncated`.
- follow-up fix separates prioritized control/event traffic from bounded output traffic and restores the pre-coalescing 8 KiB frame limit.
- rebased onto PR #196 head and deployed server-only for keyboard testing: server PID 62749 → 68020; broker PID 28214 and all four session identities preserved.
- live app hash: `b2f548b08b293a80be1932659da375c6f05b96b946d09ac8b95103cafd5b2521`.
- live Ghostty hash: `20a5074d3ef7a4e8aa5555ffc7c2ac936227cd094bd5949a7be08a2711a68f57`; `insertReplacementText` present once and `preventScroll` twice.

## status

- [x] add and verify failing broker regression (`SubscriptionDropped`, lagged 1–2 chunks in the minimal case)
- [x] implement bounded drain/coalescing
- [x] verify focused broker test with a 2,000-chunk burst
- [x] verify full broker and Bun suites; relevant takeover/TUI E2E passes
- [x] review deployment tradeoff with user and perform approved broker restart
- [x] add real-browser/fixed-broker multi-session redraw takeover regression; old broker logs four subscription lags, fixed broker passes without lag or reconnect (3/3 repeat)
- [x] add replay→live ordering/watermark coverage
- [x] add sustained-output 8 MiB cap/lag-recovery coverage
- [x] document coalesced frame seq and prioritized control ordering contracts
- [x] preserve the writer queue's prior ~8 MiB output memory envelope
- [x] repeat all review passes on `3da0f12`; security approved, but output-priority race blocked shipping
- [x] queue `subscription_dropped` behind accepted output as a per-connection ordering barrier
- [x] add real socket-writer control-priority coverage
- [x] add TS recovery coverage proving the barrier resumes from the last delivered chunk seq
- [x] document `subscription_dropped` and remove remaining byte-offset comments
- [x] run full Rust, Bun, Playwright, typecheck, formatting, and diff verification on the final head
- [ ] repeat all review passes on the final head
- [ ] manually verify real Android/Gboard input
