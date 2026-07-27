# libghostty-vt evidence and authoritative replacement

status: authoritative replacement implemented and locally verified on `feat/libghostty-vt-authoritative`; uncommitted, unpushed, undeployed; non-host final links remain CI-only
date: 2026-07-27
references:
- `.plans/libghostty-vt-broker-evaluation-report.md`
- `.plans/libghostty-vt-broker-implementation-2026-07-27.md`
- `ghostty-vt.lock.json`
- `review-libghostty-vt-final-delivery.md`
- `review-libghostty-vt-final-security.md`
- `review-libghostty-vt-final-quality.md`

assumptions:
- evidence is collected before creating the final branch
- the final branch starts from latest `origin/main`, not `dev_03` or the feature branch
- “using Ghostty” means `libghostty-vt` is unconditional and authoritative; there is no legacy runtime path or shadow feature
- existing Rust ownership, broker protocol, structured snapshot schema, replay ordering, and browser renderer remain unchanged
- compact VT checkpoints remain deferred
- no deployment occurs without separate approval

acceptance thresholds:
- correctness: every observed legacy/Ghostty divergence is reproduced and adjudicated against an explicit expected terminal state; no unexplained mismatch and no case where legacy is correct while Ghostty is wrong
- safety: zero panic, abort, hang, or partial session-state commit across malformed input, randomized chunking, extraction limits, and resize stress
- feed performance: Ghostty median throughput is at least 2x legacy on the fixed corpus
- memory: Ghostty retained-state RSS per session is at most 50% of legacy at approximately 500 and 5,000 retained lines
- snapshot performance: Ghostty structured-snapshot p95 is no worse than 20% above legacy; attach/reflow p95 is no worse than 10% above legacy
- integration: authoritative Cargo, real-broker snapshot/reflow, full Bun, typecheck, browser E2E, static-link, attribution, and distribution gates pass
- cutover rule: if any threshold fails, stop before branch creation and report the evidence; do not rationalize the failure

## ~~1. Build a reproducible differential evidence harness~~

- use the real production legacy and Ghostty implementations; do not duplicate emulator behavior in a test helper
- replay identical fixture bytes, chunk boundaries, resize sequences, snapshot widths, and terminal dimensions
- cover existing binary TUI fixtures plus ANSI/edit operations, alternate screen, DEC graphics, tab stops, cursor shape, scroll regions, wide/combining text, malformed streams, and long scrollback
- emit machine-readable results containing timings, RSS, state-category counts, and content hashes; never include captured terminal content in logs
- fix seeds, iteration counts, toolchain versions, host metadata, and commands so another machine can reproduce the run

implementation log:
- red: `bun test tests/unit/terminal-evidence.test.ts` failed because the evidence evaluator module did not exist
- green: evaluator acceptance/rejection coverage passes 5/5 and project TypeScript checking passes
- red: `cargo run --manifest-path broker/Cargo.toml --example terminal-evidence -- --profile quick` failed because the real-backend evidence target did not exist
- green: quick legacy and authoritative Ghostty evidence executables emit schema-valid artifacts from the production `TerminalState`; the end-to-end quick runner correctly rejects non-full evidence
- harness files: `broker/examples/terminal-evidence.rs`, `scripts/terminal-evidence.ts`, and `tests/unit/terminal-evidence.test.ts`

## ~~2. Collect and adjudicate evidence~~

- run cold/warm feed, retained-memory, structured snapshot, reflow, and attach benchmarks for both implementations under identical release-build conditions
- run deterministic randomized chunk/resize stress and all existing correctness fixtures against both implementations
- inspect every mismatch against an explicit expected state; classify Ghostty win, parity, legacy win, or unresolved rather than assuming a difference is an improvement
- write the raw machine-readable artifact and a concise markdown report beside the existing evaluation report
- stop and request a decision if any acceptance threshold fails or any mismatch remains unresolved

