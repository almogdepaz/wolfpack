//! Per-session PTY ownership.
//!
//! Each `Session` owns:
//!   * a portable-pty master (held for stdin writes and resize),
//!   * a per-session `TerminalState` emulator behind `Arc<Mutex<…>>` and a
//!     monotonic seq counter — the drainer feeds every byte chunk it pulls
//!     off the master reader through the emulator and bumps seq under the
//!     same lock so a `snapshot_terminal()` reader sees a consistent
//!     `(state, seq)` pair,
//!   * an `OutputBus` (ring buffer + broadcast channel) — the drainer
//!     publishes every chunk it pulls so live subscribers get fanout and
//!     late attaches can replay the recent ring window via `since_seq`;
//!     when the PTY hits EOF the drainer calls `OutputBus::close()` so
//!     attached receivers terminate cleanly,
//!   * a reaper thread that calls `Child::wait()` and publishes
//!     `alive=false` + `exit_code` to shared state.
//!
//! `kill(signal)` uses `libc::kill` directly on the recorded pid so that
//! ESRCH (process already gone) collapses cleanly into `KillOutcome::NotAlive`
//! instead of bubbling up as a generic syscall error.

use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use thiserror::Error;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::output_bus::OutputBus;
use crate::protocol::{Event, SessionInfo, Snapshot};
use crate::ring_buffer::OutputChunk;
use crate::terminal_state::TerminalState;

/// Shared async-event sink. Every lifecycle transition (`session_started`,
/// `session_exited`, `session_resized`, `snapshot_invalidated`) is published
/// here so per-connection forwarders can fan events out to clients.
pub type EventSender = broadcast::Sender<Event>;

#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub name: String,
    pub cwd: String,
    pub command: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone)]
pub struct SessionState {
    pub id: Uuid,
    pub name: String,
    pub cwd: String,
    pub command: Vec<String>,
    pub env: Vec<(String, String)>,
    pub pid: Option<u32>,
    pub started_at_ms: u64,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
    pub exit_code: Option<i32>,
}

impl SessionState {
    pub fn to_info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id,
            name: self.name.clone(),
            cwd: self.cwd.clone(),
            command: self.command.clone(),
            env: self.env.clone(),
            cols: self.cols,
            rows: self.rows,
            pid: self.pid,
            started_at_ms: self.started_at_ms,
            alive: self.alive,
            exit_code: self.exit_code,
        }
    }
}

#[derive(Debug, Error)]
pub enum SpawnError {
    #[error("command vec is empty")]
    EmptyCommand,
    #[error("openpty failed: {0}")]
    OpenPty(String),
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("reader clone failed: {0}")]
    ReaderClone(String),
    #[error("thread spawn failed: {0}")]
    ThreadSpawn(String),
}

#[derive(Debug, PartialEq, Eq)]
pub enum KillOutcome {
    Killed,
    NotAlive,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum KillError {
    #[error("kill syscall failed: errno {0}")]
    Errno(i32),
    #[error("session has no recorded pid")]
    NoPid,
}

#[derive(Debug, Error)]
pub enum ResizeError {
    #[error("pty resize failed: {0}")]
    Pty(String),
}

#[derive(Debug)]
struct Inner {
    state: Mutex<SessionState>,
    waiter: Condvar,
}

pub struct Session {
    inner: Arc<Inner>,
    /// Held only for `resize` — the write half was taken out at spawn time
    /// into `writer` so stdin writes don't serialise against resize ioctls.
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Write half of the PTY master, taken once at spawn via `take_writer()`.
    writer: Mutex<Box<dyn Write + Send>>,
    /// Canonical terminal-state emulator. The drainer thread feeds every PTY
    /// byte chunk through this before forwarding to subscribers; readers
    /// (`snapshot_terminal`) lock it to materialise a `protocol::Snapshot`.
    terminal: Arc<Mutex<TerminalState>>,
    /// Monotonic snapshot version. Bumped under the `terminal` lock once per
    /// drained chunk so `(state, seq)` stays consistent for snapshotters.
    /// `seq` and the seq of the corresponding `OutputChunk` published on
    /// `bus` are the same value: snapshot.seq == max bus chunk seq.
    seq: Arc<AtomicU64>,
    /// Live-output fanout. Drainer publishes here; subscribe RPC handlers
    /// attach to it for replay + live streaming.
    bus: Arc<OutputBus>,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let id = self.inner.state.lock().map(|s| s.id).ok();
        f.debug_struct("Session")
            .field("id", &id)
            .finish_non_exhaustive()
    }
}

