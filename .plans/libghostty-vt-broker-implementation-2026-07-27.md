# libghostty-vt broker implementation

status: final review findings resolved and acceptance matrix passed; ready to commit
task id: `task_c17dd256e0514994af8e986289f925e1`; correction tasks: `task_bb33db1ddcb441deb0bdc79351e2157c`, `task_d919e21993824a3faf3fc9c777387deb`, `task_47dc1fd2aa4647a8a19844b0b6d27de0`, `task_c60671122d8044e78d619756e42bd286`
started: 2026-07-27
scope: staged implementation in assigned worktree only; no commit/push/deploy/install/restart

## assumptions

1. `edc-context/index.md` is required by assignment but absent in this worktree; sibling `/Users/home/Dev/wolfpack/edc-context/index.md` is used for architecture context and this gap is reported.
2. release CI may install/use Zig; this worker will not install tooling locally.
3. the default local broker build must keep working without a prebuilt Ghostty archive, so Ghostty authority is delivered behind an explicit Cargo feature until release jobs prebuild the archive.
4. compact VT checkpoint rollout is deferred unless exact roundtrip can be proven; the implementation will not parse formatted VT to recover state.

## ~~1. Pin and prebuild libghostty-vt~~

- [x] add project-owned pinned source metadata and target archive layout
- [x] add a build script that downloads, sha256-verifies, extracts, and builds one static archive per release target
- [x] update release CI to prebuild archives before Cargo broker builds

## ~~2. Add minimal safe Rust/C boundary~~

- [x] add a small C shim over the unstable Ghostty API
- [x] compile/link the shim only when the `ghostty-vt` Cargo feature is enabled
- [x] wrap the opaque terminal handle in safe Rust with ownership/drop/error boundaries

## ~~3. Add batched structured extraction~~

- [x] batch visible/history row extraction through the shim without per-cell Rust FFI calls
- [x] map Ghostty cells/styles/modes/cursor/title to the existing Rust snapshot contract
- [x] preserve Rust broker PTY/session/seq/replay ownership and existing wire JSON shape

## ~~4. Add parity and shadow coverage~~

- [x] keep the existing emulator available as the default and as a shadow comparison source
- [x] add fixture parity tests for the wrapper where the feature is enabled
- [x] classify expected Ghostty-authoritative differences without logging terminal contents

## ~~5. Verify and document gates~~

- [x] run focused broker tests
- [x] run broader repo verification feasible without installing/deploying/restarting
- [x] record exact evidence, local blockers, and unattempted compact-checkpoint rationale

## correction 1 — real pinned build/runtime path

- [x] reproduce macOS archive/XCFramework failure with `/tmp/zig-0.16.0`
- [x] fix source-build arguments to avoid XCFramework output
- [x] restore Wolfpack ANSI palette contract in Ghostty options
- [x] add focused build-argument/palette regression coverage where practical
- [x] run real `ghostty-vt` fixture suite and record exact red/green evidence

## correction 2 — shadow architecture

- [x] make `ghostty-vt-shadow` legacy-authoritative through a dedicated composition layer
- [x] keep authoritative Ghostty backend free of shadow comparison state
- [x] compare only at snapshot boundaries
- [x] replace content-blind digest with bounded field-category mismatch counts
- [x] switch release CI to `ghostty-vt-shadow`
- [x] add real-feature tests for legacy-authoritative divergence and mismatch signaling
- [x] run focused real shadow tests and default regressions

## correction 3 — Ghostty scroll-region wire fidelity

- [x] prove authoritative Ghostty hardcodes full-screen margins before patch
- [x] prove shadow comparison misses scroll-region category before comparison fix
- [x] patch pinned Ghostty source to expose structured top/bottom through C data API
- [x] apply the patch deterministically during source preparation with zero fuzz
- [x] consume patched metadata in batched extraction without VT/formatted-output parsing
- [x] preserve authoritative snapshot/accessor top/bottom, including default/reset/resize
- [x] make shadow comparison count/report scroll-region mismatches
- [x] rebuild real pinned archive and run focused authoritative/shadow/default fixtures

## correction 4 — Ghostty FFI extraction safety

- [x] add end-to-end authoritative SessionRouter regression for oversized combining grapheme returning structured `internal_error` without panic
- [x] add checked C arithmetic for grapheme allocation, UTF-8 accumulation, offsets/lengths, cell indexing, point coordinates, and size conversions
- [x] impose bounded per-cell, per-snapshot extraction, and title limits below the 64 MiB broker frame ceiling
- [x] validate C-provided text ranges before Rust slicing
- [x] replace Ghostty allocation/resize/metadata/title/row extraction panics with typed `TerminalStateError` results
- [x] make shadow mode fail open to legacy and increment bounded non-content FFI diagnostics
- [x] make authoritative/session/router paths propagate terminal failures as structured `internal_error`
- [x] add helper/fault regression tests for overflow, oversized grapheme/snapshot, invalid offsets, C error returns, and shadow fail-open
- [x] add real-archive large combining-sequence integration coverage
- [x] run security-focused authoritative/shadow/default verification

## final security re-review follow-up — private pinned Zig bootstrap

- [x] reproduce the remaining shared-cache archive-swap gap with a red regression
- [x] replace shared executable/archive cache use with an invocation-private mode-0700 directory created atomically by `mktemp`
- [x] download, verify, extract, execute, and publish `GITHUB_PATH` only from that private directory
- [x] prove a poisoned shared archive/install tree is ignored and the selected Zig executable comes from authenticated private bytes
- [x] preserve pinned host/version/hash selection and workflow integration

## final quality finding 4 — typed row-source FFI selector

- [x] add test-first policy coverage requiring a Wolfpack-owned row-source ABI, named active/history selectors, no Ghostty internal numeric tag at Rust call sites, and invalid-selector rejection
- [x] add C helper/Rust FFI regression proving active maps as non-history, history maps as history, and unknown selectors including the old Ghostty-internal history tag value are rejected with `WP_ERR_INVALID`
- [x] define `WpGhosttyRowSource` in `broker/native/ghostty_vt_shim.h` with named `WP_GHOSTTY_ROW_SOURCE_ACTIVE` and `WP_GHOSTTY_ROW_SOURCE_HISTORY` values
- [x] mirror the ABI in Rust as `#[repr(C)] enum WpGhosttyRowSource` and use `WpGhosttyRowSource::Active` / `WpGhosttyRowSource::History` at row extraction call sites
- [x] translate Wolfpack row-source selectors to Ghostty point tags only inside the C shim, and reject unknown selectors before snapshot metadata/extraction work
- [x] preserve visible/history row extraction behavior and the existing symbol/link boundary
- [x] avoid other findings, broad formatting, commit, push, deploy, install, and restart

## final quality finding 3 follow-up — Ghostty C shim extraction return values

- [x] extend C-shim policy coverage red-first for wide-cell and style query paths that still silently shaped structured snapshot content
- [x] make `ghostty_cell_get(...GHOSTTY_CELL_DATA_WIDE...)` failure return `WP_ERR_GHOSTTY`; wide-cell state controls continuation cells in the wire snapshot
- [x] make `ghostty_grid_ref_style(...)` failure return `WP_ERR_GHOSTTY`; style controls foreground/background and text-attribute fields in the wire snapshot
- [x] inspect remaining Ghostty result paths used for structured snapshot fields and make render-state cursor-shape update/get failures return `WP_ERR_GHOSTTY`
- [x] document remaining void APIs in code: palette/style default initializers have no status to check, and `ghostty_terminal_vt_write` reports parser trouble through later `vt_processing_error` metadata
- [x] preserve ANSI palette, cleanup ordering, Rust typed errors, and shadow fail-open behavior
- [x] avoid row-source selector, other findings, broad formatting, commit, push, deploy, install, and restart

## final quality finding 3 — Ghostty C shim contract return values

- [x] add test-first C-shim policy coverage proving constructor media/glyph option setup and extraction palette/wrap queries are not discarded
- [x] preserve Wolfpack ANSI palette setup and its existing fatal constructor behavior
- [x] treat Kitty image storage limit, Kitty file medium, Kitty shared-memory medium, and glyph protocol option failures as constructor failures
- [x] on constructor option failure, free render state before terminal and return `NULL`
- [x] make color-palette extraction query failure return `WP_ERR_GHOSTTY`, flowing through existing Rust `TerminalStateError::GhosttyStatus` and existing shadow fail-open behavior
- [x] classify row wrap query as contract-defining because `StyledLine.wrapped` drives snapshot reflow/attach semantics; make failure return `WP_ERR_GHOSTTY`
- [x] avoid row-source selector, other findings, broad formatting, commit, push, deploy, install, and restart

