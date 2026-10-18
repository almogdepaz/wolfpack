# pty blocked-write implementation report

status: implementation complete; draft pr open; linux Rust ci and independent review pending.

- worktree: `/Users/home/Dev/.worktrees/wolfpack/pty-blocked-write`
- base: `f863a5c141904af0b3b2fb058fc0a2f328b61dce` (initially clean)
- test commit: `aec2f2f1e4926c31bbb39fb65262bfbdd6b11679`
- production commit: `2a62f924542fd3f8f9199f62ad783416c2641151`
- draft pr: https://github.com/almogdepaz/wolfpack/pull/455
- no merge, deployment, dependency/toolchain installation, or unrelated changes.

## changes

`broker/src/session.rs` makes the master description permanently `O_NONBLOCK`. synchronous client input and blocking reply flushes poll capacity in 250ms increments, retry transient errors, and fail on poll hangup/error or an atomic child-exit flag. the reaper sets that flag immediately after `wait`, before the existing output barrier. partial client writes retain debug counts; reply failures retain warnings with counts.

the drainer polls on `WouldBlock`, drains available bytes before EOF, handles interrupted reads, and preserves output closure/final-watermark ordering. obsolete `NonBlockingReply` and `PtyWriter` flag-changing wrappers were removed; portable-pty's final EOF write is now inherently nonblocking.

regressions exercise real raw-mode PTYs after child death (with and without a descendant), real nonblocking socket backpressure/resumption, and child-exit cancellation with an open peer. existing query/drainer and socket integration tests are unchanged. `.github/workflows/test.yml` bounds the `test` job to 45 minutes.

## verification

all commands ran from the worktree above unless noted. complete logs are private under `/tmp/pty-blocked-write-checks-0287cf28/`. Cargo used the existing verified bundle via `WOLFPACK_GHOSTTY_VT_DIR=/Users/home/Dev/wolfpack/broker/native/ghostty-vt/aarch64-apple-darwin`; build.rs verified it against the worktree lock.

| command / scope | actual result | artifact |
| --- | --- | --- |
| pre-fix `cargo test --locked --manifest-path broker/Cargo.toml --lib blocked_stdin_fails_after_child_exit -- --nocapture` | exit 0; 2 passed on macos (characterization, not red); 11.0s including first build | `red.log` |
| pre-fix `cargo test --locked --manifest-path broker/Cargo.toml nonblocking_stdin_waits_for_capacity -- --nocapture` | intended red: exit 101; premature `WouldBlock`; 4.0s | `red-capacity.log` |
| pre-fix `cargo test --locked --manifest-path broker/Cargo.toml --test socket_integration blocked_pty_input_does_not_stall_other_connections` | exit 0; 1 passed; 0.6s | `baseline-socket.log` |
| post-fix `cargo test --locked --manifest-path broker/Cargo.toml --lib stdin -- --nocapture` | exit 0; 6 passed; 5.7s | `green-stdin.log` |
| post-fix `cargo test --locked --manifest-path broker/Cargo.toml --all` | exit 0; 251 passed, 1 existing ignored fixture-regeneration test; 33.8s | `cargo-all.log` |
| `cargo fmt --manifest-path broker/Cargo.toml --check` | exit 1; pre-existing repository-wide formatting differences; 0.3s | `fmt-initial.log` |
| same fmt check against private `git archive` of base f863a5c1 | exit 1 with same unrelated formatting differences; 0.3s; no checkout/ref mutation | `fmt-baseline.log` |
| linux kernel Python probes, cached `python:3-slim`, `--pull=never --network=none`, plan-listed repro directory mounted read-only | both exit 0; blocking writer remains stuck 5s after kill; nonblocking poll reports HUP but write returns EAGAIN | `linux-blocking-repro.log`, `linux-nonblocking-repro.log` |
| final production commit `cargo test --locked --manifest-path broker/Cargo.toml --lib stdin` | exit 0; 6 passed; 4.3s; rerun after restoring existing reply warning level (only post-suite production change) | `final-stdin.log` |
| `git diff f863a5c1..HEAD --check` | exit 0 | command output |

no clippy command is configured in package scripts, CONTRIBUTING, or workflows; not added/run. no local Linux Rust test: `rust:1.89` is not cached, and the plan forbids installing prerequisites. the Linux Python probes confirm the mechanism, not Rust acceptance. no app/browser production code changed; broader application checks remain with CI/final integration.

## linux ci / residual risks

https://github.com/almogdepaz/wolfpack/actions/runs/39148467958 targets production commit `2a62f924542fd3f8f9199f62ad783416c2641151`. last observed result: **in progress**, native archive build running, broker test step not yet started. snapshot: `ci-first-status.json`. report/plan-only follow-up commit may start another run; parent should verify the final-head run and Linux broker test step before accepting/merging.

independent review is owned by the coordinator and remains pending. no claim of Linux Rust success or full GitHub workflow success is made. the exit flag bounds a stalled writer's readiness wait; a living child that never reads still intentionally applies synchronous backpressure. no wire/server/lifecycle policy changes were needed.
