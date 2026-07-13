# edc review findings remediation

## status
- branch: `fix/edc-review-findings`
- base: `main` at `115232df40809d7fbfc2f38c9441b1680b6165c7`
- worktree: `/private/tmp/wolfpack-edc-findings`
- current item: complete
- rule: one finding at a time; regression test first; focused + full verification; continuous execution authorized by user

## authoritative reports
- `review-HEAD.md` from the 2026-07-12 full security run (untracked in the source worktree)
- `delivery-review-current.md` from that run (untracked in the source worktree)
- `edc-context/reports/issues.md`
- `edc-context/reports/complexity.md`

## track a — main branch correctness and security

### immediate security / high-impact correctness
- [x] 1. bound broker-socket input backpressure and propagate overload to websocket callers; add binary-input flood coverage
- [x] 2. refuse broker startup when the canonical socket belongs to a live broker
- [x] 3. unwind failed shared subscriptions for every waiting viewer and clear client subscription state
- [x] 4. propagate `send` / `sendKey` transport failures and typed unsupported-key failures
- [x] 5. preserve local session truth when kill RPCs fail; clean up only for success/idempotent absence
- [x] 6. make curl installation stage and verify both `wolfpack` and `wolfpack-broker`
- [x] 7. validate Ralph plans before lock/Git/process side effects
- [x] 8. preserve configured JWT authentication across launchd/systemd service installation without exposing secrets
- [x] 9. pin release Actions/toolchains, narrow token permissions, and isolate publication credentials

### medium correctness / reliability
- [x] 10. represent PTY read failure explicitly instead of leaving a falsely alive session
- [x] 11. reject zero/out-of-contract terminal dimensions at the broker boundary
- [x] 12. guarantee child kill+wait for every post-spawn setup failure
- [x] 13. retain push-unsubscribe retry authority when server cleanup fails
- [x] 14. reject non-number, fractional, and boolean config ports
- [x] 15. reuse the shared CLI JWT/base-url implementation in session control
- [x] 16. derive Ralph total/completed progress from one bounded task-key model
- [x] 17. parse HTTP JSON as `unknown` and validate route bodies before field access/side effects
- [x] 18. distinguish missing persistence from corrupt/unreadable persistence and prevent destructive overwrite
- [x] 19. add bounded push-delivery deadlines and timeout classification

## track b — pr #177 only

These do not exist on `main`; fix on `fix/162-ralph-configured-agents`, not this branch.

- [x] b1. restore correct HTML-attribute escaping for project options and add hostile-project browser coverage
- [x] b2. decide the product contract for synthesized built-in agents: require persisted configuration, or expose/label default provenance; then add missing/empty-settings route and browser coverage

## quality findings after behavioral issues

These are candidates, not automatic fixes. Validate current reachability/value before editing; avoid cosmetic churn.

- [ ] q1. remove verified dead production surfaces: obsolete Ralph XML control, dead websocket quiescence helper, unused exports/helpers
- [ ] q2. consolidate duplicated production contracts: broker snapshots, browser grid transitions, Ralph task model, CLI JWT logic, broker framing/probe rules
- [ ] q3. replace the copied Ralph integration route with tests against the real server and injectable external seams
- [ ] q4. consolidate broker test lifecycle helpers and re-enable deterministic terminal/reconnect e2e coverage
- [ ] q5. split mixed-concern blobs only where required by fixes above; no standalone file-size refactor

## explicitly no-action review sections
- broker-rust security report: no finding
- Ralph authorization change: no security finding
- server API portion of that change: no security finding
- changed tests: no security finding
- contextless accounting/promotion checks: no action
- generic LOC ratios, deep-call-chain scan, and unproven Fowler smells: informational only

## verification ledger

### item 1 — broker input backpressure denial of service
- history: unchecked `socket.write()` introduced by `bbe1069`; `9132d19` added synchronous-error propagation but no backpressure handling.
- red: `bun test tests/unit/broker-client.test.ts tests/unit/broker-ws-attach.test.ts` — 2 expected failures: no backpressure rejection; 61/61 binary frames accepted.
- focused green: `bun test tests/unit/broker-client.test.ts tests/unit/broker-backend.test.ts tests/unit/broker-ws-attach.test.ts tests/unit/rate-limiter.test.ts` — 120 passed, 0 failed.
- typecheck: `bun run typecheck` — passed after `bun install --frozen-lockfile` installed the isolated worktree dependencies.
- full green: `bun test` — 1,632 passed, 20 skipped, 0 failed. skips require a built broker binary and are pre-existing harness behavior.
- hygiene: `git diff --check` — passed.