## final quality finding 2 — transactional resize failure policy

- [x] add narrow no-production-fault-knob resize transaction seams for terminal/PTY resize failure paths
- [x] add regression proving terminal resize failure aborts before PTY resize, leaves session dimensions unchanged, and emits no resize/invalidation success events
- [x] add regression proving PTY resize failure after terminal success rolls terminal dimensions back, leaves session dimensions unchanged, and emits no success events
- [x] add regression proving terminal rollback failure is represented as `ResizeError::PtyWithTerminalRollback` instead of swallowed or pretending consistency
- [x] execute terminal resize before PTY/session metadata commit; commit `SessionState` and emit lifecycle invalidation only after terminal and PTY resize both succeed
- [x] preserve existing normal resize ordering at the public boundary: successful resize updates terminal/session state, then emits `SessionResized` and `SnapshotInvalidated`
- [x] preserve lock ordering by serializing resize under the PTY lock and taking session-state before terminal lock, matching snapshot's state-before-terminal order
- [x] update router resize error mapping only for the new rollback-representing error variant
- [x] avoid C shim, row selector, other findings, broad formatting, commit, push, deploy, install, and restart

## final quality finding 1 — close OutputBus on terminal feed failure

- [x] add a narrow test seam around `drain_reader`'s terminal-feed dependency without adding a production fault-injection knob
- [x] add regression proving a fallible feed returns an error, closes `OutputBus`, wakes a waiter blocked on close, and publishes no failed chunk
- [x] preserve feed/seq ordering: terminal feed succeeds before seq bump, and failed chunks neither increment seq nor enter the output bus ring/broadcast
- [x] replace the `?` early return inside the drain loop with explicit `break Err(...)` so the common `bus.close()` epilogue runs for feed failures exactly like EOF/read errors
- [x] avoid resize, C shim, row source, other findings, broad formatting, commit, push, deploy, install, and restart

## final security finding 2 — authenticate pinned Zig cache before use

- [x] add deterministic unit/policy test that seeds a fake pinned Linux x64 archive cache and a poisoned executable install without downloading the real Zig tool
- [x] prove the setup script rejects/replaces the poisoned install from authenticated archive bytes and still records archive checksum verification
- [x] authenticate the pinned archive SHA before every use, downloading only when the archive is absent or fails verification
- [x] rebuild the install tree from a temporary extraction of the authenticated archive instead of trusting executable cache hits or stale markers
- [x] avoid partial install replacement by extracting into a temp directory, checking the extracted executable against archive bytes, then atomically replacing the install directory
- [x] keep GitHub-hosted setup behavior intact: same script path, host/version slug selection, pinned download URL, `zig version`, and `GITHUB_PATH` output
- [x] avoid other findings, formatting outside touched files, commit, push, deploy, install, and restart

## final security finding 1 — bound snapshot `target_cols` at broker control boundary

- [x] add router regression proving `target_cols=4` and `target_cols=300` remain accepted for valid sessions
- [x] add router regression proving `target_cols=301` and `target_cols=65535` return `InvalidRequest`
- [x] prove invalid `target_cols` is rejected before session lookup by sending `target_cols=301` with an unknown session id and receiving `InvalidRequest`, not `UnknownSession`
- [x] keep the session usable after invalid snapshot requests
- [x] validate only `target_cols > MAX_TERMINAL_COLS` before registry lookup/materialization; zero/omitted values and normal widths keep existing behavior
- [x] avoid protocol schema changes, release authority, attribution, terminal semantics, archive provenance, compact checkpoints, commit, push, deploy, install, and restart

## correction 10 — Ghostty `vt_processing_error` safety and shadow diagnostics

- [x] preserve the current wire snapshot schema and protocol payloads; no new snapshot fields or response shapes
- [x] map Ghostty's sticky structured `vt_processing_error` metadata to typed `TerminalStateError::GhosttyVtProcessing` during authoritative snapshot/materialization
- [x] keep authoritative `SessionRouter` behavior on terminal snapshot failure as existing structured `internal_error`
- [x] keep `ghostty-vt-shadow` legacy-authoritative and fail-open for public snapshots when Ghostty reports processing failure
- [x] add dedicated bounded `vt_processing_errors` shadow diagnostic separate from FFI errors and mismatch counters
- [x] emit at most one non-content shadow warning per terminal for `vt_processing_error`, logging only operation/count metadata and no input/title/cell data
- [x] avoid warning/count inflation on repeated snapshots after the sticky Ghostty error is observed
- [x] add narrow unit seams for metadata-to-error mapping, shadow one-time counter/log decision, continued legacy-authoritative snapshot behavior, and router `InternalError` mapping
- [x] run authoritative/shadow full Cargo suites plus real broker snapshot reflow integration
- [x] avoid protocol schema changes, release authority, attribution, terminal semantics, archive provenance, compact checkpoints, commit, push, deploy, install, and restart

## correction 9 — libghostty-vt binary distribution attribution

- [x] identify the required pinned lib-vt notice set for `simd=false`: Ghostty MIT, uucode MIT, uucode-referenced Bjoern Hoehrmann UTF-8 DFA MIT-style notice, and Unicode License v3
- [x] confirm source texts against immutable Ghostty and uucode source artifacts instead of paraphrasing; record checked hashes in tests
- [x] add checked-in `THIRD_PARTY_NOTICES` with pinned Ghostty/uucode identities and exact notice text
- [x] include `THIRD_PARTY_NOTICES` in the root npm package file list
- [x] copy `THIRD_PARTY_NOTICES` beside every staged `wolfpack-broker` and into every generated platform npm package containing `wolfpack-broker`
- [x] include `dist/THIRD_PARTY_NOTICES` in release checksums, provenance attestation subjects, and GitHub release file list
- [x] add regression tests for notice identities, exact license text hashes, npm packaging, and release asset policy
- [x] avoid VT diagnostics, release authority, terminal behavior, archive provenance, compact checkpoints, commit, push, deploy, install, and restart

## correction 8 — PR Ghostty behavior CI coverage

- [x] add test-first workflow policy coverage proving the dedicated Ghostty PR job cannot silently lose pinned setup, verified Linux x64 bundle build, both feature suites, or real broker integration
- [x] add dedicated `.github/workflows/test.yml` job using pinned actions/toolchains, pinned Zig setup, verified `x86_64-unknown-linux-gnu` bundle build, complete locked authoritative/shadow Cargo suites, and real authoritative broker integration
- [x] add bounded real-Ghostty stress regressions for deterministic split UTF-8/escape chunking, malformed/truncated VT input without panic, and repeated resize/content/snapshot sequences
- [x] exercise the same stress regressions under `ghostty-vt-shadow` and assert shadow comparison path remains active without FFI errors
- [x] build an authoritative-feature broker binary and run `tests/integration/broker-snapshot-reflow.test.ts` through `WOLFPACK_BROKER_BIN`
- [x] avoid release authority, attribution, VT diagnostics, archive provenance, compact checkpoints, commit, push, deploy, install, and restart

## correction 7 — static Ghostty memset override crash

- [x] reproduce default exact resize test passing
- [x] reproduce authoritative/shadow exact resize test hang/SIGSEGV behavior with original pinned archive
- [x] inspect macOS crash report and Ghostty comments for memset override semantics
- [x] confirm hypothesis with experimental archive that removes only the lib-vt root import of `quirks_memset.zig`
- [x] add pinned-source patch preventing libghostty-vt static archives from injecting Ghostty's host `memset` override
- [x] update Ghostty lock patch set/SHA-256
- [x] add symbol-policy manifest field/tests for the host memset override
- [x] add linked Tokio multithread runtime stability regression
- [x] rebuild all four bundles/manifests and verify focused/full authoritative and shadow suites

## correction 6 — Ghostty archive provenance and deterministic patch cache

