# Delivery / Architecture Review

## Summary
**Delivery verdict:** delivered
**Architecture fit:** fits

## Review Calibration
- real goal: make pinned `libghostty-vt` Wolfpack's unconditional authoritative broker terminal emulator and remove the legacy/shadow runtime without changing broker ownership or wire behavior.
- done evidence: accepted differential thresholds, no legacy/shadow production selectors or dependencies, Ghostty-only terminal state, preserved transactional broker behavior, release/build provenance, attribution, and end-to-end authoritative tests.
- not the goal: changing PTY/session ownership, replay sequencing, browser rendering, snapshot schema, compact VT checkpoints, or deploying the branch.
- non-obvious invariants: branch from latest `main`; Ghostty inputs are pinned/authenticated; extraction stays below 64 MiB; failures are structured and transactional; cross-target release artifacts include exact notices.

## Goal / Spec Delivery

| Requirement | Evidence in implementation | Status |
|---|---|---|
| Evidence must pass before branch creation | `.plans/libghostty-vt-cutover-evidence.md` records accepted correctness, safety, feed, RSS, snapshot, and attach/reflow thresholds | delivered |
| Start the final branch from latest `main` | branch and `main` both resolve to baseline `88ec617d005abd48088c3512d3f432cc10ebdac5` before the uncommitted implementation diff | delivered |
| Ghostty is unconditional and authoritative | `broker/Cargo.toml:1-34`, `broker/build.rs:34-69`, `broker/src/terminal_state.rs:311-375` | delivered |
| Remove legacy/shadow paths and dependencies | deleted legacy/shadow modules/tests; no tracked production reference to feature selectors, legacy types, `vte`, `unicode-width`, or `unicode-segmentation`; policy test at `tests/unit/ghostty-authoritative-policy.test.ts:10-59` | delivered |
| Preserve broker ownership, snapshots, replay, sequencing, and browser rendering | terminal semantics remain behind `TerminalState`; no protocol/browser source contract change; session integration remains in `broker/src/session.rs` | delivered |
| Fail safely without partial state commit | typed terminal errors and bounded extraction in `broker/src/terminal_state.rs`; feed closure and resize rollback handling in `broker/src/session.rs:492-592` | delivered |
| Pin/authenticate source, patches, headers, archives, bundles, and Zig | `ghostty-vt.lock.json`; `scripts/build-ghostty-vt.ts`; `scripts/setup-zig-0.16.0.sh`; `broker/build.rs` | delivered |
| Preserve static-link and attribution obligations | `broker/tests/ghostty_static_link.rs`; `THIRD_PARTY_NOTICES`; propagation in `scripts/build.ts:137-196`; release assets in `.github/workflows/release.yml:176-246` | delivered |
| Run authoritative integration/release/distribution gates | Cargo, Bun, typecheck, release broker, real broker integration, browser E2E, and distribution gates were exercised locally; cross-target final links remain CI-owned | delivered |
| Do not deploy without separate approval | no deployment path or live service was invoked from this worktree | delivered |

### Findings

No delivery findings.

## Architecture Fit

### Findings

No architecture-fit findings.

The change remains in the documented owners:
- `broker/**` owns terminal semantics, PTYs, session state, extraction, and broker errors.
- `scripts/**`, workflows, locks, patches, and notices own build/release provenance.
- Rust/TypeScript protocol definitions and browser rendering remain unchanged.
- The final public terminal API contains only construction, feed, resize, and snapshot operations; shadow-only metadata getters were removed.

## Integration / Rollout Notes
- Generated browser assets were regenerated during the distribution build and produced no source diff.
- All four package layouts receive `THIRD_PARTY_NOTICES`; local dev packaging fans out the host broker by design and is not evidence of cross-architecture linkage.
- Release workflow prebuilds the matching Ghostty archive before each target build and stages all four broker binaries.
- Rollback artifact identity remains the pre-cutover broker from baseline `88ec617`; no deployment/cutover was performed.

## Limitations
- Generated EDC context was absent from the clean worktree; advisory context came from `/Users/home/Dev/wolfpack/edc-context` at source commit `4fb975b`.
- Final non-host links for Darwin x64 and Linux x64/arm64 cannot be proven on the local arm64 macOS host; the pinned release CI jobs own those gates.
- The branch is intentionally uncommitted and unpushed pending explicit user direction.