### item 2 — live broker socket replacement
- history: unconditional socket-path removal originated in `b24de0a`; no prior ownership probe or reverted fix exists.
- red: three focused socket tests — live socket replacement failed as expected; non-socket preservation failed as expected; stale-socket recovery already passed.
- focused green: all three ownership tests passed after adding the socket-type and liveness probe.
- Rust full green: `cargo test --manifest-path broker/Cargo.toml` — 170 passed, 0 failed.
- TypeScript full green: `bun test` — 1,644 passed, 0 failed, including real-broker integration after Cargo built the binary.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.
- formatting limitation: crate-wide `cargo fmt --check` remains red on extensive pre-existing formatting drift in untouched Rust files. Newly added expressions were manually aligned with rustfmt output; broad formatting was intentionally not applied.

### item 3 — failed shared subscription cleanup
- history: `6084608` added failure notification only for the first viewer; `d68e343` retained the count-only state model. No all-waiter cleanup was reverted.
- red: `bun test tests/unit/broker-client.test.ts tests/unit/broker-backend.test.ts` — 4 expected failures: broker error response resolved, transport/offline failures leaked reconnect state, and the second waiting viewer received no failure.
- implementation: broker error envelopes now reject with a typed error; failed/offline subscriptions clear reconnect state; backend state stores each registration rather than only a count and unwinds every registration on shared-RPC failure.
- focused green: broker client/backend/websocket/session-control tests — 123 passed, 0 failed.
- TypeScript full green: `bun test` — 1,646 passed, 0 failed, including real-broker integration.
- Rust full green: `cargo test --manifest-path broker/Cargo.toml` — 170 passed, 0 failed.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 4 — terminal send failure propagation
- history: swallowed `send` / `sendKey` write failures and unknown-key no-op behavior originated in `bbe1069`; no prior propagation fix exists.
- red: broker backend unit suite — 3 expected failures: `send` and `sendKey` resolved after transport failure, and unknown named keys returned success.
- implementation: `send` / `sendKey` now preserve broker transport exceptions; unsupported named keys reject with `UnsupportedTerminalKeyError` and stable `UNSUPPORTED_TERMINAL_KEY` code.
- focused green: broker backend/router, session-control API, and CLI parsing tests — 180 passed, 0 failed.
- TypeScript full green: `bun test` — 1,648 passed, 0 failed, including real-broker integration.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 5 — failed kill state preservation
- history: unconditional local cleanup after kill failures originated in `bbe1069`; `128606d` later added identity deletion to that path. No prior fix exists.
- red: broker backend unit suite — 2 expected failures: broker error responses and transport failures both resolved and deleted session truth.
- implementation: only successful and idempotent-absence kill responses reach cleanup; all other broker/transport failures reject before mutating local indexes, triage cache, or identity persistence.
- focused green: broker backend/router and API tests — 175 passed, 0 failed.
- TypeScript full green: `bun test` — 1,650 passed, 0 failed, including real-broker integration.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 6 — two-binary curl installation
- history: single-binary installer behavior originated in `07babc1`; broker release assets were added later without updating `install.sh`. No prior installer fix exists.
- red: new real-shell installer suite — 3 expected failures: broker URL/destination missing, failed broker download replaced the server binary, and empty broker artifacts were not rejected.
- implementation: derive matching release targets, download both assets into an install-local staging directory, reject empty artifacts, chmod/sign both before replacement, and clean staging through an exit trap.
- focused green: installer, local deploy, service lifecycle, and service rendering tests — 23 passed, 0 failed; `bash -n install.sh` passed.
- TypeScript full green: `bun test` — 1,653 passed, 0 failed, including real-broker integration.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 7 — Ralph start validation ordering
- history: Git branch mutation before plan existence validation originated with the Ralph start route in `3260eac`; later lock cleanup mitigated residue but did not remove the side effect. No prior ordering fix exists.
- red: production-route integration — a missing plan removed a pre-existing stale lock, created the requested branch, and left the repository checked out on that branch.
- implementation: validate plan name/existence, phase/worktree flags, and branch names before stale-lock pruning, lock acquisition, Git calls, or worker spawn.
- focused green: production API, Ralph API, worktree, and shutdown suites — 189 passed, 0 failed.
- TypeScript full green: `bun test` — 1,654 passed, 0 failed, including real-broker integration.
- Rust full green: `cargo test` — 170 passed, 0 failed.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 8 — private service JWT credentials
- history: launchd/systemd environment generation originated in `3260eac` and remained unchanged when `94cc791` made invalid configured secrets fatal. No prior service credential propagation existed.
- red: launchd/systemd regressions showed no credential reference; the service credential behavior suite was absent. A second red regression caught configured-but-missing credentials restarting unauthenticated.
- implementation: service install atomically persists effective JWT secret/issuer/audience/tolerance in a validated mode-0600 JSON credential, preserves it across reinstalls without shell credentials, references only its path from launchd/systemd, loads it before server import, and fails closed on missing/corrupt/unsafe credentials. Uninstall removes the credential.
- focused green: service auth/startup/lifecycle, config, CLI auth, and launchd/systemd suites — 62 passed, 0 failed.
- TypeScript full green: `bun test` — 1,661 passed, 0 failed, including real-broker integration.
- Rust full green: `cargo test` — 170 passed, 0 failed.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 9 — release workflow least privilege and provenance
- history: mutable action references and global `contents: write` originated in `07babc1`; broker action references were added in `bd218f9`; npm publication joined the same privileged job in `0dadb42`. No prior hardening was reverted.
- red: structured YAML policy suite — mutable actions/toolchains, global write authority, combined release/npm credentials, and absent attestations each failed.
- implementation: pin every action to a verified commit SHA, pin Rust 1.89.0/Bun 1.3.9/Node 22.17.0 and fixed runner images, default to `contents: read`, separate build/GitHub-release/npm jobs, scope `contents: write` to release only, expose `NPM_TOKEN` only to the publish step, enable npm provenance, and attest every installer-consumed release asset.
- focused green: release workflow policy — 3 passed, 0 failed, 47 assertions.
- workflow validation: `actionlint` v1.7.7 — passed; pinned action inputs and tag commits were checked against upstream action metadata/refs.
- TypeScript full green: `bun test` — 1,664 passed, 0 failed, including real-broker integration.
- Rust full green: `cargo test` — 170 passed, 0 failed.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 10 — explicit PTY read failure lifecycle
- history: the initial broker drainer in `b24de0a` collapsed every read error into EOF; no previous error-state or child-cleanup fix existed.
- red: focused Rust regressions failed to compile because the drainer returned no error and session state had no read-failure transition.
- implementation: propagate PTY read errors after closing output, record a typed `PtyRead` failure, atomically mark the session unavailable, notify waiters, emit exactly one exit event, terminate the child, and let the reaper record its eventual exit code without duplicating the event.
- focused green: read-failure and existing reaper lifecycle tests — 3 passed, 0 failed.
- Rust full green: `cargo test` — 172 passed, 0 failed.
- TypeScript full green: `bun test` — 1,664 passed, 0 failed, including real-broker integration.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 11 — broker terminal dimension contract
- history: unvalidated dimensions originated in the first session router implementation in `b24de0a`; terminal-state clamping later masked rather than fixed contradictory PTY/session state.
- red: create and resize route tests accepted `0x24` and mutated/spawned instead of returning `invalid_request`.
- implementation: enforce the existing server contract (`20..=300` columns, `5..=100` rows) before create/resize lookup or side effects; reject rather than clamp at the broker trust boundary.
- focused green: create/resize invalid, minimum, maximum, and existing resize-event tests — 3 passed, 0 failed.
- Rust full green: `cargo test` — 174 passed, 0 failed.
- TypeScript full green: `bun test` — 1,664 passed, 0 failed, including real-broker integration.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 12 — post-spawn child ownership rollback
- history: partial kill-only cleanup was introduced with broker session spawn in `b24de0a`; no previous guard or full failure-point coverage existed.
- red: the requested four-point regression failed to compile because setup injection and cleanup/reap observation did not exist.
- implementation: wrap every spawned child in one ownership guard that always kills and waits on rollback, then transfer the guard into the successfully spawned reaper thread. Reader clone, writer acquisition, reader-thread spawn, and reaper-thread spawn now share that path.
- focused green: all four injected post-spawn failures killed and fully reaped their observed child PID — 1 table test passed.
- Rust full green: `cargo test` — 174 passed, 0 failed.
- TypeScript full green: `bun test --max-concurrency 8` — 1,664 passed, 0 failed. Two unconstrained runs hit different pre-existing timing-sensitive test timeouts; both passed alone before the bounded full run.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 13 — push unsubscribe retry authority
- history: server-first unsubscribe was introduced in `6477fc9` without checking `Response.ok`; later permission-sync work retried only indirectly and still deleted the browser handle after server failure.
- red: production-transaction tests showed a 503 response still invoked local `unsubscribe()` and no pending retry was observable.
- implementation: a typed production transaction now requires successful server cleanup before local removal, preserves the browser subscription on all failures, records pending/in-flight state, and retries pending cleanup on notification permission sync. Browser assets were regenerated.
- focused green: retry transaction and push persistence suites — 32 passed, 0 failed.
- TypeScript full green: `bun test --max-concurrency 8` — 1,666 passed, 0 failed.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 14 — strict config port parsing
- history: coercive `Math.floor(Number(...))` parsing originated in `44388ea`; no strict parser was reverted.
- red: config and shared validation regressions accepted numeric strings and fractional ports.
- implementation: require an actual integer number in range `1..=65535`; port inspection/cleanup helpers no longer coerce or floor runtime input either.
- focused green: config parsing, shared validation, port-management, and config behavior — 73 passed, 0 failed.
- TypeScript full green: `bun test --max-concurrency 8` — 1,666 passed, 0 failed.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 15 — shared CLI HTTP/JWT authority
- history: session-control duplicated base URL and JWT signing when introduced in `6192c78`; no prior consolidation existed.
- red: a fresh-process behavior regression showed short configured secrets returned auth failure without the shared `>=32 required` warning.
- implementation: session-control delegates URL construction, headers, and signing to `src/cli/api.ts`; its local wrapper now only adapts transport/non-2xx responses to stable session exit codes.
- focused green: session-control, CLI attach unit/integration — 21 passed, 0 failed.
- TypeScript full green: `bun test --max-concurrency 8` — 1,667 passed, 0 failed.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 16 — bounded Ralph task-key progress
- history: worker task-key progress was added in `7d5e47e`, but server status retained independent section-priority totals plus raw `DONE:` counts; tests explicitly blessed impossible `4/2` and `3/2` displays.
- red: reversed lifecycle regressions observed totals of 2 for three actionable child tasks; a legacy checked-checkbox task also disappeared from the key model.
- implementation: server status now uses `countRalphProgressFromContent`, the same key model as the worker. Keys include checked/unchecked legacy checkboxes, exclude non-actionable parent sections, deduplicate, and ignore stale progress entries.
- focused green: Ralph lifecycle, plan model, workdir boundary, production-route Ralph API, and API suites — 313 passed, 0 failed.
- TypeScript full green: `bun test --max-concurrency 8` with Git signing disabled for temp fixtures — 1,668 passed, 0 failed. The first run’s sole failure was the user 1Password Git signer failing during temporary-repo setup; the isolated test and rerun passed.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 17 — runtime HTTP body validation
- history: generic `parseBody<T = any>` originated with the HTTP helper and remained an unchecked cast; route-level `.trim()` calls later turned valid JSON with wrong shapes into 500s.
- red: numeric `newProject` and `addCmd` produced 500 responses; `/api/settings` accepted a top-level array with 200.
- implementation: JSON parsing now returns `unknown`; all 12 JSON-body routes require an object and narrow every consumed field before access or side effects. Settings and create use typed runtime guards; nested subscriptions/settings and Ralph launch flags fail closed.
- focused green: production API, Ralph API, and control-schema contract — 180 passed, 0 failed.
- TypeScript full green: `bun test --max-concurrency 8` with Git signing disabled for temp fixtures — 1,671 passed, 0 failed.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 18 — fail-closed JSON persistence reads
- history: identity persistence (`128606d`) and push persistence (`6477fc9`) treated every read/parse/shape failure as an empty store; no explicit recovery implementation existed.
- red: malformed identity and push files were silently replaced by subsequent capture/subscription writes.
- implementation: shared validated JSON reads treat only `ENOENT` as empty and throw typed `PersistenceReadError` for malformed, invalid-shape, or unreadable files before writes. Explicit test `devDir` paths now outrank mutable global test env paths to prevent cross-suite contamination.
- focused green: persistence, identity, push, broker-backend unit/integration/restart/reflow suites — 132 passed, 0 failed.
- TypeScript full green: `bun test --max-concurrency 8` with Git signing disabled for temp fixtures — 1,677 passed, 0 failed.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.

### item 19 — bounded push delivery
- history: a 10-second abort signal existed on unmerged commit `81ada30` but never reached main; current main retained unbounded endpoint fetches.
- red: the production deadline helper and bound did not exist, so a never-resolving fetch could not be terminated or classified.
- implementation: every push endpoint fetch races a 10-second deadline, receives an abort signal, and rejects with typed code `PUSH_DELIVERY_TIMEOUT`; `sendPush` classifies it as a failed timed-out delivery. The deadline race does not rely on fetch cooperating with abort.
- focused green: never-resolving deadline and `/api/notify` — 5 passed, 0 failed.
- TypeScript full green: `bun test --max-concurrency 8` with Git signing disabled for temp fixtures — 1,679 passed, 0 failed.
- typecheck: `bun run typecheck` — passed.
- hygiene: `git diff --check` — passed.