- [x] add checked-in `ghostty-vt.lock.json` as the human-reviewable source of truth for revision, source SHA-256, Zig version/build inputs, target mapping, and tracked patch path/SHA-256
- [x] make `scripts/build-ghostty-vt.ts` consume the lock instead of duplicating pin/build literals
- [x] generate per-target `manifest.json` files binding target triple, full lock content/hash, archive SHA-256, and complete staged header-tree digest
- [x] make `broker/build.rs` reject missing/stale/wrong/corrupt manifests, archive hashes, target triples, lock content, lock hashes, and header digests before compiling/linking
- [x] remove split include/lib override paths; only a verified bundle root override remains
- [x] make source prep re-extract clean verified source per lock identity before patching instead of stamping ambiguous mutated source
- [x] add provenance tests for accept-fresh and reject missing manifest, corrupted archive, corrupted header, wrong target, and stale lock/patch manifest
- [x] rebuild all four pinned Ghostty bundles and run host authoritative/shadow fixtures

## correction 5 — target-aware C shim build

- [x] replace hand-rolled ambient `cc`/`ar` invocation in `broker/build.rs` with the Rust `cc` build crate
- [x] pass Cargo `HOST`/`TARGET` into the shim build so compiler/archiver/arch flags follow the Cargo target contract, including cross/container builds
- [x] preserve link order: shim static archive first, then archive-only Ghostty search path and `static=ghostty-vt`
- [x] intentionally update `broker/Cargo.lock` only for `cc` and its transitive build dependencies
- [x] add policy tests proving `build.rs` uses `cc::Build`, `HOST`/`TARGET`, and does not manually fall back to ambient host `cc`/`ar`
- [x] freshly build all four pinned Ghostty archives with existing `/tmp/zig-0.16.0`
- [x] compile and inspect shim object/archive architecture for all four targets with explicit target-aware Zig tooling
- [x] run host authoritative/shadow fixtures

## status log

- 2026-07-27: final post-fix delivery and quality reviews reported no actionable findings. The final security re-review's remaining low shared-cache Zig archive TOCTOU was reproduced and removed by using one invocation-private mode-0700 `mktemp` directory for download, verification, extraction, execution, and `GITHUB_PATH`; focused provenance/workflow tests passed 6/6.
- 2026-07-27: final acceptance passed: TypeScript typecheck; full Bun suite (1949/1949); default locked Cargo suite; complete locked authoritative and shadow Cargo suites; release authoritative broker build; real broker snapshot/reflow integration (5/5); full distribution build; and `git diff --check`. Full browser E2E was additionally attempted but externally interrupted after its first five cases (four passed, one expected skip), so no E2E completion claim is made; this broker/build-only branch has no browser runtime source changes.

