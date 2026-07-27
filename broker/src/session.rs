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

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use thiserror::Error;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::output_bus::OutputBus;
use crate::protocol::{Event, SessionInfo, Snapshot};
use crate::ring_buffer::OutputChunk;
use crate::terminal_state::{TerminalState, TerminalStateError};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionFailure {
    PtyRead(String),
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
    pub failure: Option<SessionFailure>,
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
    #[error("writer acquisition failed: {0}")]
    WriterTake(String),
    #[error("thread spawn failed: {0}")]
    ThreadSpawn(String),
    #[error("terminal state failed: {0}")]
    Terminal(#[from] TerminalStateError),
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
    #[error("pty resize failed: {pty}; terminal rollback failed: {rollback}")]
    PtyWithTerminalRollback {
        pty: String,
        rollback: TerminalStateError,
    },
    #[error("terminal state failed: {0}")]
    Terminal(#[from] TerminalStateError),
}

#[derive(Debug)]
struct Inner {
    state: Mutex<SessionState>,
    waiter: Condvar,
}

struct SpawnedChildGuard {
    child: Option<Box<dyn Child + Send + Sync>>,
}

impl SpawnedChildGuard {
    fn new(child: Box<dyn Child + Send + Sync>) -> Self {
        #[cfg(test)]
        LAST_SPAWNED_PID.with(|observed| observed.set(child.process_id()));
        Self { child: Some(child) }
    }

    fn process_id(&self) -> Option<u32> {
        self.child
            .as_ref()
            .expect("child guard disarmed")
            .process_id()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        self.child
            .as_ref()
            .expect("child guard disarmed")
            .clone_killer()
    }

    fn into_child(mut self) -> Box<dyn Child + Send + Sync> {
        self.child.take().expect("child guard disarmed")
    }
}

impl Drop for SpawnedChildGuard {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let pid = child.process_id();
        if let Err(error) = child.kill() {
            tracing::error!(?pid, %error, "failed to kill child during spawn rollback");
        }
        if let Err(error) = child.wait() {
            tracing::error!(?pid, %error, "failed to reap child during spawn rollback");
        }
        #[cfg(test)]
        LAST_REAPED_PID.with(|observed| observed.set(pid));
    }
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
        let child = SpawnedChildGuard::new(child);

        // Drop the slave so we don't pin an extra fd in this process; the
        // child holds its own copy.
        drop(pair.slave);

        #[cfg(test)]
        fail_forced_setup_step(ForcedSetupFailure::ReaderClone)?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| SpawnError::ReaderClone(e.to_string()))?;

        #[cfg(test)]
        fail_forced_setup_step(ForcedSetupFailure::WriterTake)?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| SpawnError::WriterTake(e.to_string()))?;

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
            failure: None,
        };

        let inner = Arc::new(Inner {
            state: Mutex::new(state),
            waiter: Condvar::new(),
        });

        let terminal = Arc::new(Mutex::new(TerminalState::try_new(opts.cols, opts.rows)?));
        let seq = Arc::new(AtomicU64::new(0));
        let bus = OutputBus::with_defaults();

        let drain_id = id;
        let drain_terminal = Arc::clone(&terminal);
        let drain_seq = Arc::clone(&seq);
        let drain_bus = Arc::clone(&bus);
        let drain_inner = Arc::clone(&inner);
        let drain_events = events.clone();
        let mut drain_child_killer = child.clone_killer();
        if let Err(e) = spawn_named_thread(format!("broker-pty-read-{drain_id}"), move || {
            if let Err(error) = drain_reader(reader, drain_terminal, drain_seq, drain_bus) {
                tracing::error!(
                    session_id = %drain_id,
                    error = %error,
                    "PTY reader failed; terminating session"
                );
                mark_pty_read_failed(&drain_inner, drain_id, &error, &drain_events);
                if let Err(kill_error) = drain_child_killer.kill() {
                    tracing::error!(
                        session_id = %drain_id,
                        error = %kill_error,
                        "failed to terminate child after PTY read failure"
                    );
                }
            }
        }) {
            return Err(SpawnError::ThreadSpawn(e.to_string()));
        }

        let reaper_inner = Arc::clone(&inner);
        let reap_id = id;
        let reaper_events = events.clone();
        spawn_named_thread(format!("broker-pty-wait-{reap_id}"), move || {
            reap(child.into_child(), reaper_inner, reap_id, reaper_events)
        })
        .map_err(|e| SpawnError::ThreadSpawn(e.to_string()))?;

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
        let mut master = self.master.lock().expect("master poisoned");
        resize_terminal_pty_and_state(
            &self.inner,
            id,
            master.as_mut(),
            &self.terminal,
            cols,
            rows,
            events,
        )
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
    ) -> Result<Snapshot, TerminalStateError> {
        let id = self.id();
        let term = self.terminal.lock().expect("terminal poisoned");
        // Read seq under the same lock the drainer holds while bumping it,
        // so the returned (state, seq) pair is consistent.
        let seq = self.seq.load(Ordering::SeqCst);
        term.try_snapshot_with_reflow(
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

trait PtyResize {
    fn try_resize_pty(&mut self, cols: u16, rows: u16) -> Result<(), String>;
}

impl PtyResize for dyn MasterPty + Send {
    fn try_resize_pty(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        self.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())
    }
}

trait TerminalResize {
    fn try_resize_terminal(&mut self, cols: u16, rows: u16) -> Result<(), TerminalStateError>;
}

impl TerminalResize for TerminalState {
    fn try_resize_terminal(&mut self, cols: u16, rows: u16) -> Result<(), TerminalStateError> {
        self.try_resize(cols, rows)
    }
}

fn resize_terminal_pty_and_state<P, T>(
    inner: &Inner,
    session_id: Uuid,
    pty: &mut P,
    terminal: &Mutex<T>,
    cols: u16,
    rows: u16,
    events: &EventSender,
) -> Result<(), ResizeError>
where
    P: PtyResize + ?Sized,
    T: TerminalResize,
{
    let mut state = inner.state.lock().expect("session state poisoned");
    let old_cols = state.cols;
    let old_rows = state.rows;

    {
        let mut terminal = terminal.lock().expect("terminal poisoned");
        terminal.try_resize_terminal(cols, rows)?;
        if let Err(pty) = pty.try_resize_pty(cols, rows) {
            if let Err(rollback) = terminal.try_resize_terminal(old_cols, old_rows) {
                return Err(ResizeError::PtyWithTerminalRollback { pty, rollback });
            }
            return Err(ResizeError::Pty(pty));
        }
    }

    state.cols = cols;
    state.rows = rows;
    drop(state);
    let _ = events.send(Event::SessionResized {
        session_id,
        cols,
        rows,
    });
    let _ = events.send(Event::SnapshotInvalidated { session_id });
    Ok(())
}

trait TerminalFeed {
    fn try_feed_chunk(&mut self, data: &[u8]) -> Result<(), TerminalStateError>;
}

impl TerminalFeed for TerminalState {
    fn try_feed_chunk(&mut self, data: &[u8]) -> Result<(), TerminalStateError> {
        self.try_feed(data)
    }
}

fn drain_reader<R: Read>(
    r: R,
    terminal: Arc<Mutex<TerminalState>>,
    seq: Arc<AtomicU64>,
    bus: Arc<OutputBus>,
) -> io::Result<()> {
    drain_reader_with_terminal(r, terminal, seq, bus)
}

fn drain_reader_with_terminal<R: Read, T: TerminalFeed>(
    mut r: R,
    terminal: Arc<Mutex<T>>,
    seq: Arc<AtomicU64>,
    bus: Arc<OutputBus>,
) -> io::Result<()> {
    let mut buf = [0u8; 8192];
    let outcome = loop {
        match r.read(&mut buf) {
            Ok(0) => break Ok(()),
            Ok(n) => {
                let data = Arc::new(buf[..n].to_vec());
                // Feed the emulator and bump seq under one lock so a snapshot
                // observer can never read seq=N while the state still
                // reflects only N-1 chunks (or vice versa). The new seq
                // (post-bump) is the chunk's own seq — i.e. snapshot.seq
                // and OutputChunk.seq use the same monotonic numbering.
                let new_seq = {
                    let mut term = terminal.lock().expect("terminal poisoned");
                    match term.try_feed_chunk(&data) {
                        Ok(()) => seq.fetch_add(1, Ordering::SeqCst) + 1,
                        Err(error) => break Err(io::Error::other(error)),
                    }
                };
                bus.publish(OutputChunk { seq: new_seq, data });
            }
            Err(error) => break Err(error),
        }
    };
    // Signal "drainer done; every byte produced has been ingested" so
    // attached subscribers see Closed and sync waiters wake up.
    bus.close();
    outcome
}

fn mark_pty_read_failed(
    inner: &Inner,
    session_id: Uuid,
    error: &io::Error,
    events: &EventSender,
) -> bool {
    let transitioned = {
        let mut state = inner.state.lock().expect("session state poisoned");
        if !state.alive {
            false
        } else {
            state.alive = false;
            state.failure = Some(SessionFailure::PtyRead(error.to_string()));
            inner.waiter.notify_all();
            true
        }
    };
    if transitioned {
        let _ = events.send(Event::SessionExited {
            session_id,
            exit_code: None,
            signal: None,
        });
    }
    transitioned
}

fn spawn_named_thread<F>(name: String, f: F) -> io::Result<thread::JoinHandle<()>>
where
    F: FnOnce() + Send + 'static,
{
    #[cfg(test)]
    {
        let step = if name.starts_with("broker-pty-read-") {
            ForcedSetupFailure::ReaderThread
        } else {
            ForcedSetupFailure::ReaperThread
        };
        let should_fail = FORCED_SETUP_FAILURE.with(|forced| forced.get() == Some(step));
        if should_fail {
            FORCED_SETUP_FAILURE.with(|forced| forced.set(None));
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "forced thread spawn failure",
            ));
        }
    }
    thread::Builder::new().name(name).spawn(f)
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ForcedSetupFailure {
    ReaderClone,
    WriterTake,
    ReaderThread,
    ReaperThread,
}

