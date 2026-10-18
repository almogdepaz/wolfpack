# fix: linux pty master write never unblocks after child exit (ci `test` job hangs)

status: implementation active; regression red observed; reviewer pending.
branch: `fix/pty-blocked-write-hang` off `main` @ f863a5c1, worktree `/Users/home/Dev/.worktrees/wolfpack/pty-blocked-write`.

## symptom

every `Tests / test` run on main since 28f1ee2c (#450) hangs in `cargo test --locked --manifest-path broker/Cargo.toml --all` until github cancels the job at 6h. last green main run: 4fa27dd3. the hanging test is `broker/tests/socket_integration.rs::blocked_pty_input_does_not_stall_other_connections` (added in #450). it passes on macos in <0.1s.

## root cause (verified with a python repro on macos and in a linux container)

a blocking `write(2)` of 256 KiB to the pty master while the child is in raw mode and not reading fills the kernel input queue and blocks. the test then SIGKILLs the child and expects the write to finish.

| kernel | blocking write after child SIGKILL | `poll(POLLOUT)` after child SIGKILL | `write` after child SIGKILL (O_NONBLOCK) |
| --- | --- | --- | --- |
| macos | returns `EIO` immediately | `POLLHUP` | `EIO` |
| linux | **stays blocked forever** | `POLLHUP` immediately | `EAGAIN` (never `EIO`) |

repro scripts: `/private/tmp/claude-501/-Users-home-Dev-wolfpack/a4d5dab9-361a-4455-b051-ce78df0f7292/scratchpad/ptyrepro/pty_block.py` and `pty_nonblock.py` (run with `python3 -I`; linux via `docker run --rm -v <dir>:/w:ro python:3-slim python3 -I /w/pty_block.py`).

chain in the broker on linux:
1. `broker/src/server.rs:377` runs `session.write_stdin` on `spawn_blocking`; `PtyInput::write_input` (`broker/src/session.rs:806`) does a blocking `write_all` on the shared master description.
2. the child is killed; linux never wakes the blocked writer. the `spawn_blocking` thread is pinned forever.
3. `handle_connection` teardown (`server.rs:459`) awaits `input_task` which awaits the pinned blocking task → the connection never finishes (its permit never returns).
4. `Harness::shutdown` returns (it only awaits the accept task), but the tokio runtime drop at the end of `#[tokio::test]` waits for the blocking pool thread → test hangs → job hangs.

## required outcome

- a client stdin write that cannot make progress must return an error once the session's child has exited / the slave side has hung up, on linux and macos, without pinning a thread forever.
- the drainer must keep draining while a client write is blocked (existing `query_reply_does_not_wait_behind_a_blocked_stdin_write` behaviour).
- `blocked_pty_input_does_not_stall_other_connections` passes on linux ci. no `#[ignore]`, no platform `cfg` skip.
- `.github/workflows/test.yml`: add `timeout-minutes` (suggest 45) to the `test` job so a future hang fails fast instead of burning 6h.

## design (approved direction; implementer owns details within it)

make the pty master open file description permanently `O_NONBLOCK` at spawn and drive both halves with `poll(2)`:

- **writer** (`PtyInput::write_input` and the `ReplyWrite::Blocking` reply flush): loop `poll(fd, POLLOUT, bounded timeout)` → `write`. `EAGAIN` → poll again. `POLLHUP`/`POLLERR`/`POLLNVAL`, or the session's child already exited, → return `io::Error` (`BrokenPipe`), partial write count logged at debug. note linux reports `POLLHUP` but `write` keeps returning `EAGAIN`, so the hangup check must come from poll revents (and/or the exit flag), not from the write error.
- **reply writes** (`ReplyWrite::NonBlocking`): single attempt as today; `NonBlockingReply` flag toggling becomes unnecessary and should be removed rather than kept as dead code.
- **drainer** (`drain_reader_with_terminal`, `session.rs:1334`): `read` → `EAGAIN` → `poll(POLLIN)` and retry; `POLLHUP` with no readable data / `EIO` / `0` → end of output as today. keep the existing end-of-output semantics (output bus closes, exit event ordering unchanged).
- **`PtyWriter::drop`** no longer needs to flip flags (description already non-blocking); portable-pty's drop write of `\n`+VEOF may now get `EAGAIN`, which is fine (ignored today anyway).
- bounded poll timeouts (e.g. 250 ms) plus an `exited` check cover the grandchild-holds-the-slave case where no `POLLHUP` arrives.
- `libc` is already a dependency; no new crates. keep changes inside `broker/src/session.rs` (+ small `server.rs` touch only if needed) and the workflow file.

alternatives considered and rejected: cancelling the blocking thread (not possible), `#[ignore]` on linux (hides a real hang in production: a dead raw-mode child leaves a broker thread and a connection permit pinned forever), polling only in the writer while keeping the description blocking (the drainer's blocking `read` shares the description and would break).

## tdd

1. red: a `session.rs` unit test: spawn `sh -c 'stty raw -echo; exec sleep 30'`, write enough to block (≥256 KiB) from a thread, SIGKILL the child, assert the write thread finishes with an error within 5 s. on macos this currently passes (EIO), so also add a linux-meaningful assertion path: the test must not depend on `EIO`; it should pass on both. run the existing `blocked_pty_input_does_not_stall_other_connections` for context.
2. green: implement the design.
3. keep green: `cargo test --manifest-path broker/Cargo.toml --all` locally (macos), `cargo fmt --check`, `cargo clippy` if the repo already runs it (check `package.json` scripts / `CONTRIBUTING.md`; do not add new tooling).
4. linux gate: ci on the pr is the only linux signal available by default. local linux run (zig 0.16.0 is installed at /opt/homebrew/bin/zig; docker is running): `bun run scripts/build-ghostty-vt.ts --target x86_64-unknown-linux-gnu` then `cargo test` inside a `rust:1.89` container with `WOLFPACK_GHOSTTY_VT_DIR` pointed at the bundle. if that needs an install, skip it and say so.

## commit boundary and authority

- commit each coherent step on this branch (include this plan file in the first commit). push the branch and open a **draft** pr titled `fix(broker): unblock pty stdin writes after child exit; bound ci test job` so ci provides the linux signal. **never merge.** do not rebase/force-push over reviewer-visible history.
- pre-authorized within the plan: poll timeout values, error kind choice, helper naming/placement in `session.rs`, how the exit flag is observed by the writer, which existing tests are adapted (not weakened), the exact `timeout-minutes` value.
- needs the user: any change to the broker wire protocol, dropping/ignoring a test, adding a dependency or toolchain, touching code outside `broker/` and the workflow file.
- when done, write a short report to `.plans/pty-blocked-write-hang-report.md` (what changed, commands run with exit status, linux ci run url + result, residual risks) and notify the parent.

## progress / current handoff

- start base/head: `f863a5c141904af0b3b2fb058fc0a2f328b61dce`; worktree initially clean.
- history confirms blocking writes predate #450 (introduced in #435); no previous poll implementation to restore.
- baseline child-exit tests (including inherited slave) and socket regression pass on macos; they are characterization, not red evidence.
- red: `nonblocking_stdin_waits_for_capacity` uses real nonblocking socket I/O and fails with premature `WouldBlock` (exit 101). this covers the retry path needed for permanently nonblocking PTYs.
- private artifacts: `/tmp/pty-blocked-write-checks-0287cf28/` (`red.log`, `red-capacity.log`, `baseline-socket.log`). native bundle reused through `WOLFPACK_GHOSTTY_VT_DIR=/Users/home/Dev/wolfpack/broker/native/ghostty-vt/aarch64-apple-darwin` and verified by Cargo build.rs.
- local linux Rust image unavailable (`rust:1.89` not cached); no image/tool installation. linux Rust gate will be draft-pr ci.
- commit/push/draft-pr authority unchanged; no merge/deploy. no open design decisions.

## ledger

| role | session id | assignment | state |
| --- | --- | --- | --- |
| coordinator | 146621c3-fc1f-467c-bc53-7f1eba382b4e (wolfpack-3) | plan, verify, lifecycle | active |
| implementer | 0287cf28-6e82-45c9-963d-886d06defd94 (pty-hang-implementation) | full plan above | running; sub-session of wolfpack-3 |
| reviewer | (fill on spawn) | read-only review of the pr diff vs this plan | pending |