evidence verdict:
- correctness: five exact-parity scenarios; three adjudicated Ghostty wins (DEC graphics, cursor shape, custom tab stops); zero legacy wins; zero unresolved scenarios
- safety: both backends completed 10,000 deterministic stress iterations with zero failures
- feed: Ghostty 107.118 MiB/s vs legacy 10.435 MiB/s (`10.265x`), passing `>=2x`
- retained RSS/session: Ghostty ratios `0.136x` at ~500 lines and `0.024x` at ~5,000 lines, passing `<=0.5x`
- the first full run rejected structured snapshot p95 at `1.306x` and attach/reflow p95 at `1.148x`
- profiling isolated the regression to Ghostty extraction: rows were traversed twice and each pass recomputed full snapshot metadata
- test-first optimization changed ordinary extraction to one optimistic bounded pass with geometric retry for dense combining text, and replaced redundant full metadata extraction with a direct checked column query
- accepted rerun: Ghostty 120.748 MiB/s vs legacy 10.900 MiB/s (`11.078x`)
- accepted rerun: retained RSS/session ratios `0.136x` at ~500 lines and `0.024x` at ~5,000 lines
- accepted rerun: structured snapshot p95 11.038 ms vs 9.748 ms (`1.132x`)
- accepted rerun: attach/reflow p95 15.428 ms vs 14.542 ms (`1.061x`)
- accepted rerun: five exact-parity scenarios, three Ghostty wins, zero legacy wins/unresolved, and 10,000 stress iterations per backend with zero failures
- raw sample distributions and accepted report: `.plans/libghostty-vt-evidence-{legacy,ghostty,evaluation}.json` and `.plans/libghostty-vt-cutover-evidence.md`

## ~~3. Create the clean authoritative branch~~

- after evidence acceptance, run `git fetch origin main:main && git checkout -b feat/libghostty-vt-authoritative main`
- port only the validated pinned source/build provenance, patches, safe C/Rust boundary, transactional error handling, attribution, CI, and behavior tests from `origin/feat/libghostty-vt-broker`
- make Ghostty the unconditional `TerminalState` implementation and preserve the current structured snapshot and broker wire contracts
- remove the shadow wrapper, legacy emulator, authority feature switches, shadow diagnostics, and dependencies proven to be legacy-only
- inventory any newly unreachable files, tests, dependencies, or workflow branches and remove only those explicitly attributable to the deleted legacy/shadow paths

implementation result:
- branch created from `main`/`origin/main` `88ec617d005abd48088c3512d3f432cc10ebdac5`
- Ghostty is unconditional; Cargo feature selectors and legacy `vte`/Unicode dependencies are removed
- legacy/shadow modules, diagnostics, tests, workflow branches, and shadow-only metadata getters are removed
- broker protocol, browser renderer, PTY/session/replay ownership, and snapshot schema remain unchanged
- no commit, push, or deployment performed

## 4. Verify and review the replacement

- run test-first focused removal checks proving no legacy/shadow selectors, modules, dependencies, release flags, or fallback paths remain
- run locked Cargo, native FFI/static-link/stress, real broker integration, typecheck, full Bun, full browser E2E, distribution, notices, and cross-target CI gates
- run differential delivery, security, and quality reviews against latest `main`; resolve findings one at a time
- publish exact commands, counts, benchmark distributions, generated-artifact hashes, remaining risks, and rollback artifact identity
- push or deploy only after separate explicit approval

local verification result:
- authenticated clean-source Ghostty rebuild passed for `aarch64-apple-darwin`; the builder no longer trusts an extracted cache ready marker
- locked Cargo suite: 150 passed, 0 failed
- full Bun suite: 1,450 passed, 0 failed
- TypeScript root/public typecheck: passed
- release broker build: passed
- exact release-broker snapshot/reflow integration: 5 passed, 0 failed, 223 assertions
- browser E2E: 120 passed, 141 intentional skips
- local distribution build: four CLI/package layouts produced; broker/package/release notice copies matched `THIRD_PARTY_NOTICES`; regenerated browser assets had no diff
- touched Rust formatting and repository diff checks: passed
- production grep: no legacy/shadow feature, type, module, or dependency references
- differential delivery, security, and quality reviews: no open findings; reports are `.plans/review-libghostty-vt-authoritative-{delivery,security,quality}.md`
- review fixes: removed dead shadow-only metadata getter APIs; replaced trust of cached extracted Ghostty source with fresh extraction from the authenticated archive per invocation

remaining gate:
- final `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, and `aarch64-unknown-linux-gnu` links require their release CI runners and have not been executed locally
- branch remains uncommitted and unpushed; CI, publish, and deployment have not run