#[cfg(test)]
thread_local! {
    static FORCED_SETUP_FAILURE: std::cell::Cell<Option<ForcedSetupFailure>> = const { std::cell::Cell::new(None) };
    static LAST_SPAWNED_PID: std::cell::Cell<Option<u32>> = const { std::cell::Cell::new(None) };
    static LAST_REAPED_PID: std::cell::Cell<Option<u32>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
fn force_setup_failure_for_test(failure: ForcedSetupFailure) {
    FORCED_SETUP_FAILURE.with(|forced| forced.set(Some(failure)));
    LAST_SPAWNED_PID.with(|observed| observed.set(None));
    LAST_REAPED_PID.with(|observed| observed.set(None));
}

#[cfg(test)]
fn fail_forced_setup_step(step: ForcedSetupFailure) -> Result<(), SpawnError> {
    let should_fail = FORCED_SETUP_FAILURE.with(|forced| forced.get() == Some(step));
    if should_fail {
        FORCED_SETUP_FAILURE.with(|forced| forced.set(None));
        Err(match step {
            ForcedSetupFailure::ReaderClone => SpawnError::ReaderClone("forced failure".into()),
            ForcedSetupFailure::WriterTake => SpawnError::WriterTake("forced failure".into()),
            ForcedSetupFailure::ReaderThread | ForcedSetupFailure::ReaperThread => {
                SpawnError::ThreadSpawn("forced failure".into())
            }
        })
    } else {
        Ok(())
    }
}

#[cfg(test)]
fn take_cleanup_observation_for_test() -> (Option<u32>, Option<u32>) {
    let spawned = LAST_SPAWNED_PID.with(|observed| observed.take());
    let reaped = LAST_REAPED_PID.with(|observed| observed.take());
    (spawned, reaped)
}

fn reap(
    mut child: Box<dyn Child + Send + Sync>,
    inner: Arc<Inner>,
    session_id: Uuid,
    events: EventSender,
) {
    let exit = child.wait();
    let (exit_code, transitioned) = {
        let mut st = inner.state.lock().expect("session state poisoned");
        let transitioned = st.alive;
        st.alive = false;
        st.exit_code = exit.ok().map(|s| s.exit_code() as i32);
        inner.waiter.notify_all();
        (st.exit_code, transitioned)
    };
    // A PTY read failure may have already made the session unavailable and
    // published this transition before killing the child. Reaping still
    // records its exit code, but must not emit a duplicate lifecycle event.
    if transitioned {
        let _ = events.send(Event::SessionExited {
            session_id,
            exit_code,
            signal: None,
        });
    }
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

    struct OneChunkReader {
        chunk: Option<&'static [u8]>,
    }

    impl Read for OneChunkReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let Some(chunk) = self.chunk.take() else {
                return Ok(0);
            };
            buf[..chunk.len()].copy_from_slice(chunk);
            Ok(chunk.len())
        }
    }

    struct TerminalFeedFailure;

    impl TerminalFeed for TerminalFeedFailure {
        fn try_feed_chunk(&mut self, _data: &[u8]) -> Result<(), TerminalStateError> {
            Err(TerminalStateError::GhosttyLimit { operation: "feed" })
        }
    }

    struct FailingReader;

    impl Read for FailingReader {
        fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "forced PTY read failure",
            ))
        }
    }

    #[test]
    fn drainer_feed_failure_closes_output_and_publishes_no_failed_chunk() {
        let terminal = Arc::new(Mutex::new(TerminalFeedFailure));
        let seq = Arc::new(AtomicU64::new(0));
        let bus = OutputBus::new(4, 4);
        let mut receiver = bus.subscribe(None).expect("bus open").receiver;
        let waiter_bus = Arc::clone(&bus);
        let waiter = thread::spawn(move || waiter_bus.wait_closed(Duration::from_millis(200)));

        let error = drain_reader_with_terminal(
            OneChunkReader {
                chunk: Some(b"failed chunk"),
            },
            terminal,
            Arc::clone(&seq),
            Arc::clone(&bus),
        )
        .expect_err("terminal feed failure must be returned");

        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert!(
            error.to_string().contains("ghostty-vt"),
            "unexpected error: {error}"
        );
        assert!(
            waiter.join().expect("waiter thread"),
            "feed failure must wake bus close waiters"
        );
        assert!(bus.is_closed(), "feed failure must close live output");
        assert_eq!(seq.load(Ordering::SeqCst), 0);
        assert_eq!(bus.current_seq(), 0);
        assert!(matches!(
            receiver.try_recv(),
            Err(broadcast::error::TryRecvError::Closed)
        ));
    }

    #[test]
    fn drainer_propagates_read_failure_after_closing_output() {
        let terminal = Arc::new(Mutex::new(
            TerminalState::try_new(80, 24).expect("terminal init"),
        ));
        let seq = Arc::new(AtomicU64::new(0));
        let bus = OutputBus::with_defaults();

        let error = drain_reader(FailingReader, terminal, seq, Arc::clone(&bus))
            .expect_err("PTY read failure must not be treated as EOF");

        assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
        assert!(bus.is_closed(), "read failure must close live output");
    }

    #[test]
    fn pty_read_failure_records_failure_and_emits_one_exit_event() {
        let id = Uuid::new_v4();
        let inner = Arc::new(Inner {
            state: Mutex::new(SessionState {
                id,
                name: "failed-reader".into(),
                cwd: "/tmp".into(),
                command: vec!["sleep".into(), "30".into()],
                env: vec![],
                pid: Some(123),
                started_at_ms: now_ms(),
                cols: 80,
                rows: 24,
                alive: true,
                exit_code: None,
                failure: None,
            }),
            waiter: Condvar::new(),
        });
        let (events, mut receiver) = broadcast::channel(4);
        let error = io::Error::new(io::ErrorKind::BrokenPipe, "forced PTY read failure");

        assert!(mark_pty_read_failed(&inner, id, &error, &events));
        assert!(!mark_pty_read_failed(&inner, id, &error, &events));

        let state = inner.state.lock().expect("session state poisoned");
        assert!(!state.alive);
        assert_eq!(
            state.failure,
            Some(SessionFailure::PtyRead("forced PTY read failure".into()))
        );
        drop(state);
        assert!(matches!(
            receiver.try_recv(),
            Ok(Event::SessionExited {
                session_id,
                exit_code: None,
                signal: None,
            }) if session_id == id
        ));
        assert!(
            receiver.try_recv().is_err(),
            "exit event must be emitted once"
        );
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
    fn every_post_spawn_setup_failure_kills_and_reaps_the_child() {
        for failure in [
            ForcedSetupFailure::ReaderClone,
            ForcedSetupFailure::WriterTake,
            ForcedSetupFailure::ReaderThread,
            ForcedSetupFailure::ReaperThread,
        ] {
            force_setup_failure_for_test(failure);
            let err = spawn_session(opts(vec!["sleep", "30"]))
                .expect_err("forced setup failure must fail session spawn");
            assert!(
                matches!(
                    err,
                    SpawnError::ReaderClone(_)
                        | SpawnError::WriterTake(_)
                        | SpawnError::ThreadSpawn(_)
                ),
                "{failure:?}: {err:?}"
            );
            let (spawned_pid, reaped_pid) = take_cleanup_observation_for_test();
            assert_eq!(reaped_pid, spawned_pid, "{failure:?} must reap its child");
            let pid = spawned_pid.expect("spawned child pid");
            // SAFETY: signal 0 performs existence/permission checking only.
            let status = unsafe { libc::kill(pid as libc::pid_t, 0) };
            assert_eq!(status, -1, "{failure:?}: child {pid} is still alive");
            assert_eq!(
                io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH),
                "{failure:?}: child {pid} was not fully reaped"
            );
        }
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

        let snap = sess.snapshot_terminal(None, None).expect("snapshot");
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

        let after = sess.snapshot_terminal(None, None).expect("snapshot").seq;
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
            *term = TerminalState::try_new(10, 2).expect("terminal init");
            term.try_feed(b"1\r\n2\r\n3\r\n4\r\n5\r\n6")
                .expect("terminal feed");
        }
        let full = sess.snapshot_terminal(None, None).expect("snapshot");
        assert!(
            full.scrollback.len() >= 4,
            "expected >=4 scrollback lines, got {}",
            full.scrollback.len()
        );
        let trimmed = sess.snapshot_terminal(Some(2), None).expect("snapshot");
        assert_eq!(trimmed.scrollback.len(), 2);
        // Truncation keeps the trailing (most recent) lines.
        let last_full = line_text(full.scrollback.last().unwrap());
        let last_trim = line_text(trimmed.scrollback.last().unwrap());
        assert_eq!(last_full, last_trim);

        let _ = sess.kill(libc::SIGKILL);
        let _ = sess.wait_for_exit(Duration::from_secs(5));
    }

    #[derive(Default)]
    struct RecordingPtyResize {
        calls: Vec<(u16, u16)>,
        fail: bool,
    }

    impl PtyResize for RecordingPtyResize {
        fn try_resize_pty(&mut self, cols: u16, rows: u16) -> Result<(), String> {
            self.calls.push((cols, rows));
            if self.fail {
                Err("forced PTY resize failure".into())
            } else {
                Ok(())
            }
        }
    }

    struct RecordingTerminalResize {
        cols: u16,
        rows: u16,
        fail_on_target: bool,
        fail_on_rollback: bool,
        calls: Vec<(u16, u16)>,
    }

    impl RecordingTerminalResize {
        fn new(cols: u16, rows: u16) -> Self {
            Self {
                cols,
                rows,
                fail_on_target: false,
                fail_on_rollback: false,
                calls: Vec::new(),
            }
        }
    }

    impl TerminalResize for RecordingTerminalResize {
        fn try_resize_terminal(&mut self, cols: u16, rows: u16) -> Result<(), TerminalStateError> {
            self.calls.push((cols, rows));
            if self.fail_on_target && (cols, rows) != (self.cols, self.rows) {
                return Err(TerminalStateError::GhosttyLimit {
                    operation: "resize",
                });
            }
            if self.fail_on_rollback && (cols, rows) == (80, 24) {
                return Err(TerminalStateError::GhosttyStatus {
                    operation: "resize rollback",
                    code: -1,
                });
            }
            self.cols = cols;
            self.rows = rows;
            Ok(())
        }
    }

    fn resize_test_state(id: Uuid) -> Inner {
        Inner {
            state: Mutex::new(SessionState {
                id,
                name: "resize-transaction".into(),
                cwd: "/tmp".into(),
                command: vec!["sleep".into(), "30".into()],
                env: vec![],
                pid: Some(123),
                started_at_ms: now_ms(),
                cols: 80,
                rows: 24,
                alive: true,
                exit_code: None,
                failure: None,
            }),
            waiter: Condvar::new(),
        }
    }

    #[test]
    fn resize_terminal_failure_leaves_pty_state_uncommitted_and_emits_no_success_events() {
        let id = Uuid::new_v4();
        let inner = resize_test_state(id);
        let (events, mut receiver) = broadcast::channel(4);
        let mut pty = RecordingPtyResize::default();
        let mut terminal = RecordingTerminalResize::new(80, 24);
        terminal.fail_on_target = true;
        let terminal = Mutex::new(terminal);

        let error =
            resize_terminal_pty_and_state(&inner, id, &mut pty, &terminal, 132, 50, &events)
                .expect_err("terminal resize failure must abort transaction");

        assert!(matches!(error, ResizeError::Terminal(_)));
        assert!(pty.calls.is_empty(), "PTY resize must not be attempted");
        let terminal = terminal.lock().expect("terminal poisoned");
        assert_eq!((terminal.cols, terminal.rows), (80, 24));
        let state = inner.state.lock().expect("session state poisoned");
        assert_eq!((state.cols, state.rows), (80, 24));
        drop(state);
        assert!(receiver.try_recv().is_err(), "no success events expected");
    }

    #[test]
    fn resize_pty_failure_rolls_terminal_back_without_committing_state_or_events() {
        let id = Uuid::new_v4();
        let inner = resize_test_state(id);
        let (events, mut receiver) = broadcast::channel(4);
        let mut pty = RecordingPtyResize {
            fail: true,
            ..RecordingPtyResize::default()
        };
        let terminal = Mutex::new(RecordingTerminalResize::new(80, 24));

        let error =
            resize_terminal_pty_and_state(&inner, id, &mut pty, &terminal, 132, 50, &events)
                .expect_err("PTY resize failure must abort transaction");

        assert!(matches!(error, ResizeError::Pty(_)));
        assert_eq!(pty.calls, vec![(132, 50)]);
        let terminal = terminal.lock().expect("terminal poisoned");
        assert_eq!(terminal.calls, vec![(132, 50), (80, 24)]);
        assert_eq!((terminal.cols, terminal.rows), (80, 24));
        let state = inner.state.lock().expect("session state poisoned");
        assert_eq!((state.cols, state.rows), (80, 24));
        drop(state);
        assert!(receiver.try_recv().is_err(), "no success events expected");
    }

    #[test]
    fn resize_pty_failure_reports_terminal_rollback_failure() {
        let id = Uuid::new_v4();
        let inner = resize_test_state(id);
        let (events, mut receiver) = broadcast::channel(4);
        let mut pty = RecordingPtyResize {
            fail: true,
            ..RecordingPtyResize::default()
        };
        let mut terminal = RecordingTerminalResize::new(80, 24);
        terminal.fail_on_rollback = true;
        let terminal = Mutex::new(terminal);

        let error =
            resize_terminal_pty_and_state(&inner, id, &mut pty, &terminal, 132, 50, &events)
                .expect_err("rollback failure must be represented");

        assert!(matches!(error, ResizeError::PtyWithTerminalRollback { .. }));
        assert_eq!(pty.calls, vec![(132, 50)]);
        let terminal = terminal.lock().expect("terminal poisoned");
        assert_eq!(terminal.calls, vec![(132, 50), (80, 24)]);
        assert_eq!((terminal.cols, terminal.rows), (132, 50));
        let state = inner.state.lock().expect("session state poisoned");
        assert_eq!((state.cols, state.rows), (80, 24));
        drop(state);
        assert!(receiver.try_recv().is_err(), "no success events expected");
    }

    #[test]
    fn resize_updates_session_state_and_terminal_dimensions() {
        let sess = spawn_session(opts(vec!["sleep", "30"])).expect("spawn");
        let before = sess.snapshot();
        assert_eq!((before.cols, before.rows), (80, 24));

        sess.resize(132, 50, &test_events()).expect("resize ok");

        let after = sess.snapshot();
        assert_eq!((after.cols, after.rows), (132, 50));
        let snap = sess.snapshot_terminal(None, None).expect("snapshot");
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
        let snap_seq = sess.snapshot_terminal(None, None).expect("snapshot").seq;
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
            if screen_contains(
                &sess.snapshot_terminal(None, None).expect("snapshot"),
                "INIT",
            ) {
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
        let prefill_seq = sess.snapshot_terminal(None, None).expect("snapshot").seq;
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