impl Session {
    pub fn spawn(opts: SpawnOptions, events: EventSender) -> Result<Self, SpawnError> {
        if opts.command.is_empty() {
            return Err(SpawnError::EmptyCommand);
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: opts.rows,
                cols: opts.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| SpawnError::OpenPty(e.to_string()))?;

        let mut cmd = CommandBuilder::new(&opts.command[0]);
        for arg in opts.command.iter().skip(1) {
            cmd.arg(arg);
        }
        cmd.cwd(&opts.cwd);
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }

        let child: Box<dyn Child + Send + Sync> = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| SpawnError::Spawn(e.to_string()))?;

        // Drop the slave so we don't pin an extra fd in this process; the
        // child holds its own copy.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| SpawnError::ReaderClone(e.to_string()))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| SpawnError::ReaderClone(e.to_string()))?;

        let pid = child.process_id();
        let id = Uuid::new_v4();
        let state = SessionState {
            id,
            name: opts.name,
            cwd: opts.cwd,
            command: opts.command,
            env: opts.env,
            pid,
            started_at_ms: now_ms(),
            cols: opts.cols,
            rows: opts.rows,
            alive: true,
            exit_code: None,
        };

        let inner = Arc::new(Inner {
            state: Mutex::new(state),
            waiter: Condvar::new(),
        });

        let terminal = Arc::new(Mutex::new(TerminalState::new(opts.cols, opts.rows)));
        let seq = Arc::new(AtomicU64::new(0));
        let bus = OutputBus::with_defaults();

        let drain_id = id;
        let drain_terminal = Arc::clone(&terminal);
        let drain_seq = Arc::clone(&seq);
        let drain_bus = Arc::clone(&bus);
        if let Err(e) = spawn_named_thread(format!("broker-pty-read-{drain_id}"), move || {
            drain_reader(reader, drain_terminal, drain_seq, drain_bus)
        }) {
            let mut child = child;
            let _ = child.kill();
            return Err(SpawnError::ThreadSpawn(e.to_string()));
        }

        let reaper_inner = Arc::clone(&inner);
        let reap_id = id;
        let reaper_events = events.clone();
        let mut child_killer = child.clone_killer();
        spawn_named_thread(format!("broker-pty-wait-{reap_id}"), move || {
            reap(child, reaper_inner, reap_id, reaper_events)
        })
        .map_err(|e| {
            let _ = child_killer.kill();
            SpawnError::ThreadSpawn(e.to_string())
        })?;

        Ok(Session {
            inner,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            terminal,
            seq,
            bus,
        })
    }

    /// Live-output fanout for this session. Cloned by every subscribe RPC
    /// handler to attach a new receiver.
    pub fn output_bus(&self) -> Arc<OutputBus> {
        Arc::clone(&self.bus)
    }

    pub fn snapshot(&self) -> SessionState {
        self.inner
            .state
            .lock()
            .expect("session state poisoned")
            .clone()
    }

    pub fn id(&self) -> Uuid {
        self.inner.state.lock().expect("session state poisoned").id
    }

    pub fn pid(&self) -> Option<u32> {
        self.inner.state.lock().expect("session state poisoned").pid
    }

    pub fn alive(&self) -> bool {
        self.inner
            .state
            .lock()
            .expect("session state poisoned")
            .alive
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.inner
            .state
            .lock()
            .expect("session state poisoned")
            .exit_code
    }

    /// Send `signal` to the recorded pid.
    ///
    /// Returns `NotAlive` when the reaper already flipped `alive=false` OR
    /// when the syscall returns ESRCH (process gone but reaper hasn't won the
    /// state-update race yet). Both cases are semantically the same to a
    /// caller and collapsing them here keeps `kill_session` idempotent.
    pub fn kill(&self, signal: i32) -> Result<KillOutcome, KillError> {
        let pid = {
            let st = self.inner.state.lock().expect("session state poisoned");
            if !st.alive {
                return Ok(KillOutcome::NotAlive);
            }
            match st.pid {
                Some(p) => p as libc::pid_t,
                None => return Err(KillError::NoPid),
            }
        };
        // SAFETY: libc::kill is a thin syscall wrapper; pid + signal are
        // validated by the kernel. No memory is shared.
        let rc = unsafe { libc::kill(pid, signal) };
        if rc == 0 {
            return Ok(KillOutcome::Killed);
        }
        let err = std::io::Error::last_os_error();
        match err.raw_os_error() {
            Some(libc::ESRCH) => Ok(KillOutcome::NotAlive),
            Some(e) => Err(KillError::Errno(e)),
            None => Err(KillError::Errno(0)),
        }
    }

    /// Resize the PTY and update both the session metadata and the emulator
    /// grid so subsequent `session_info` / `snapshot` calls reflect the new
    /// dimensions. The master lock is held across all three updates so
    /// concurrent resizes can't interleave and leave (master, state, terminal)
    /// disagreeing about the current size.
    ///
    /// Fires `session_resized` and `snapshot_invalidated` on `events` so every
    /// connected client knows to re-flow its local mirror and re-snapshot.
    /// Best-effort: send errors (no active subscribers) are silently ignored.
    pub fn resize(&self, cols: u16, rows: u16, events: &EventSender) -> Result<(), ResizeError> {
        let id = self.id();
        let master = self.master.lock().expect("master poisoned");
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| ResizeError::Pty(e.to_string()))?;
        {
            let mut st = self.inner.state.lock().expect("session state poisoned");
            st.cols = cols;
            st.rows = rows;
        }
        {
            let mut term = self.terminal.lock().expect("terminal poisoned");
            term.resize(cols, rows);
        }
        drop(master);
        let _ = events.send(Event::SessionResized {
            session_id: id,
            cols,
            rows,
        });
        let _ = events.send(Event::SnapshotInvalidated { session_id: id });
        Ok(())
    }

    /// Write raw bytes to the PTY master's stdin (e.g. keyboard input from a client).
    pub fn write_stdin(&self, data: &[u8]) -> io::Result<()> {
        self.writer.lock().expect("writer poisoned").write_all(data)
    }

    /// Materialise a `protocol::Snapshot` from the session's emulator state.
    ///
    /// `scrollback_lines = Some(n)` truncates the snapshot's scrollback to its
    /// trailing `n` raw rows before any reflow. `None` returns the full ring.
    ///
    /// `target_cols = Some(c)` reflows scrollback to `c` columns using wrap
    /// markers after truncation. Omit to skip reflow.
    pub fn snapshot_terminal(
        &self,
        scrollback_lines: Option<u32>,
        target_cols: Option<u16>,
    ) -> Snapshot {
        let id = self.id();
        let term = self.terminal.lock().expect("terminal poisoned");
        // Read seq under the same lock the drainer holds while bumping it,
        // so the returned (state, seq) pair is consistent.
        let seq = self.seq.load(Ordering::SeqCst);
        term.snapshot_with_reflow(
            id,
            seq,
            now_ms(),
            scrollback_lines.map(|n| n as usize),
            target_cols.map(|c| c as usize),
        )
    }

    /// Block (up to `timeout`) until the reaper marks this session not-alive.
    /// Returns `true` if the session is dead by the time we return.
    pub fn wait_for_exit(&self, timeout: Duration) -> bool {
        let st = self.inner.state.lock().expect("session state poisoned");
        let (st, _to) = self
            .inner
            .waiter
            .wait_timeout_while(st, timeout, |s| s.alive)
            .expect("session state poisoned");
        !st.alive
    }
}

