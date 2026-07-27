# Security Review Report

## What Changed
- Target: uncommitted `feat/libghostty-vt-authoritative` worktree diff
- Baseline: `main` at `88ec617d005abd48088c3512d3f432cc10ebdac5`
- Files reviewed: 41 implementation/evidence artifacts (excluding these three review reports)
- Security-relevant files: 12
- Context loaded: repository index, broker-daemon, terminal-session-shared, server-runtime, tests, docs-build-release, and known issues from `/Users/home/Dev/wolfpack/edc-context`

## Findings

### No security findings
No exploitable or security-relevant issue remains in the reviewed scope.

Checked:
- C/Rust memory boundary: allocation multiplication, index/coordinate conversion, UTF-8 accumulation, text offsets, null pointers, output capacities, free paths, and error propagation in `broker/native/ghostty_vt_shim.c:109-132`, `broker/native/ghostty_vt_shim.c:312-397`, and `broker/native/ghostty_vt_shim.c:400-487`.
- Input bounds: snapshot reflow is rejected above 300 columns at `broker/src/session_router.rs:259-273`; extraction is capped below the broker frame ceiling at `broker/src/terminal_state.rs:42-46` and `broker/src/terminal_state.rs:218-275`.
- State mutation: feed failure closes subscribers at `broker/src/session.rs:566-592`; resize reports PTY failure plus terminal rollback failure instead of partially claiming success at `broker/src/session.rs:492-525`.
- Build trust boundary: source archive and patches are hash-checked, extraction starts fresh from the authenticated archive, and generated archives/headers/manifests are revalidated at `scripts/build-ghostty-vt.ts:69-111` and `scripts/build-ghostty-vt.ts:208-243`.
- Cargo link boundary: target, lock, archive, header tree, and forbidden host `memset` symbol checks fail closed before target-aware C compilation at `broker/build.rs:34-69` and `broker/build.rs:92-190`.
- Security history/regression scan: no removed auth, validation, sandboxing, or prior security fix was reintroduced. The relevant prior integration is `006bf01`.

Resolved during review:
- The prebuild previously trusted an extracted source directory when a ready marker existed. It now deletes that tree and re-extracts from the verified archive on every invocation (`scripts/build-ghostty-vt.ts:100-117`), with a policy regression at `tests/unit/build-ghostty-vt.test.ts:67-70`.

## Security Test Confidence
- FFI limit and malformed-input coverage: `broker/tests/terminal_ffi_safety.rs`, `broker/tests/terminal_ghostty_stress.rs`, and `broker/src/terminal_state.rs` unit tests.
- Static-link and symbol-policy coverage: `broker/tests/ghostty_static_link.rs`, `tests/unit/broker-build-policy.test.ts`, and `tests/unit/build-ghostty-vt.test.ts`.
- Transactional state/error coverage: `broker/src/session.rs` tests and real broker snapshot/reflow integration.
- Provenance/attribution coverage: `tests/unit/build-ghostty-vt.test.ts`, `tests/unit/setup-zig-cache-provenance.test.ts`, and `tests/unit/third-party-notices.test.ts`.
- No security-sensitive path in this diff is intentionally mocked away without a real boundary test.

## Blast Radius
- Reachable entrypoints: broker terminal feed, resize, snapshot/reflow, Cargo build, CI release cross-build, local distribution build.
- Affected modules: broker-daemon, terminal-session-shared, tests, docs-build-release; broker protocol and browser renderer contracts are unchanged.
- Preserved invariants: Rust remains PTY/session/replay authority; snapshot errors are structured; local broker socket trust is unchanged; release inputs fail closed on provenance mismatch.

## Historical Context
- Legacy and shadow terminal paths are deleted rather than bypassing protections.
- The pinned Ghostty static-host-`memset` patch remains enforced at source, bundle, Cargo build, and static-link test layers.
- No relevant CVE/security commit was reverted.

## Limitations
- Generated EDC context is absent from the clean worktree and was loaded from the sibling repository at source commit `4fb975b`; current source/diff inspection was authoritative.
- Non-host final links for Darwin x64 and Linux x64/arm64 require their CI runners/toolchains and were not locally executed.
- The pinned upstream Ghostty implementation itself was not re-audited beyond the narrow patched/exposed API and Wolfpack shim boundary.

## Recommendation
APPROVE