- 2026-07-27: final quality finding 4 accepted; scope limited to Rust/C row-source FFI selector contract; other findings, broad formatting, commit, push, deploy, install, and restart explicitly not addressed.
- 2026-07-27: red observed after extending `tests/unit/ghostty-shim-contract-policy.test.ts`: `bun test tests/unit/ghostty-shim-contract-policy.test.ts` failed because `WpGhosttyRowSource`/named selectors were absent and the shim still mapped `point_tag == 3 ? GHOSTTY_POINT_TAG_HISTORY : GHOSTTY_POINT_TAG_ACTIVE`.
- 2026-07-27: implemented Wolfpack-owned row-source ABI: C header defines `WpGhosttyRowSource` with active/history selectors; Rust mirrors it with `#[repr(C)] enum WpGhosttyRowSource`; Rust call sites use named active/history values instead of the Ghostty-internal history tag literal.
- 2026-07-27: implemented C-side translation in `row_source_to_point_tag`; unknown selectors return `WP_ERR_INVALID` before metadata or row extraction. Added C helper/Rust regression proving active/history mapping and invalid rejection, including the previous leaked Ghostty history-tag value.
- 2026-07-27: focused green: `bun test tests/unit/ghostty-shim-contract-policy.test.ts` passed (4/4); `cargo test --locked --manifest-path broker/Cargo.toml --features ghostty-vt --lib terminal_state::ghostty::tests:: -- --nocapture` passed (9/9); authoritative fixtures passed (7/7); shadow fixtures passed (7/7); authoritative FFI safety passed (2/2); shadow FFI safety passed (1/1); `rustfmt --edition 2021 --check broker/src/terminal_state/ghostty.rs` passed.
- 2026-07-27: final quality finding 3 follow-up accepted; scope limited to remaining ignored Ghostty C return values that populate structured snapshot fields; row-source selector, other findings, broad formatting, commit, push, deploy, install, and restart explicitly not addressed.
- 2026-07-27: red observed after extending `tests/unit/ghostty-shim-contract-policy.test.ts`: `bun test tests/unit/ghostty-shim-contract-policy.test.ts` failed because `ghostty_cell_get(...GHOSTTY_CELL_DATA_WIDE...)`, `ghostty_grid_ref_style(...)`, `ghostty_render_state_update(...)`, and `ghostty_render_state_get(...CURSOR_VISUAL_STYLE...)` still silently defaulted structured fields on failure.
- 2026-07-27: implemented propagation for wide-cell, style, and render-state cursor-shape failures as `WP_ERR_GHOSTTY`; existing Rust `status(...)` path maps that to typed `TerminalStateError::GhosttyStatus`, and shadow keeps existing fail-open behavior.
- 2026-07-27: full shim inspection found no remaining ignored Ghostty result calls used for structured snapshot fields. Remaining void APIs are documented in code: `ghostty_color_palette_default` and `ghostty_style_default` are statusless initializers, and `ghostty_terminal_vt_write` exposes parser failures via later `GHOSTTY_TERMINAL_DATA_VT_PROCESSING_ERROR` metadata.
- 2026-07-27: focused green: `bun test tests/unit/ghostty-shim-contract-policy.test.ts` passed (3/3); authoritative fixtures passed `cargo test --locked --manifest-path broker/Cargo.toml --features ghostty-vt --test terminal_fixtures -- --nocapture` (7/7); shadow fixtures passed `cargo test --locked --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --test terminal_fixtures -- --nocapture` (7/7); authoritative FFI safety passed (2/2); shadow FFI safety passed (1/1).
- 2026-07-27: final quality finding 3 accepted; scope limited to ignored Ghostty contract-defining C return values in constructor options and extraction palette/wrap path; row-source selector, other findings, broad formatting, commit, push, deploy, install, and restart explicitly not addressed.
- 2026-07-27: red observed after adding `tests/unit/ghostty-shim-contract-policy.test.ts`: `bun test tests/unit/ghostty-shim-contract-policy.test.ts` failed because constructor option setters used `(void)ghostty_terminal_set`, palette query used `(void)ghostty_terminal_get`, and row wrap query used `(void)ghostty_row_get`.
- 2026-07-27: implemented `apply_wolfpack_contract_options`; constructor now treats Kitty storage/file/shared-memory and glyph-protocol option failures as fatal, cleans up render then terminal, and returns `NULL`.
- 2026-07-27: implemented extraction hard failures for color-palette and row-wrap queries. Row wrap is contract-defining because `StyledLine.wrapped` is serialized and drives reflow/attach semantics; a failed query must not silently project an unwrapped row.
- 2026-07-27: focused green: `bun test tests/unit/ghostty-shim-contract-policy.test.ts` passed (2/2); authoritative ghostty wrapper unit tests passed (8/8); authoritative terminal fixtures passed (7/7); authoritative FFI safety passed (2/2); shadow FFI safety passed (1/1).
- 2026-07-27: broader C-shim/policy verification passed: `bun test tests/unit/ghostty-shim-contract-policy.test.ts tests/unit/broker-build-policy.test.ts tests/unit/build-ghostty-vt.test.ts` (20/20); `cargo test --locked --manifest-path broker/Cargo.toml --all --features ghostty-vt`; `cargo test --locked --manifest-path broker/Cargo.toml --all --features ghostty-vt-shadow`; `cargo test --locked --manifest-path broker/Cargo.toml`.
- 2026-07-27: final checks passed: no ignored constructor/palette/wrap patterns found by `rg`; touched-file trailing whitespace check passed; `git diff --check -- broker/native/ghostty_vt_shim.c tests/unit/ghostty-shim-contract-policy.test.ts .plans/libghostty-vt-broker-implementation-2026-07-27.md` produced no output for tracked diff (note: these paths are untracked relative to current `HEAD` in this assignment worktree).
- 2026-07-27: final quality finding 2 accepted; scope limited to `Session::resize` partial-commit failure policy; C shim, row selector, other findings, broad formatting, commit, push, deploy, install, and restart explicitly not addressed.
- 2026-07-27: red observed after adding resize transaction regressions: `cargo test --locked --manifest-path broker/Cargo.toml session::tests::resize_terminal_failure_leaves_pty_state_uncommitted_and_emits_no_success_events -- --exact --nocapture` failed to compile because `PtyResize`, `TerminalResize`, and `resize_terminal_pty_and_state` did not exist.
- 2026-07-27: implemented explicit resize transaction: terminal resize runs first while session state remains uncommitted; PTY resize runs second; `SessionState` and success events are committed only after both succeed; PTY failure attempts terminal rollback, and rollback failure is represented as `ResizeError::PtyWithTerminalRollback`.
- 2026-07-27: focused green: terminal-failure exact regression passed; rollback exact regressions passed; normal router resize event regression passed.
- 2026-07-27: broader resize verification passed: `cargo test --locked --manifest-path broker/Cargo.toml session::tests::resize_ -- --nocapture` (4/4), `cargo test --locked --manifest-path broker/Cargo.toml session_router::tests::resize_ -- --nocapture` (4/4), focused resize regressions under `ghostty-vt` and `ghostty-vt-shadow`, `cargo test --locked --manifest-path broker/Cargo.toml` (153 lib + 3 bin + 27 socket integration + 7 fixtures; feature-gated targets compiled with 0 tests as expected), and `cargo test --locked --manifest-path broker/Cargo.toml --all --features ghostty-vt` passed.
- 2026-07-27: first `cargo test --locked --manifest-path broker/Cargo.toml --all --features ghostty-vt-shadow` run failed in unrelated/flaky `stale_socket_is_removed_before_binding` with `AddrInUse`; exact rerun passed, and full `ghostty-vt-shadow` rerun passed.
- 2026-07-27: formatting/diff checks passed for touched files: `rustfmt --edition 2021 --check broker/src/session.rs broker/src/session_router.rs`; `git diff --check -- broker/src/session.rs broker/src/session_router.rs .plans/libghostty-vt-broker-implementation-2026-07-27.md`.
- 2026-07-27: final quality finding 1 accepted; scope limited to `drain_reader` terminal-feed failure bus closure; resize, C shim, row source, other findings, broad formatting, commit, push, deploy, install, and restart explicitly not addressed.
- 2026-07-27: red observed after adding feed-failure regression and narrow terminal-feed test seam: `cargo test --locked --manifest-path broker/Cargo.toml session::tests::drainer_feed_failure_closes_output_and_publishes_no_failed_chunk -- --exact --nocapture` failed because `OutputBus::wait_closed` was not woken when `try_feed` returned an error.
- 2026-07-27: replaced the terminal-feed `?` early return with explicit loop `break Err(...)`, preserving the existing feed-before-seq-before-publish ordering and routing feed failures through the common `bus.close()` epilogue.
- 2026-07-27: focused green: `cargo test --locked --manifest-path broker/Cargo.toml session::tests::drainer_feed_failure_closes_output_and_publishes_no_failed_chunk -- --exact --nocapture` passed.
- 2026-07-27: broader drainer/session verification passed: `cargo test --locked --manifest-path broker/Cargo.toml session::tests:: -- --nocapture` (15/15); feature-gated focused regression passed under `ghostty-vt` and `ghostty-vt-shadow`; `cargo test --locked --manifest-path broker/Cargo.toml` passed (150 lib + 3 bin + 27 socket integration + 7 fixtures; feature-gated targets compiled with 0 tests as expected).
- 2026-07-27: formatting check passed for touched Rust file: `rustfmt --edition 2021 --check broker/src/session.rs`.
- 2026-07-27: final security finding 2 accepted; scope limited to pinned Zig setup cache provenance; other findings, formatting outside touched files, commit, push, deploy, install, and restart explicitly not addressed.
- 2026-07-27: red observed after adding `tests/unit/setup-zig-cache-provenance.test.ts`: `bun test tests/unit/setup-zig-cache-provenance.test.ts` failed because a pre-existing poisoned executable install remained trusted and the script lacked archive-authentication helpers.
- 2026-07-27: updated `scripts/setup-zig-0.16.0.sh` to verify the pinned archive SHA before use, download only when archive verification fails/is absent, extract into a temporary directory, verify the extracted `zig` executable against authenticated archive bytes, and replace the install directory from that temp extraction before running `zig version`/writing `GITHUB_PATH`.
- 2026-07-27: focused green: `bun test tests/unit/setup-zig-cache-provenance.test.ts` passed (2/2).
- 2026-07-27: broader Zig setup/build-policy verification passed: `bun test tests/unit/setup-zig-cache-provenance.test.ts tests/unit/build-ghostty-vt.test.ts tests/unit/test-workflow-policy.test.ts` (19/19); `bash -n scripts/setup-zig-0.16.0.sh`; touched-file whitespace check. No real Zig download/install was run.
- 2026-07-27: final security finding 1 accepted; scope limited to broker-router `SnapshotParams.target_cols` ceiling validation; other review findings, reports, protocol schema, release authority, attribution, terminal semantics, archive provenance, compact checkpoints, commit, push, deploy, install, and restart explicitly not addressed.
- 2026-07-27: red observed after adding router regression: `cargo test --locked --manifest-path broker/Cargo.toml session_router::tests::snapshot_target_cols_above_terminal_ceiling_is_invalid_before_session_lookup -- --exact --nocapture` failed because `target_cols=301` returned `Ok`.
- 2026-07-27: added `validate_snapshot_target_cols`, rejecting only `target_cols > MAX_TERMINAL_COLS` before registry lookup/materialization; valid tiny probe `target_cols=4`, boundary `300`, omitted values, and normal widths keep existing behavior.
- 2026-07-27: focused green: `cargo test --locked --manifest-path broker/Cargo.toml session_router::tests::snapshot_target_cols_above_terminal_ceiling_is_invalid_before_session_lookup -- --exact --nocapture` passed.
- 2026-07-27: router regression passed: `cargo test --locked --manifest-path broker/Cargo.toml session_router::tests:: -- --nocapture` (15/15).
- 2026-07-27: feature-gated router regression passed under authoritative and shadow features: `cargo test --locked --manifest-path broker/Cargo.toml --features ghostty-vt session_router::tests::snapshot_target_cols_above_terminal_ceiling_is_invalid_before_session_lookup -- --exact --nocapture`; `cargo test --locked --manifest-path broker/Cargo.toml --features ghostty-vt-shadow session_router::tests::snapshot_target_cols_above_terminal_ceiling_is_invalid_before_session_lookup -- --exact --nocapture`.
- 2026-07-27: formatting check passed for touched router file: `rustfmt --edition 2021 --check broker/src/session_router.rs`.
- 2026-07-27: correction 10 accepted; scope limited to Ghostty `vt_processing_error` metadata safety/observability; protocol schema, release authority, attribution, terminal semantics, archive provenance, compact checkpoints, commit, push, deploy, install, and restart explicitly not addressed.
- 2026-07-27: red observed after adding correction-10 tests: `cargo test --locked --manifest-path broker/Cargo.toml --features ghostty-vt --lib terminal_state::ghostty::tests::vt_processing_metadata_maps_to_typed_error -- --exact --nocapture` failed to compile because `TerminalStateError::GhosttyVtProcessing`, `reject_vt_processing_error`, and `terminal_snapshot_error` did not exist.
- 2026-07-27: implemented typed `TerminalStateError::GhosttyVtProcessing { operation }`, checked Ghostty `vt_processing_error` metadata before authoritative materialization, and reused existing `SessionRouter` structured `InternalError` response path for terminal snapshot failures.
- 2026-07-27: implemented shadow-only bounded `vt_processing_errors` counter and one-time non-content warning decision, separate from FFI and mismatch counters; repeated snapshot errors after the sticky bit do not inflate counts or warnings, and legacy snapshots remain authoritative.
- 2026-07-27: focused diagnostics passed: `cargo test --locked --manifest-path broker/Cargo.toml --features ghostty-vt --lib terminal_state::ghostty -- --nocapture` (8/8); `cargo test --locked --manifest-path broker/Cargo.toml --features ghostty-vt --lib session_router::tests::terminal_snapshot_processing_failure_maps_to_internal_error -- --exact --nocapture` (1/1); `cargo test --locked --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --lib terminal_state::shadow -- --nocapture` (4/4); `cargo test --locked --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --test terminal_ffi_safety -- --nocapture` (1/1).
- 2026-07-27: full authoritative suite passed: `cargo test --locked --manifest-path broker/Cargo.toml --all --features ghostty-vt` (97 lib + 3 bin + 1 static-link + 27 socket integration + 2 FFI safety + 7 fixtures + 3 stress + 4 scroll-region).
- 2026-07-27: full shadow suite passed: `cargo test --locked --manifest-path broker/Cargo.toml --all --features ghostty-vt-shadow` (160 lib + 3 bin + 1 static-link + 27 socket integration + 1 FFI safety + 7 fixtures + 3 stress + 1 scroll-region + 2 shadow).
- 2026-07-27: real authoritative broker integration passed: `cargo build --release --locked --manifest-path broker/Cargo.toml --features ghostty-vt --bin wolfpack-broker`; `WOLFPACK_BROKER_BIN=$PWD/broker/target/release/wolfpack-broker bun test tests/integration/broker-snapshot-reflow.test.ts` (5/5).
- 2026-07-27: default suite also passed after correction 10: `cargo test --locked --manifest-path broker/Cargo.toml` (148 lib + 3 bin + 27 socket integration + 7 fixtures; feature-gated Ghostty targets compiled with 0 tests as expected).
- 2026-07-27: formatting check passed for touched Rust files with `rustfmt --edition 2021 --check broker/src/terminal_state.rs broker/src/terminal_state/ghostty.rs broker/src/terminal_state/shadow.rs broker/src/session_router.rs broker/tests/terminal_ffi_safety.rs broker/tests/terminal_ghostty_stress.rs`.
- 2026-07-27: correction 9 accepted; scope limited to libghostty-vt binary distribution attribution; VT diagnostics, release authority, terminal behavior, archive provenance, compact checkpoints, commit, push, deploy, install, and restart explicitly not addressed.
- 2026-07-27: attribution red observed: `bun test tests/unit/third-party-notices.test.ts tests/unit/release-workflow-policy.test.ts` failed because `THIRD_PARTY_NOTICES` was absent, root package files omitted it, build packaging did not copy it, and release assets/checksums/attestation omitted it.
- 2026-07-27: confirmed exact source notice texts from immutable artifacts: Ghostty pinned source `7aa9591746ffa4d2eee458960c76554352832595` / source SHA-256 `468a0564bdd481e291f6150b94300f9ff37c1a7524f6ae76e99c4ec15535cf66`; uucode archive `https://deps.files.ghostty.org/uucode-2826a37a4562284fdacd8fa029d49509cc9bffcd.tar.gz` / archive SHA-256 `7e76fc7fab1e7ac728c52b35bbb3e5b8c639841abfc7fe1a4bcb13050594bc9e` / Zig package hash `sha256-R5RXW5tWIaDq5JOF2+oWd5YOYOyns6WH7f687WE+b20=`.
- 2026-07-27: recorded exact checked notice hashes: Ghostty MIT `386211873e5b7a02f663ae4d7adf96285999f91608f8f9f31fecfd0f4095e6f1`; uucode MIT `312e901e142be2477b4ca859e9311f9e3f80d33372991759b7921c1893605f33`; Bjoern Hoehrmann UTF-8 DFA notice `de219cece932aad5a817bf763393d8d149d378a15d2ad5320e3331eac07626dd`; Unicode License v3 `1eda5a3b026870c737b22e8bcd4954338612c790db688242e003f41a4fa95175`.
- 2026-07-27: added checked-in `THIRD_PARTY_NOTICES` with pinned component identities and exact notice text; updated `package.json`, `scripts/build.ts`, and `.github/workflows/release.yml` so root npm package, platform npm packages, staged broker dirs, release checksums, release attestation subjects, and release uploads include the notice.
- 2026-07-27: attribution tests passed after implementation: `bun test tests/unit/third-party-notices.test.ts tests/unit/release-workflow-policy.test.ts` (8/8).
- 2026-07-27: broader packaging/policy regression passed: `bun test tests/unit/third-party-notices.test.ts tests/unit/release-workflow-policy.test.ts tests/unit/test-workflow-policy.test.ts tests/unit/build-ghostty-vt.test.ts tests/unit/broker-build-policy.test.ts` (30/30).
- 2026-07-27: local package-build verification attempted with `bun run scripts/build.ts` but blocked before packaging by pre-existing missing dependency artifact `node_modules/ghostty-web/dist/ghostty-web.umd.cjs`; no install was performed per assignment. Source-level packaging tests remain green.
- 2026-07-27: correction 8 accepted; scope limited to PR Ghostty behavior CI coverage and bounded real-Ghostty stress regressions; release authority, attribution, VT diagnostics, archive provenance, compact checkpoints, commit, push, deploy, install, and restart explicitly not addressed.
- 2026-07-27: workflow policy red observed after adding `tests/unit/test-workflow-policy.test.ts`: `bun test tests/unit/test-workflow-policy.test.ts` failed because `.github/workflows/test.yml` had no `ghostty-vt-behavior` job.
- 2026-07-27: added `.github/workflows/test.yml` job `ghostty-vt-behavior` on `ubuntu-24.04` with pinned `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`, `dtolnay/rust-toolchain@4be7066ada62dd38de10e7b70166bc74ed198c30` toolchain `1.89.0`, `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6` bun `1.3.9`, `scripts/setup-zig-0.16.0.sh`, `bun run scripts/build-ghostty-vt.ts --target x86_64-unknown-linux-gnu`, complete locked Cargo suites for `ghostty-vt` and `ghostty-vt-shadow`, authoritative broker build, and `WOLFPACK_BROKER_BIN` real integration run.
- 2026-07-27: workflow policy green: `bun test tests/unit/test-workflow-policy.test.ts` passed (4/4); combined policy run `bun test tests/unit/test-workflow-policy.test.ts tests/unit/release-workflow-policy.test.ts` passed (8/8).
- 2026-07-27: added `broker/tests/terminal_ghostty_stress.rs`, feature-gated on `ghostty-vt`, covering byte-at-a-time split UTF-8 and escape/OSC sequences versus one-shot feed, malformed/truncated VT bytes without panic, and 18 deterministic resize/content/snapshot iterations; when built with `ghostty-vt-shadow`, tests assert shadow comparison count and zero FFI errors.
- 2026-07-27: focused stress verification passed: `cargo test --locked --manifest-path broker/Cargo.toml --features ghostty-vt --test terminal_ghostty_stress -- --nocapture` (3/3) and `cargo test --locked --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --test terminal_ghostty_stress -- --nocapture` (3/3).
- 2026-07-27: PR-job local bundle step reproduced with existing Zig only: `PATH=/tmp/zig-0.16.0:$PATH bun run scripts/build-ghostty-vt.ts --target x86_64-unknown-linux-gnu` staged and verified the Linux x64 bundle.
- 2026-07-27: complete locked Cargo feature suites passed exactly in job shape: `cargo test --locked --manifest-path broker/Cargo.toml --all --features ghostty-vt` and `cargo test --locked --manifest-path broker/Cargo.toml --all --features ghostty-vt-shadow`, including the new stress target under both features.
- 2026-07-27: authoritative broker/integration verification passed: `cargo build --release --locked --manifest-path broker/Cargo.toml --features ghostty-vt --bin wolfpack-broker`; `WOLFPACK_BROKER_BIN=$PWD/broker/target/release/wolfpack-broker bun test tests/integration/broker-snapshot-reflow.test.ts` passed 5/5, exercising real broker snapshot hydration/reflow.
- 2026-07-27: formatting note: `cargo fmt --manifest-path broker/Cargo.toml -- --check` remains red due pre-existing formatting drift in `broker/src/codec.rs`, `broker/src/protocol.rs`, `broker/src/registry.rs`, `broker/src/router.rs`, and `broker/tests/socket_integration.rs`; new `broker/tests/terminal_ghostty_stress.rs` was formatted with `rustfmt` directly to avoid unrelated broad formatting edits, and `rustfmt --check broker/tests/terminal_ghostty_stress.rs` passed.
- 2026-07-27: broader unit caveat: `bun test tests/unit/` is still red locally because dependencies such as `qrcode-terminal`, `typescript`, and `playwright` are not installed in this worktree; no install was performed per assignment. Focused workflow/build policy tests passed.
- 2026-07-27: correction 7 accepted; scope limited to evidence-first debug of the suspected static `memset` host interposition crash; CI wiring, attribution, VT diagnostics, compact checkpoints, commit, push, deploy, install, and restart explicitly not addressed.
- 2026-07-27: default exact resize test passed: `cargo test --locked --manifest-path broker/Cargo.toml session_router::tests::resize_known_session_updates_dimensions_and_emits_event -- --exact --nocapture`.
- 2026-07-27: reproduced blocker with original pinned archive: authoritative and shadow exact resize tests both reached `has been running for over 60 seconds` and timed out at 180s; parent crash report showed SIGSEGV before test body completion while Tokio built/running multithread blocking-pool/hashbrown state.
- 2026-07-27: inspected Ghostty `src/quirks_memset.zig` comments: the override exists to export a `memset` symbol from artifact roots, uses weak linkage for static libraries, hidden visibility for shared libraries, and explicitly warns it must not be imported from shared code because downstream consumers would get the export injected into their binaries. `src/lib_vt.zig` force-imported it under the C library root guard.
- 2026-07-27: original archive symbol evidence: `nm -m broker/native/ghostty-vt/aarch64-apple-darwin/lib/libghostty-vt.a` showed private external `_memset` plus `_quirks_memset.memset`; Linux archives also showed `quirks_memset.memset` with weak `memset`.
- 2026-07-27: hypothesis confirmed minimally: built `/tmp/ghostty-vt-no-memset-bundle` by removing only the `src/lib_vt.zig` root import of `quirks_memset.zig`; symbol output no longer contained `quirks_memset`; authoritative and shadow exact resize tests passed 5/5 each when using `WOLFPACK_GHOSTTY_VT_DIR=/tmp/ghostty-vt-no-memset-bundle`.
- 2026-07-27: added tracked pinned-source patch `patches/ghostty-vt-no-static-host-memset.patch` removing the `quirks_memset.zig` force-import only from `src/lib_vt.zig`; updated `ghostty-vt.lock.json` patch set with SHA-256 `795e3d9e0344e9a3770550f27c533394443f21eec808333fe266a6e4835de292`.
- 2026-07-27: added `ghosttyArchiveHasHostMemsetOverride` / `assertNoHostMemsetOverride` builder policy, per-bundle `symbols.noHostMemsetOverride`, build.rs stale symbol-policy verification plus direct archive byte rejection of `quirks_memset`, parser tests for `quirks_memset`, and `broker/tests/ghostty_static_link.rs` regression that repeatedly builds a Tokio multithread runtime and uses `spawn_blocking` while linked against the Ghostty static archive.
- 2026-07-27: observed expected stale red after lock/manifest change: `cargo check --locked --manifest-path broker/Cargo.toml --features ghostty-vt --no-default-features` failed because old bundle manifest lacked `symbols`.
- 2026-07-27: rebuilt all four pinned bundles/manifests with existing Zig: `PATH=/tmp/zig-0.16.0:$PATH bun run scripts/build-ghostty-vt.ts --all`; source prep re-extracted clean source and applied both patches with `--fuzz=0`.
- 2026-07-27: final symbol evidence after patch: `nm -a` for all four rebuilt archives showed no `quirks_memset`; Darwin archives now show `U _memset` plus compiler_rt `___memset`, Linux archives show `U memset` plus compiler_rt weak `memset`.
- 2026-07-27: bundle manifest verification passed for all four targets; representative archive object inspection passed: Mach-O arm64, Mach-O x86_64, ELF x86-64, and ELF ARM aarch64.
- 2026-07-27: focused verification passed: `cargo check --locked --manifest-path broker/Cargo.toml --features ghostty-vt --no-default-features`; exact resize test passed 5/5 for `ghostty-vt` and 5/5 for `ghostty-vt-shadow`; `broker/tests/ghostty_static_link.rs` passed under both features; `bun test tests/unit/build-ghostty-vt.test.ts tests/unit/broker-build-policy.test.ts tests/unit/release-workflow-policy.test.ts` passed 22/22; final focused reruns after build.rs byte-scan addition passed (`cargo check`, `cargo test --features ghostty-vt --test ghostty_static_link ...`, and `bun test tests/unit/build-ghostty-vt.test.ts tests/unit/broker-build-policy.test.ts`).
- 2026-07-27: full native verification passed: `cargo test --locked --manifest-path broker/Cargo.toml --features ghostty-vt` and `cargo test --locked --manifest-path broker/Cargo.toml --features ghostty-vt-shadow`, including host fixtures in both modes.
- 2026-07-27: correction 6 accepted; scope limited to archive provenance and deterministic patch-cache remediation; CI behavior matrices, attribution, VT diagnostics, compact checkpoints, commit, push, deploy, install, and restart explicitly not addressed.
- 2026-07-27: observed pre-fix red condition after adding manifest verification but before regenerating bundles: `cargo check --manifest-path broker/Cargo.toml --features ghostty-vt --no-default-features` failed because `broker/native/ghostty-vt/aarch64-apple-darwin/manifest.json` was missing, proving existence-only bundles were no longer accepted.
- 2026-07-27: added checked-in `ghostty-vt.lock.json` with Ghostty revision/source URL/source SHA-256, Zig version `0.16.0`, build inputs, target mappings, and `patches/ghostty-vt-scroll-region.patch` SHA-256 `0ae589656f36d33359a335dd31c40ae6f280dbf02c7178f4e802c80cb8685f80`.
- 2026-07-27: updated `scripts/build-ghostty-vt.ts` to read the lock, verify tracked patch hashes before extraction, derive a lock-identity source cache path, re-extract clean verified source when the lock/patch set changes or the ready marker is missing, and write/verify per-target bundle manifests; `scripts/setup-zig-0.16.0.sh` now reads the Zig version from the lock instead of duplicating it.
- 2026-07-27: updated `broker/build.rs` to accept only a verified `WOLFPACK_GHOSTTY_VT_DIR` bundle root or the default target bundle; removed split include/lib overrides; build.rs now verifies manifest schema, target, lock SHA, lock content, archive SHA-256, deterministic header-tree digest, archive-only path `lib/libghostty-vt.a`, and include root before `cc::Build`/linking.
- 2026-07-27: lock/build dependency update: `cargo check --manifest-path broker/Cargo.toml --features ghostty-vt --no-default-features` pulled build-time `serde`, `serde_json`, and `sha2` support plus transitive crypto hash dependencies intentionally for build.rs provenance verification.
- 2026-07-27: provenance/policy tests passed: `bun test tests/unit/build-ghostty-vt.test.ts tests/unit/broker-build-policy.test.ts` (16 passed), covering fresh manifest acceptance and rejection of missing manifest, corrupted archive, corrupted header tree, wrong target, stale patch/lock manifest, lock-keyed clean source extraction instead of ambiguous patch stamps, split override removal, and build.rs verification policy; final broader policy rerun `bun test tests/unit/build-ghostty-vt.test.ts tests/unit/broker-build-policy.test.ts tests/unit/release-workflow-policy.test.ts` passed (20 passed).
- 2026-07-27: rebuilt all four pinned bundles with verified manifests: `PATH=/tmp/zig-0.16.0:$PATH bun run scripts/build-ghostty-vt.ts --all` staged `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, and `aarch64-unknown-linux-gnu`.
- 2026-07-27: generated bundle manifest verification passed for all four targets via `bun -e '... verifyBundleManifest(...) ...'`.
- 2026-07-27: build.rs manifest verification passed after regeneration: `cargo check --manifest-path broker/Cargo.toml --features ghostty-vt --no-default-features`.
- 2026-07-27: cross-target architecture inspection passed with existing `/tmp/zig-0.16.0`: shim objects were Mach-O arm64, Mach-O x86_64, ELF x86-64, and ELF ARM aarch64; representative Ghostty archive objects were Mach-O arm64, Mach-O x86_64, ELF x86-64, and ELF ARM aarch64 after chmodding Darwin extracted objects readable for `file`.
- 2026-07-27: host fixtures passed after provenance changes: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt --test terminal_fixtures` (7 passed) and `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --test terminal_fixtures` (7 passed).
- 2026-07-27: correction 5 accepted; scope limited to target-aware shim compilation and requested cross-target build/inspection evidence; archive provenance, CI behavior-test matrix, attribution, patch-cache robustness, compact checkpoints, commit, push, deploy, install, and restart explicitly not addressed.
- 2026-07-27: replaced `std::process::Command`-based C/ar calls in `broker/build.rs` with `cc::Build`, using Cargo-provided `HOST` and `TARGET`, while preserving shim-before-Ghostty static link order and the archive-only `lib_dir` Ghostty search path.
- 2026-07-27: intentionally updated `broker/Cargo.lock` with only `cc v1.4.0`, `find-msvc-tools v0.1.9`, and `shlex v2.0.1` via `cargo check --manifest-path broker/Cargo.toml --features ghostty-vt --no-default-features` after restoring the accidental broad lockfile refresh.
- 2026-07-27: policy tests passed: `bun test tests/unit/broker-build-policy.test.ts tests/unit/build-ghostty-vt.test.ts` (6 passed), proving `cc::Build`, Cargo `HOST`/`TARGET`, no ambient `Command::new("cc"/"ar")` fallback, and shim-before-Ghostty static link order; final focused rerun after `broker/build.rs` formatting, `bun test tests/unit/broker-build-policy.test.ts`, passed (3 passed).
- 2026-07-27: freshly rebuilt all four pinned Ghostty archives using existing Zig only: `PATH=/tmp/zig-0.16.0:$PATH bun run scripts/build-ghostty-vt.ts --all` staged `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, and `aarch64-unknown-linux-gnu`.
- 2026-07-27: target-aware shim compile/inspection passed with `/tmp/zig-0.16.0/zig cc -target ...` and `/tmp/zig-0.16.0/zig ar`: shim objects were Mach-O arm64, Mach-O x86_64, ELF x86-64, and ELF ARM aarch64 respectively.
- 2026-07-27: Ghostty archive inspection passed by extracting representative objects: `aarch64-apple-darwin` Mach-O arm64, `x86_64-apple-darwin` Mach-O x86_64, `x86_64-unknown-linux-gnu` ELF x86-64, `aarch64-unknown-linux-gnu` ELF ARM aarch64.
- 2026-07-27: Cargo/cc host full check passed and produced an arm64 shim archive: `cargo check --manifest-path broker/Cargo.toml --target aarch64-apple-darwin --features ghostty-vt --target-dir broker/target/target-aware-shim`; extracted shim object was Mach-O arm64.
- 2026-07-27: full Cargo target checks for `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, and `aarch64-unknown-linux-gnu` could not be exercised locally because `rustup target list --installed` has only `aarch64-apple-darwin` (plus unrelated bare-metal target), and cargo failed before package build with `E0463 can't find crate for core/std`; no targets were installed per instruction.
- 2026-07-27: host fixtures passed after the build.rs/lockfile change: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt --test terminal_fixtures` (7 passed) and `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --test terminal_fixtures` (7 passed).
- 2026-07-27: correction 4 verification gap accepted; scope limited to one authoritative-feature end-to-end SessionRouter regression plus requested FFI/fixture verification; no production fault-injection seams, limit weakening, unrelated changes, commit, push, deploy, install, or restart.
- 2026-07-27: added `session_router::tests::authoritative_oversized_grapheme_snapshot_router_returns_internal_error_without_panic`, which creates a broker-owned session via `create_session`, runs `/usr/bin/printf` with the existing oversized combining grapheme reproduction, waits for broker PTY drain/reap, calls the snapshot router request, asserts structured `internal_error`, and verifies the router remains usable afterward.
- 2026-07-27: gap regression passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt session_router::tests::authoritative_oversized_grapheme_snapshot_router_returns_internal_error_without_panic` (1 passed; no panic).
- 2026-07-27: requested FFI safety tests passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt --test terminal_ffi_safety` (2 passed) and `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --test terminal_ffi_safety` (1 passed).
- 2026-07-27: requested fixture checks passed: default `cargo test --manifest-path broker/Cargo.toml --test terminal_fixtures` (7 passed), authoritative `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt --test terminal_fixtures` (7 passed), and shadow `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --test terminal_fixtures` (7 passed).
- 2026-07-27: correction 4 accepted; scope limited to attacker-shaped Ghostty FFI extraction/panic remediation; cross-target compiler selection, CI matrix, attribution, compact checkpoints, deploy/install/restart, commit, and push explicitly not addressed.
- 2026-07-27: loaded `review-libghostty-vt-security.md`, `.plans/libghostty-vt-broker-evaluation-report.md`, and `broker/src/codec.rs`; extraction caps derived below `MAX_FRAME_PAYLOAD = 64 * 1024 * 1024`.
- 2026-07-27: hardened shim with `WP_GHOSTTY_MAX_CELL_TEXT_BYTES = 4096`, `WP_GHOSTTY_MAX_CELL_CODEPOINTS = 1024`, `WP_GHOSTTY_MAX_EXTRACT_TEXT_BYTES = 8 MiB`, and `WP_GHOSTTY_MAX_TITLE_BYTES = 1 MiB`; all are below the broker's 64 MiB frame ceiling and prevent native extraction from dominating the wire frame budget.
- 2026-07-27: added checked C helpers for `size_t` addition, `uint32_t` conversion, cell indexing, coordinate conversion, grapheme allocation, per-cell UTF-8 accumulation, and total extraction accumulation; C now returns `WP_ERR_LIMIT` instead of overflowing/truncating.
- 2026-07-27: changed Ghostty Rust wrapper to use typed `TerminalStateError` results for init/feed/resize/metadata/title/row extraction and to validate every C text offset/length with checked slicing before decoding.
- 2026-07-27: reshaped session/router minimally: session creation/resize/snapshot use fallible terminal methods; future authoritative Ghostty failures map to structured broker `internal_error` instead of fabricated snapshots or panics.
- 2026-07-27: shadow mode now stores Ghostty as optional, disables comparison after feed/resize failure, skips failed snapshot comparison, keeps legacy authoritative, and increments bounded FFI diagnostics (`ffi_init_errors`, `ffi_feed_errors`, `ffi_resize_errors`, `ffi_snapshot_errors`) without terminal content.
- 2026-07-27: C/Rust helper safety tests passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt --lib terminal_state::ghostty` (7 passed: C error returns, grapheme allocation bound, UTF-8 accumulation bound, cell/coordinate overflow, Rust invalid range, reflow regressions).
- 2026-07-27: shadow fail-open unit passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --lib terminal_state::shadow` (3 passed, including fail-open FFI diagnostic behavior).
- 2026-07-27: real-archive FFI integration passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt --test terminal_ffi_safety` (2 passed: large bounded combining sequence and oversized grapheme typed error without panic).
- 2026-07-27: shadow real-archive fail-open integration passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --test terminal_ffi_safety` (1 passed, oversized grapheme snapshot error skipped comparison and preserved legacy snapshot).
- 2026-07-27: existing focused feature tests still passed: authoritative scroll-region (4), shadow scroll-region (1), shadow divergence (2), authoritative fixtures (7), shadow fixtures (7), default fixtures (7).
- 2026-07-27: feature compile gates passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt --no-run` and `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --no-run`.
- 2026-07-27: build/workflow focused tests passed: `bun test tests/unit/build-ghostty-vt.test.ts tests/unit/release-workflow-policy.test.ts` (7 passed).
- 2026-07-27: default full broker suite first re-run after formatting reverted failed only `socket_integration::stale_socket_is_removed_before_binding` with an `AddrInUse` stale-socket race; focused rerun `cargo test --manifest-path broker/Cargo.toml --test socket_integration stale_socket_is_removed_before_binding` passed (1 passed).
- 2026-07-27: fresh default full broker suite passed: `cargo test --manifest-path broker/Cargo.toml` (147 lib + 3 bin + 27 socket integration + 7 fixture tests; feature-gated FFI/scroll/shadow targets compiled with 0 tests).
- 2026-07-27: correction 3 accepted; scope limited to structured Ghostty scroll-region projection; no sidecar VT parser, formatter/prose parsing, broader FFI safety, commit, push, deploy, install, or restart.
- 2026-07-27: correction 3 red authoritative test observed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt --test terminal_scroll_region` failed `ghostty_authoritative_reports_decstbm_scroll_region`, returning full-screen `ScrollRegion { top: 0, bottom: 4 }` instead of DECSTBM `ScrollRegion { top: 1, bottom: 3 }`.
- 2026-07-27: correction 3 red shadow comparison test observed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --test terminal_scroll_region` failed to compile because `ShadowMismatchCounts` had no `scroll_region` field, proving the field category was not observable.
- 2026-07-27: added `patches/ghostty-vt-scroll-region.patch` against pinned Ghostty `7aa9591746ffa4d2eee458960c76554352832595`, adding explicit `GhosttyTerminalScrollRegion { uint16_t top,bottom }` and `GHOSTTY_TERMINAL_DATA_SCROLL_REGION = 34` backed by internal `t.scrolling_region`.
- 2026-07-27: updated source preparation to apply tracked Ghostty patches with `patch -p1 --fuzz=0 -i ...`; regression `bun test tests/unit/build-ghostty-vt.test.ts` passed (3 tests).
- 2026-07-27: rebuilt real archive with `/tmp/zig-0.16.0`: `PATH=/tmp/zig-0.16.0:$PATH bun run scripts/build-ghostty-vt.ts --target aarch64-apple-darwin` applied patch, built, and staged patched archive/header; `rg "SCROLL_REGION|GhosttyTerminalScrollRegion" ...` confirmed patched staged header/source.
- 2026-07-27: consumed patched `GHOSTTY_TERMINAL_DATA_SCROLL_REGION` through existing metadata extraction; no sidecar VT parser and no formatter/prose parsing added.
- 2026-07-27: authoritative scroll-region tests passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt --test terminal_scroll_region` (4 passed: default, DECSTBM, reset, resize reset/clamp).
- 2026-07-27: shadow scroll-region integration passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --test terminal_scroll_region` (1 passed: legacy region preserved, comparison only at snapshot boundary).
- 2026-07-27: shadow category unit passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --lib terminal_state::shadow` (2 passed, including fabricated scroll-region mismatch category detection without content logging).
- 2026-07-27: authoritative fixtures passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt --test terminal_fixtures` (7 passed).
- 2026-07-27: shadow fixtures passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --test terminal_fixtures` (7 passed).
- 2026-07-27: default fixtures passed: `cargo test --manifest-path broker/Cargo.toml --test terminal_fixtures` (7 passed).
- 2026-07-27: build/workflow tests passed: `bun test tests/unit/build-ghostty-vt.test.ts tests/unit/release-workflow-policy.test.ts` (7 passed).
- 2026-07-27: default full broker suite passed: `cargo test --manifest-path broker/Cargo.toml` (147 lib + 3 bin + 27 socket integration + 7 fixture tests; feature-gated scroll/shadow tests compiled with 0 tests).
- 2026-07-27: default scroll-region test target warning check passed: `cargo test --manifest-path broker/Cargo.toml --test terminal_scroll_region` (0 feature-gated tests, no warnings observed).
- 2026-07-27: correction 2 accepted; scope limited to shadow architecture and release feature selection; scrolling-region/API safety explicitly deferred.
- 2026-07-27: correction 2 red test observed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --test terminal_shadow` failed to compile because no `shadow_mismatch_counts` accessor existed; current shadow state was embedded in the authoritative Ghostty backend.
- 2026-07-27: correction task accepted; scope limited to real pinned Ghostty build/runtime path and ANSI palette parity; shadow design explicitly deferred.
- 2026-07-27: task accepted; loaded evaluation docs and sibling EDC context because required local `edc-context/index.md` is missing.
- 2026-07-27: red check observed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt terminal_fixtures --no-run` failed because the feature did not exist.
- 2026-07-27: added Cargo feature wiring, prebuilt-archive build.rs, C shim, safe Rust wrapper, legacy default backend, and shadow-mode digest counter.
- 2026-07-27: compact VT checkpoint not attempted; exact formatter roundtrip remains unproven for this implementation, and no formatted VT parsing was added.
- 2026-07-27: default broker focused fixture test passed: `cargo test --manifest-path broker/Cargo.toml --test terminal_fixtures` (7 passed).
- 2026-07-27: default full broker suite passed: `cargo test --manifest-path broker/Cargo.toml` (147 lib + 3 bin + 27 integration + 7 fixture tests passed).
- 2026-07-27: Ghostty feature compile path checked with real pinned headers and fake archive to avoid local Zig/link install: `cargo check --manifest-path broker/Cargo.toml --features ghostty-vt-shadow` passed.
- 2026-07-27: prebuild script verified source download and sha256, then stopped at missing local `zig`; CI has `scripts/setup-zig-0.16.0.sh` to fetch sha-pinned Zig before running it.
- 2026-07-27: TypeScript typecheck attempted with `bunx tsc --noEmit -p .` and failed before project checking because `bun-types` is not installed locally; no local install was performed.
- 2026-07-27: correction red build reproduced with `/tmp/zig-0.16.0`: `PATH=/tmp/zig-0.16.0:$PATH bun run scripts/build-ghostty-vt.ts --target aarch64-apple-darwin` failed at `xcframework ghostty-vt` / `xcodebuild -create-xcframework`.
- 2026-07-27: added build-argument regression test for `-Demit-xcframework=false`; `bun test tests/unit/build-ghostty-vt.test.ts` passed (2 tests).
- 2026-07-27: green real pinned archive build with `/tmp/zig-0.16.0`: `PATH=/tmp/zig-0.16.0:$PATH bun run scripts/build-ghostty-vt.ts --target aarch64-apple-darwin` passed and staged `broker/native/ghostty-vt/aarch64-apple-darwin/lib/libghostty-vt.a` (8.0M); inspected staged tree and found no dylib/xcframework files.
- 2026-07-27: correction red runtime reproduced after build: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt --test terminal_fixtures` failed only `ansi_color_tracks_sgr_attrs_per_cell` with Ghostty red `Some(13395558)` vs Wolfpack contract `Some(8388608)`.
- 2026-07-27: restored Wolfpack ANSI 0-15 palette as Ghostty terminal default palette while retaining Ghostty-generated extended palette entries.
- 2026-07-27: green real Ghostty fixture suite: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt --test terminal_fixtures` passed (7 tests), including `ansi_color_tracks_sgr_attrs_per_cell` unchanged.
- 2026-07-27: default legacy fixture suite still passed: `cargo test --manifest-path broker/Cargo.toml --test terminal_fixtures` passed (7 tests).
- 2026-07-27: broader `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt` was attempted after focused green and timed out at 300s while `session_router::tests::resize_known_session_updates_dimensions_and_emits_event` was still running; correction scope requires the fixture suite, not shadow/full-suite debugging.
- 2026-07-27: moved shadow behavior into `broker/src/terminal_state/shadow.rs`; `ghostty-vt-shadow` now delegates public accessors/snapshots to legacy, feeds/resizes a separate Ghostty model, compares only in `snapshot_with_reflow`, and emits bounded mismatch categories/counts without terminal content.
- 2026-07-27: release CI broker builds changed from `--features ghostty-vt` to `--features ghostty-vt-shadow`.
- 2026-07-27: initial workflow regression check failed: `bun test tests/unit/build-ghostty-vt.test.ts tests/unit/release-workflow-policy.test.ts` expected two Bun setup steps but workflow now has four after Ghostty prebuild setup; updated policy coverage to assert four pinned Bun setups and shadow-mode broker builds.
- 2026-07-27: focused shadow divergence tests passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --test terminal_shadow` (2 passed), proving legacy-authoritative `lqk` output for DEC special graphics and mismatch counts firing only after snapshot.
- 2026-07-27: shadow fixture suite passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --test terminal_fixtures` (7 passed).
- 2026-07-27: shadow comparison unit passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt-shadow --lib terminal_state::shadow` (1 passed).
- 2026-07-27: authoritative Ghostty fixture suite still passed: `cargo test --manifest-path broker/Cargo.toml --features ghostty-vt --test terminal_fixtures` (7 passed).
- 2026-07-27: build/workflow focused tests passed: `bun test tests/unit/build-ghostty-vt.test.ts tests/unit/release-workflow-policy.test.ts` (6 passed).
- 2026-07-27: default focused fixture suite passed: `cargo test --manifest-path broker/Cargo.toml --test terminal_fixtures` (7 passed).
- 2026-07-27: default full broker suite passed: `cargo test --manifest-path broker/Cargo.toml` (147 lib + 3 bin + 27 socket integration + 7 fixture tests passed; shadow integration test compiled with 0 tests under default features).