fn drain_reader<R: Read>(
    mut r: R,
    terminal: Arc<Mutex<TerminalState>>,
    seq: Arc<AtomicU64>,
    bus: Arc<OutputBus>,
) {
    let mut buf = [0u8; 8192];
    loop {
        match r.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let data = Arc::new(buf[..n].to_vec());
                // Feed the emulator and bump seq under one lock so a snapshot
                // observer can never read seq=N while the state still
                // reflects only N-1 chunks (or vice versa). The new seq
                // (post-bump) is the chunk's own seq — i.e. snapshot.seq
                // and OutputChunk.seq use the same monotonic numbering.
                let new_seq = {
                    let mut term = terminal.lock().expect("terminal poisoned");
                    term.feed(&data);
                    seq.fetch_add(1, Ordering::SeqCst) + 1
                };
                bus.publish(OutputChunk { seq: new_seq, data });
            }
            Err(_) => break,
        }
    }
    // Signal "drainer done; every byte produced has been ingested" so
    // attached subscribers see Closed and sync waiters wake up.
    bus.close();
}

fn spawn_named_thread<F>(name: String, f: F) -> io::Result<thread::JoinHandle<()>>
where
    F: FnOnce() + Send + 'static,
{
    #[cfg(test)]
    if FORCE_THREAD_SPAWN_FAILURES.with(|failures| {
        let n = failures.get();
        if n > 0 {
            failures.set(n - 1);
            true
        } else {
            false
        }
    }) {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "forced thread spawn failure",
        ));
    }
    thread::Builder::new().name(name).spawn(f)
}

#[cfg(test)]
thread_local! {
    static FORCE_THREAD_SPAWN_FAILURES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn force_thread_spawn_failures_for_test(count: usize) {
    FORCE_THREAD_SPAWN_FAILURES.with(|failures| failures.set(count));
}

fn reap(
    mut child: Box<dyn Child + Send + Sync>,
    inner: Arc<Inner>,
    session_id: Uuid,
    events: EventSender,
) {
    let exit = child.wait();
    let exit_code = {
        let mut st = inner.state.lock().expect("session state poisoned");
        st.alive = false;
        st.exit_code = exit.ok().map(|s| s.exit_code() as i32);
        inner.waiter.notify_all();
        st.exit_code
    };
    // Best-effort: an Err here just means no one is currently subscribed.
    let _ = events.send(Event::SessionExited {
        session_id,
        exit_code,
        signal: None,
    });
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(cmd: Vec<&str>) -> SpawnOptions {
        SpawnOptions {
            name: "test".into(),
            cwd: "/tmp".into(),
            command: cmd.into_iter().map(String::from).collect(),
            env: vec![],
            cols: 80,
            rows: 24,
        }
    }

    fn test_events() -> EventSender {
        broadcast::channel::<Event>(64).0
    }

    fn spawn_session(o: SpawnOptions) -> Result<Session, SpawnError> {
        Session::spawn(o, test_events())
    }

    #[test]
    fn spawn_succeeds_records_pid_and_marks_alive() {
        let sess = spawn_session(opts(vec!["sleep", "30"])).expect("spawn");
        assert!(sess.pid().is_some(), "pid must be recorded");
        assert!(sess.pid().unwrap() > 0, "pid must be a real process id");
        assert!(
            sess.alive(),
            "session must be alive immediately after spawn"
        );
        assert_eq!(sess.exit_code(), None);
        let info = sess.snapshot().to_info();
        assert_eq!(info.cols, 80);
        assert_eq!(info.rows, 24);
        assert!(info.alive);

        // Cleanup so the test doesn't leak a sleep process.
        let _ = sess.kill(libc::SIGKILL);
        assert!(sess.wait_for_exit(Duration::from_secs(5)));
    }

    #[test]
    fn spawn_bad_command_fails_or_exits_immediately() {
        // posix_spawn semantics differ: some libc versions report ENOENT
        // synchronously (Err from spawn), others fork+exec successfully and
        // the child exits 127 right away. Both are valid "bad command"
        // outcomes — the contract is that the broker doesn't think it has a
        // happy live session.
        let bogus = opts(vec!["/no/such/path/wolfpack-broker-test-bogus"]);
        match spawn_session(bogus) {
            Err(_) => {}
            Ok(sess) => {
                assert!(
                    sess.wait_for_exit(Duration::from_secs(5)),
                    "bogus binary must exit promptly"
                );
                assert!(!sess.alive());
                // exec failures generally surface as 127 / non-zero. We don't
                // assert the exact code (varies by shell/loader), only that
                // the session is no longer alive.
            }
        }
    }

    #[test]
    fn spawn_thread_failure_returns_error() {
        force_thread_spawn_failures_for_test(1);
        let err = spawn_session(opts(vec!["sleep", "30"]))
            .expect_err("thread spawn failure must fail session spawn");
        assert!(matches!(err, SpawnError::ThreadSpawn(_)));
    }

    #[test]
    fn kill_then_reap_flips_alive_to_false() {
        let sess = spawn_session(opts(vec!["sleep", "30"])).expect("spawn");
        assert!(sess.alive());

        let outcome = sess.kill(libc::SIGTERM).expect("kill should succeed");
        assert_eq!(outcome, KillOutcome::Killed);

        assert!(
            sess.wait_for_exit(Duration::from_secs(5)),
            "reaper must observe the SIGTERM and flip alive=false"
        );
        assert!(!sess.alive(), "session must report dead after reap");
        // exit_code value (e.g. 143 = 128 + SIGTERM) varies by libc/shell;
        // we only assert that the reaper actually published one.
        assert!(
            sess.exit_code().is_some(),
            "reaper must publish an exit_code"
        );
    }

    fn line_text(line: &crate::protocol::StyledLine) -> String {
        line.cells.iter().map(|c| c.ch.as_str()).collect()
    }

    fn screen_contains(snap: &Snapshot, needle: &str) -> bool {
        snap.visible_screen
            .iter()
            .any(|l| line_text(l).contains(needle))
    }

    #[test]
    fn child_output_appears_in_terminal_snapshot() {
        // `printf hello` writes 5 bytes, then exits. PTY EOF triggers the
        // drainer to call OutputBus::close(); waiting on that close is the
        // canonical "every byte the child produced has been ingested by
        // the emulator" handshake.
        let sess = spawn_session(opts(vec!["printf", "hello"])).expect("spawn");
        assert!(sess.output_bus().wait_closed(Duration::from_secs(5)));
        assert!(sess.wait_for_exit(Duration::from_secs(5)));

        let snap = sess.snapshot_terminal(None, None);
        assert_eq!(snap.cols, 80);
        assert_eq!(snap.rows, 24);
        assert!(
            screen_contains(&snap, "hello"),
            "expected 'hello' in visible screen, got rows: {:?}",
            snap.visible_screen
                .iter()
                .map(line_text)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn snapshot_seq_advances_when_drainer_consumes_bytes() {
        let sess = spawn_session(opts(vec!["printf", "abc"])).expect("spawn");
        // Don't capture an "initial" seq before draining — the drainer could
        // already have bumped it by the time the main thread runs, making
        // initial == after even though both reflect post-feed state. seq
        // starts at 0 by definition, so post-feed seq > 0 is the contract.
        assert!(sess.output_bus().wait_closed(Duration::from_secs(5)));
        let _ = sess.wait_for_exit(Duration::from_secs(5));

        let after = sess.snapshot_terminal(None, None).seq;
        assert!(
            after > 0,
            "seq must advance after drainer ingests output (got {after})"
        );
    }

    #[test]
    fn snapshot_truncates_scrollback_when_limit_provided() {
        // Drive the emulator directly via Session::terminal so we don't have
        // to coax a child into producing exactly N lines of scrollback.
        let sess = spawn_session(opts(vec!["sleep", "30"])).expect("spawn");
        {
            let mut term = sess.terminal.lock().expect("terminal poisoned");
            // 5 rows; feeding "1\r\n..6" pushes 4 lines into scrollback.
            *term = TerminalState::new(10, 2);
            term.feed(b"1\r\n2\r\n3\r\n4\r\n5\r\n6");
        }
        let full = sess.snapshot_terminal(None, None);
        assert!(
            full.scrollback.len() >= 4,
            "expected >=4 scrollback lines, got {}",
            full.scrollback.len()
        );
        let trimmed = sess.snapshot_terminal(Some(2), None);
        assert_eq!(trimmed.scrollback.len(), 2);
        // Truncation keeps the trailing (most recent) lines.
        let last_full = line_text(full.scrollback.last().unwrap());
        let last_trim = line_text(trimmed.scrollback.last().unwrap());
        assert_eq!(last_full, last_trim);

        let _ = sess.kill(libc::SIGKILL);
        let _ = sess.wait_for_exit(Duration::from_secs(5));
    }

    #[test]
    fn resize_updates_session_state_and_terminal_dimensions() {
        let sess = spawn_session(opts(vec!["sleep", "30"])).expect("spawn");
        let before = sess.snapshot();
        assert_eq!((before.cols, before.rows), (80, 24));

        sess.resize(132, 50, &test_events()).expect("resize ok");

        let after = sess.snapshot();
        assert_eq!((after.cols, after.rows), (132, 50));
        let snap = sess.snapshot_terminal(None, None);
        assert_eq!((snap.cols, snap.rows), (132, 50));
        assert_eq!(snap.visible_screen.len(), 50);

        let _ = sess.kill(libc::SIGKILL);
        let _ = sess.wait_for_exit(Duration::from_secs(5));
    }

    #[test]
    fn kill_already_dead_returns_not_alive() {
        // Use a quickly-exiting child so the reaper has already run by the
        // time we call kill().
        let sess = spawn_session(opts(vec!["true"])).expect("spawn");

        // Wait for the reaper to flip the flag.
        assert!(
            sess.wait_for_exit(Duration::from_secs(5)),
            "child should reap"
        );
        assert!(!sess.alive());

        let outcome = sess.kill(libc::SIGTERM).expect("kill should not error");
        assert_eq!(outcome, KillOutcome::NotAlive);
    }

    #[test]
    fn output_bus_publishes_chunks_with_monotonic_seq() {
        let sess = spawn_session(opts(vec!["printf", "abcde"])).expect("spawn");
        assert!(sess.output_bus().wait_closed(Duration::from_secs(5)));
        let _ = sess.wait_for_exit(Duration::from_secs(5));

        // After close, we can no longer subscribe; instead inspect that
        // current_seq matches snapshot.seq — they share the same numbering.
        let snap_seq = sess.snapshot_terminal(None, None).seq;
        assert_eq!(sess.output_bus().current_seq(), snap_seq);
        assert!(snap_seq >= 1, "at least one chunk must have been published");
    }

    /// Verify the "no double-paint after resize" invariant:
    ///
    /// Any PTY bytes that arrive AFTER a snapshot (including SIGWINCH-induced
    /// redraws) are assigned seq > snapshot.seq by the drainer, so
    /// subscribe(sinceSeq: snapshot.seq) covers them exactly — no hole,
    /// no duplicate.
    ///
    /// Uses `cat` as an echo server to inject post-snapshot bytes without
    /// relying on a TUI app's SIGWINCH handler. The seq-assignment mechanism
    /// is identical regardless of whether bytes originate from SIGWINCH or
    /// stdin echo.
    /// Block until `output_bus.current_seq()` stops advancing for at least
    /// `quiet` and is non-zero, or the overall `timeout` elapses. Used in
    /// PTY-echo-based tests to make sure both the tty-driver echo chunk AND
    /// the child's stdout chunk have landed before sampling state — they
    /// arrive as separate read()s under load and naively waiting on "first
    /// chunk" picks up only the echo, racing with the child's output.
    fn wait_for_bus_quiet(sess: &Session, quiet: Duration, timeout: Duration) {
        let bus = sess.output_bus();
        let deadline = std::time::Instant::now() + timeout;
        let mut last_seq = bus.current_seq();
        let mut last_change = std::time::Instant::now();
        loop {
            assert!(
                std::time::Instant::now() < deadline,
                "bus never went quiet (last_seq={last_seq})"
            );
            std::thread::sleep(Duration::from_millis(5));
            let now_seq = bus.current_seq();
            if now_seq != last_seq {
                last_seq = now_seq;
                last_change = std::time::Instant::now();
                continue;
            }
            if now_seq > 0 && last_change.elapsed() >= quiet {
                return;
            }
        }
    }

    #[test]
    fn subscribe_since_prefill_seq_covers_post_snapshot_bytes() {
        let sess = spawn_session(opts(vec!["cat"])).expect("spawn");

        // Prime the session: write a marker and wait for it to appear in the
        // terminal so snapshot.seq > 0 (drainer has ingested at least one chunk).
        sess.write_stdin(b"INIT\n").expect("write stdin");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            assert!(std::time::Instant::now() < deadline, "INIT never appeared");
            if screen_contains(&sess.snapshot_terminal(None, None), "INIT") {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        // PTY runs in cooked mode with echo enabled by default, so writing
        // "INIT\n" to the master produces TWO chunks: the tty-driver echo
        // and `cat`'s stdout. Under load these arrive as separate read()s.
        // If we sampled prefill_seq right after seeing INIT in the screen,
        // we'd capture only the echo chunk — the cat-output chunk would
        // race against REDRAW below and end up in the subscribe replay
        // instead of REDRAW. Wait for the bus to go quiet so prefill_seq
        // covers every INIT-related chunk.
        wait_for_bus_quiet(&sess, Duration::from_millis(100), Duration::from_secs(5));

        // Capture prefill seq — the seq a client would record before subscribing.
        let prefill_seq = sess.snapshot_terminal(None, None).seq;
        assert!(prefill_seq > 0, "prefill_seq must be > 0 after INIT output");

        // Simulate post-resize redraw bytes arriving after the snapshot.
        sess.write_stdin(b"REDRAW\n").expect("write stdin");

        // Same reasoning: REDRAW also produces echo + cat-output. Wait for
        // BOTH to land (bus quiet again) before sampling so we don't read
        // the ring between the two chunks.
        wait_for_bus_quiet(&sess, Duration::from_millis(100), Duration::from_secs(5));
        assert!(
            sess.output_bus().current_seq() > prefill_seq,
            "REDRAW bytes never arrived past prefill_seq"
        );

        // subscribe(sinceSeq: prefill_seq) — this is what the client calls
        // after completing its prefill paint.
        let sub = sess
            .output_bus()
            .subscribe(Some(prefill_seq))
            .expect("bus must still be open");

        // Every replayed chunk must have seq > prefill_seq (the gate works).
        for chunk in &sub.replay {
            assert!(
                chunk.seq > prefill_seq,
                "chunk seq={} <= prefill_seq={}: double-paint window open",
                chunk.seq,
                prefill_seq
            );
        }

        // The REDRAW bytes must be present in the replay — no hole.
        let replay_bytes: Vec<u8> = sub
            .replay
            .iter()
            .flat_map(|c| c.data.iter().copied())
            .collect();
        assert!(
            replay_bytes.windows(6).any(|w| w == b"REDRAW"),
            "REDRAW not found in subscribe replay (sinceSeq={prefill_seq}): \
             seq gating left a hole in the post-snapshot byte stream"
        );

        let _ = sess.kill(libc::SIGKILL);
        let _ = sess.wait_for_exit(Duration::from_secs(5));
    }

    #[test]
    fn reaper_publishes_session_exited_event() {
        let events = test_events();
        let mut rx = events.subscribe();
        let sess = Session::spawn(opts(vec!["true"]), events).expect("spawn");
        let session_id = sess.id();
        assert!(sess.wait_for_exit(Duration::from_secs(5)));

        // Drain the broadcast channel until SessionExited shows up. The
        // reaper publishes after marking alive=false, so wait_for_exit
        // returning true is the cue that the event is either already in
        // the channel or imminent — bound the wait at TTL anyway.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            assert!(
                std::time::Instant::now() < deadline,
                "no SessionExited event"
            );
            match rx.try_recv() {
                Ok(Event::SessionExited {
                    session_id: sid, ..
                }) => {
                    assert_eq!(sid, session_id);
                    return;
                }
                Ok(_) => continue,
                Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(other) => panic!("event recv error: {other:?}"),
            }
        }
    }
}
