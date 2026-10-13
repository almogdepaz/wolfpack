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
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use thiserror::Error;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::output_bus::{OutputBus, Subscription};
use crate::protocol::{Event, ProgramStatusRecord, SessionInfo, Snapshot};
use crate::ring_buffer::OutputChunk;
use crate::terminal_state::{FeedOutcome, RawSnapshot, TerminalState, TerminalStateError};

/// Shared async-event sink. Every lifecycle transition (`session_started`,
/// `session_exited`, `session_resized`, `snapshot_invalidated`) is published
/// here so per-connection forwarders can fan events out to clients.
pub type EventSender = broadcast::Sender<Event>;
/// Bytes of OSC 7501 query replies held while a client write owns the PTY
/// writer. A reply is 10–11 bytes; anything beyond this means the program is
/// flooding queries without reading stdin, and extra replies are dropped.
const MAX_PENDING_REPLY_BYTES: usize = 1024;
const EXIT_DRAIN_BARRIER_TIMEOUT: Duration = Duration::from_secs(5);
/// Minimum spacing of one session's `program_status_changed` events. Real
/// emitters change state on human time scales (claude: idle → working → done
/// over seconds), so 200ms (≤ 5 events/s per session) costs no visible latency,
/// while a program reporting on every write can no longer fill the shared
/// 256-slot event bus that also carries lifecycle events. The server batches
/// its own refresh across sessions on top of this.
const PROGRAM_STATUS_EVENT_INTERVAL: Duration = Duration::from_millis(200);
/// How often a session holding `working`/`blocked` records checks that the
/// process group behind the latest report still owns the terminal's
/// foreground (see `ForegroundWatch`). Sessions without such records never
/// check.
const FOREGROUND_CHECK_INTERVAL: Duration = Duration::from_millis(500);

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
    pub fn to_info(&self, output_seq: u64, program_status: Option<ProgramStatusRecord>) -> SessionInfo {
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
            output_seq: Some(output_seq.to_string()),
            program_status,
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
    #[error("PTY master fd duplication failed: {0}")]
    MasterDup(String),
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

#[derive(Clone)]
struct CachedSnapshot {
    seq: u64,
    scrollback_lines: Option<u32>,
    target_cols: Option<u16>,
    snapshot: Arc<Snapshot>,
}

pub struct Session {
    inner: Arc<Inner>,
    /// Held only for `resize` — the write half was taken out at spawn time
    /// into `writer` so stdin writes don't serialise against resize ioctls.
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Write half of the PTY master, taken once at spawn via `take_writer()`.
    /// Shared with the drainer, which sends OSC 7501 query replies.
    input: Arc<PtyInput>,
    /// Canonical terminal-state emulator. The drainer thread feeds every PTY
    /// byte chunk through this before forwarding to subscribers; readers
    /// (`snapshot_terminal`) lock it only to capture raw snapshot buffers.
    terminal: Arc<Mutex<TerminalState>>,
    /// Monotonic snapshot version. Bumped under the `terminal` lock once per
    /// drained chunk so `(state, seq)` stays consistent for snapshotters.
    /// `seq` and the seq of the corresponding `OutputChunk` published on
    /// `bus` are the same value: snapshot.seq == max bus chunk seq.
    seq: Arc<AtomicU64>,
    /// Live-output fanout. Drainer publishes here; subscribe RPC handlers
    /// attach to it for replay + live streaming.
    bus: Arc<OutputBus>,
    /// Most recent materialized snapshot. JSON encoding happens later on the
    /// connection writer, outside the terminal lock; identical sequence/key
    /// requests reuse this immutable `Arc` without cloning its cell graph.
    snapshot_cache: Mutex<Option<CachedSnapshot>>,
    /// Resize changes terminal truth without advancing the output seq. Prevent
    /// an in-flight off-lock conversion from repopulating an invalidated cache.
    snapshot_generation: AtomicU64,
    /// Latest root program status record and its paced change events.
    program_status: Arc<ProgramStatusPublisher>,
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
    pub fn spawn(mut opts: SpawnOptions, events: EventSender) -> Result<Self, SpawnError> {
        if opts.command.is_empty() {
            return Err(SpawnError::EmptyCommand);
        }

        // Identity is broker-owned and must reach the child at launch, including
        // when a caller accidentally forwards its parent's session environment.
        let id = Uuid::new_v4();
        opts.env.retain(|(key, _)| key != "WOLFPACK_SESSION_ID");
        opts.env.push(("WOLFPACK_SESSION_ID".into(), id.to_string()));

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

        // Neither the drainer's query replies nor the writer's final drop may
        // block (see `NonBlockingReply` and `PtyWriter`); each owns a dup of
        // the master so the fd it sets flags on cannot be closed and reused
        // underneath it.
        #[cfg(test)]
        fail_forced_setup_step(ForcedSetupFailure::MasterDup)?;
        let reply_fd = dup_master_fd(pair.master.as_ref())
            .map_err(|e| SpawnError::MasterDup(e.to_string()))?;
        let writer_fd = dup_master_fd(pair.master.as_ref())
            .map_err(|e| SpawnError::MasterDup(e.to_string()))?;
        let writer: Box<dyn Write + Send> = Box::new(PtyWriter {
            inner: Some(writer),
            fd: writer_fd,
        });
        let foreground_fd = dup_master_fd(pair.master.as_ref())
            .map_err(|e| SpawnError::MasterDup(e.to_string()))?;

        let pid = child.process_id();
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
        let input = Arc::new(PtyInput::new(id, writer, reply_fd));
        let foreground = Arc::new(ForegroundGroup::new(id, foreground_fd));
        let program_status = Arc::new(ProgramStatusPublisher::new(
            id,
            events.clone(),
            PROGRAM_STATUS_EVENT_INTERVAL,
            Some(Arc::new(ForegroundWatch::new(Arc::clone(&terminal), Arc::clone(&foreground)))),
        ));
        let drain_effects = DrainEffects {
            input: Arc::clone(&input),
            program_status: Arc::clone(&program_status),
            foreground,
        };
        let mut drain_child_killer = child.clone_killer();
        if let Err(e) = spawn_named_thread(format!("broker-pty-read-{drain_id}"), move || {
            if let Err(error) = drain_reader(reader, drain_terminal, Arc::clone(&drain_seq), drain_bus, drain_effects) {
                tracing::error!(
                    session_id = %drain_id,
                    error = %error,
                    "PTY reader failed; terminating session"
                );
                mark_pty_read_failed(&drain_inner, drain_id, &error, &drain_events, drain_seq.load(Ordering::SeqCst));
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
        let reaper_terminal = Arc::clone(&terminal);
        let reaper_bus = Arc::clone(&bus);
        let reaper_seq = Arc::clone(&seq);
        let reap_id = id;
        let reaper_events = events.clone();
        let reaper_program_status = Arc::clone(&program_status);
        spawn_named_thread(format!("broker-pty-wait-{reap_id}"), move || {
            reap(
                child.into_child(),
                reaper_inner,
                reaper_terminal,
                reaper_bus,
                reaper_seq,
                reap_id,
                reaper_events,
                &reaper_program_status,
            )
        })
        .map_err(|e| SpawnError::ThreadSpawn(e.to_string()))?;

        Ok(Session {
            inner,
            master: Mutex::new(pair.master),
            input,
            terminal,
            seq,
            bus,
            snapshot_cache: Mutex::new(None),
            snapshot_generation: AtomicU64::new(0),
            program_status,
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

    /// Never takes the terminal lock: `list_sessions` calls this per session
    /// and must not queue behind a feed or snapshot capture.
    pub fn info(&self) -> SessionInfo {
        self.snapshot()
            .to_info(self.seq.load(Ordering::Acquire), self.program_status.root())
    }

    /// Every OSC 7501 program status record (root and children), sorted by id.
    pub fn program_status_records(&self) -> Vec<ProgramStatusRecord> {
        self.terminal.lock().expect("terminal poisoned").program_status_records()
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
        let result = resize_terminal_pty_and_state(
            &self.inner,
            id,
            master.as_mut(),
            &self.terminal,
            cols,
            rows,
            events,
            || {
                let mut cache = self.snapshot_cache.lock().expect("snapshot cache poisoned");
                self.snapshot_generation.fetch_add(1, Ordering::SeqCst);
                *cache = None;
            },
        );
        result
    }

    /// Write raw bytes to the PTY master's stdin (e.g. keyboard input from a client).
    pub fn write_stdin(&self, data: &[u8]) -> io::Result<()> {
        self.input.write_input(data)
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
    ) -> Result<Arc<Snapshot>, TerminalStateError> {
        self.capture_and_materialize(
            scrollback_lines, target_cols, |_| (), RawSnapshot::materialize,
        ).map(|(snapshot, ())| snapshot)
    }

    /// Atomically capture terminal state and establish the replay/live cut.
    pub fn snapshot_and_subscribe(
        &self,
        scrollback_lines: Option<u32>,
        target_cols: Option<u16>,
    ) -> Result<(Arc<Snapshot>, Subscription), TerminalStateError> {
        self.capture_and_materialize(
            scrollback_lines,
            target_cols,
            |seq| self.bus.subscribe(Some(seq)),
            RawSnapshot::materialize,
        )
    }

    fn capture_and_materialize<T>(
        &self,
        scrollback_lines: Option<u32>,
        target_cols: Option<u16>,
        at_capture: impl FnOnce(u64) -> T,
        materialize: impl FnOnce(RawSnapshot) -> Result<Snapshot, TerminalStateError>,
    ) -> Result<(Arc<Snapshot>, T), TerminalStateError> {
        let id = self.id();
        let term = self.terminal.lock().expect("terminal poisoned");
        // Seq and the subscription cut are captured under the drainer's lock.
        let seq = self.seq.load(Ordering::SeqCst);
        if let Some(cached) = self.cached_snapshot(seq, scrollback_lines, target_cols) {
            return Ok((cached, at_capture(seq)));
        }
        let generation = self.snapshot_generation.load(Ordering::SeqCst);
        let raw = term.try_capture_snapshot(
            id,
            seq,
            now_ms(),
            scrollback_lines.map(|n| n as usize),
            target_cols.map(|c| c as usize),
        )?;
        let captured = at_capture(seq);
        drop(term);
        let snapshot = Arc::new(materialize(raw)?);
        self.cache_snapshot(seq, generation, scrollback_lines, target_cols, Arc::clone(&snapshot));
        Ok((snapshot, captured))
    }

    fn cached_snapshot(
        &self,
        seq: u64,
        scrollback_lines: Option<u32>,
        target_cols: Option<u16>,
    ) -> Option<Arc<Snapshot>> {
        self.snapshot_cache
            .lock()
            .expect("snapshot cache poisoned")
            .as_ref()
            .filter(|cached| cached.seq == seq
                && cached.scrollback_lines == scrollback_lines
                && cached.target_cols == target_cols)
            .map(|cached| Arc::clone(&cached.snapshot))
    }

    fn cache_snapshot(
        &self,
        seq: u64,
        generation: u64,
        scrollback_lines: Option<u32>,
        target_cols: Option<u16>,
        snapshot: Arc<Snapshot>,
    ) {
        let mut cache = self.snapshot_cache.lock().expect("snapshot cache poisoned");
        if self.snapshot_generation.load(Ordering::SeqCst) == generation
            && self.seq.load(Ordering::SeqCst) == seq
        {
            *cache = Some(CachedSnapshot {
                seq,
                scrollback_lines,
                target_cols,
                snapshot,
            });
        }
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
    invalidate_snapshot_cache: impl FnOnce(),
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
        invalidate_snapshot_cache();
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
    fn try_feed_chunk(&mut self, data: &[u8]) -> Result<FeedOutcome, TerminalStateError>;

    fn program_status_root(&self) -> Option<ProgramStatusRecord> {
        None
    }

    fn set_program_status_reporter(&mut self, _group: Option<libc::pid_t>) {}

    fn watched_program_status_group(&self) -> Option<libc::pid_t> {
        None
    }
}

impl TerminalFeed for TerminalState {
    fn try_feed_chunk(&mut self, data: &[u8]) -> Result<FeedOutcome, TerminalStateError> {
        self.try_feed(data)
    }

    fn program_status_root(&self) -> Option<ProgramStatusRecord> {
        TerminalState::program_status_root(self)
    }

    fn set_program_status_reporter(&mut self, group: Option<libc::pid_t>) {
        TerminalState::set_program_status_reporter(self, group)
    }

    fn watched_program_status_group(&self) -> Option<libc::pid_t> {
        TerminalState::watched_program_status_group(self)
    }
}

/// Where the drainer delivers feed side effects: OSC 7501 query replies go
/// to the PTY input, record changes go to the paced publisher, and each
/// stored report is stamped with the terminal's foreground process group.
struct DrainEffects {
    input: Arc<PtyInput>,
    program_status: Arc<ProgramStatusPublisher>,
    foreground: Arc<ForegroundGroup>,
}

/// The session's PTY stdin, shared by client input and the drainer's OSC 7501
/// query replies.
///
/// Client writes block (that is their backpressure). Replies must never wait
/// for one: a program that stopped reading stdin can leave a client write
/// blocked indefinitely while still producing output. So a reply is queued and
/// written by whichever thread holds the writer next: the drainer itself when
/// the writer is free (`try_lock`), otherwise the client writer right after its
/// write. That writer re-checks the queue after unlocking, so a reply queued
/// while it held the lock is never stranded.
///
/// Only the drainer writes replies non-blocking (`NonBlockingReply`, dropped
/// when the input queue is full): the flag lives on the open file description
/// the drainer reads from, so no other thread may set it while the drainer
/// could be inside `read()`. A client thread flushes replies with an ordinary
/// blocking write, which is its own backpressure anyway.
///
/// A full queue can also cut a reply mid-way. The program's parser is then
/// inside an OSC, so the unwritten tail of that reply is re-queued first and
/// goes out before any further client input; whole replies that did not fit
/// are dropped.
struct PtyInput {
    session_id: Uuid,
    writer: Mutex<Box<dyn Write + Send>>,
    pending_replies: Mutex<PendingReplies>,
    /// Dup of the PTY master (shares the writer's open file description);
    /// `None` only for test writers that cannot block.
    reply_fd: Option<OwnedFd>,
}

impl PtyInput {
    fn new(session_id: Uuid, writer: Box<dyn Write + Send>, reply_fd: Option<OwnedFd>) -> Self {
        Self {
            session_id,
            writer: Mutex::new(writer),
            pending_replies: Mutex::new(PendingReplies::default()),
            reply_fd,
        }
    }

    /// Client input: blocks while the program's input queue is full.
    fn write_input(&self, data: &[u8]) -> io::Result<()> {
        let written = {
            let mut writer = self.writer.lock().expect("writer poisoned");
            // A reply the drainer could only write part of must be completed
            // before this input, or the program parses the input as OSC text.
            self.flush_replies(&mut writer, ReplyWrite::Blocking);
            let written = writer.write_all(data);
            self.flush_replies(&mut writer, ReplyWrite::Blocking);
            written
        };
        self.flush_replies_if_idle(ReplyWrite::Blocking);
        written
    }

    fn send_reply(&self, reply: &[u8]) {
        if reply.is_empty() {
            return;
        }
        {
            let mut pending = self.pending_replies.lock().expect("pending replies poisoned");
            if pending.bytes() + reply.len() > MAX_PENDING_REPLY_BYTES {
                tracing::debug!(session_id = %self.session_id, "too many pending program status query replies; dropped one");
                return;
            }
            pending.whole.push(reply.to_vec());
        }
        self.flush_replies_if_idle(ReplyWrite::NonBlocking);
    }

    fn flush_replies_if_idle(&self, mode: ReplyWrite) {
        if self.pending_replies.lock().expect("pending replies poisoned").is_empty() {
            return;
        }
        // Busy: the current holder flushes after its write and re-checks
        // after unlocking.
        if let Ok(mut writer) = self.writer.try_lock() {
            self.flush_replies(&mut writer, mode);
        }
    }

    /// Caller holds the writer.
    fn flush_replies(&self, writer: &mut Box<dyn Write + Send>, mode: ReplyWrite) {
        let replies = std::mem::take(&mut *self.pending_replies.lock().expect("pending replies poisoned"));
        if replies.is_empty() {
            return;
        }
        let batch = replies.batch();
        let written = match (mode, &self.reply_fd) {
            (ReplyWrite::NonBlocking, Some(fd)) => match NonBlockingReply::enter(fd.as_fd()) {
                Ok(_restore) => write_counting(writer, &batch),
                Err(error) => Err((0, error)),
            },
            _ => write_counting(writer, &batch),
        };
        // Best effort, like the probe itself: a dropped or failed reply only
        // means the program sees the protocol as unsupported.
        match written {
            Ok(()) => {}
            Err((count, error)) if error.kind() == io::ErrorKind::WouldBlock => {
                self.requeue_cut_reply(&replies, count);
                tracing::debug!(
                    session_id = %self.session_id,
                    "PTY input full; dropped program status query reply"
                );
            }
            Err((_, error)) => {
                tracing::warn!(session_id = %self.session_id, %error, "failed to answer program status query");
            }
        }
    }

    /// The first `count` bytes of `replies` reached the PTY. Whatever is left
    /// of a reply the program has started reading (a previous tail, or a whole
    /// reply cut mid-way) is queued to go out first, so the next flush
    /// terminates the OSC the program is parsing. Whole unwritten replies are
    /// dropped, and so are the newest whole pending replies if the tail would
    /// otherwise exceed the bound: never part of one.
    fn requeue_cut_reply(&self, replies: &PendingReplies, count: usize) {
        let Some(tail) = replies.cut_tail(count) else {
            return;
        };
        let mut pending = self.pending_replies.lock().expect("pending replies poisoned");
        while !pending.whole.is_empty() && pending.bytes() + tail.len() > MAX_PENDING_REPLY_BYTES {
            pending.whole.pop();
            tracing::debug!(session_id = %self.session_id, "too many pending program status query replies; dropped one");
        }
        pending.tail = tail;
    }
}

/// Query replies waiting for the PTY writer (see `PtyInput`).
#[derive(Default)]
struct PendingReplies {
    /// Unwritten rest of a reply the PTY took only part of; goes out first.
    tail: Vec<u8>,
    /// Whole replies, oldest first.
    whole: Vec<Vec<u8>>,
}

impl PendingReplies {
    fn is_empty(&self) -> bool {
        self.tail.is_empty() && self.whole.is_empty()
    }

    fn bytes(&self) -> usize {
        self.tail.len() + self.whole.iter().map(Vec::len).sum::<usize>()
    }

    /// Everything in write order.
    fn batch(&self) -> Vec<u8> {
        let mut batch = self.tail.clone();
        for reply in &self.whole {
            batch.extend_from_slice(reply);
        }
        batch
    }

    /// What remains of the reply the program has started reading after
    /// `count` bytes of `batch()` went out: the rest of a previous tail, or of
    /// a whole reply cut mid-way. `None` when the cut falls on a boundary.
    fn cut_tail(&self, count: usize) -> Option<Vec<u8>> {
        let mut start = 0;
        for (index, piece) in std::iter::once(&self.tail).chain(&self.whole).enumerate() {
            let end = start + piece.len();
            let started = (index == 0 && !piece.is_empty()) || count > start;
            if started && count < end {
                return Some(piece[count - start..].to_vec());
            }
            start = end;
        }
        None
    }
}

/// `write_all` that reports how many bytes went out before an error.
fn write_counting(writer: &mut dyn Write, data: &[u8]) -> Result<(), (usize, io::Error)> {
    let mut count = 0;
    while count < data.len() {
        match writer.write(&data[count..]) {
            Ok(0) => return Err((count, io::ErrorKind::WriteZero.into())),
            Ok(n) => count += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err((count, error)),
        }
    }
    Ok(())
}

/// Holds a session's latest root program status record for `info()` and
/// publishes `program_status_changed` at most once per `interval`: the first
/// change goes out at once, later ones within the interval collapse into one
/// trailing event that carries the latest root, so the newest state is always
/// delivered. A pacing thread starts on the first change (most sessions never
/// report). `close` flushes a pending change and joins the thread.
///
/// The same thread runs the session's `ForegroundWatch` every
/// `FOREGROUND_CHECK_INTERVAL` while the drainer reports a group to watch, and
/// otherwise sleeps until the next change.
struct ProgramStatusPublisher {
    session_id: Uuid,
    events: EventSender,
    interval: Duration,
    shared: Arc<PublisherShared>,
    watch: Option<Arc<ForegroundWatch>>,
}

type PublisherShared = (Mutex<PublisherState>, Condvar);

#[derive(Default)]
struct PublisherState {
    root: Option<ProgramStatusRecord>,
    dirty: bool,
    closed: bool,
    /// A working/blocked record exists and its reporter group is known.
    watching: bool,
    pacer: Option<thread::JoinHandle<()>>,
}

impl ProgramStatusPublisher {
    fn new(session_id: Uuid, events: EventSender, interval: Duration, watch: Option<Arc<ForegroundWatch>>) -> Self {
        Self {
            session_id,
            events,
            interval,
            shared: Arc::new((Mutex::new(PublisherState::default()), Condvar::new())),
            watch,
        }
    }

    fn root(&self) -> Option<ProgramStatusRecord> {
        self.shared.0.lock().expect("program status poisoned").root.clone()
    }

    /// Record a changed root and schedule its event.
    fn update(&self, root: Option<ProgramStatusRecord>) {
        let (lock, wake) = &*self.shared;
        let mut state = lock.lock().expect("program status poisoned");
        state.root = root;
        if state.closed {
            // After close nobody paces: publish directly.
            self.send(state.root.clone());
            return;
        }
        state.dirty = true;
        if state.pacer.is_none() {
            match self.spawn_pacer() {
                Ok(handle) => state.pacer = Some(handle),
                Err(error) => {
                    tracing::warn!(session_id = %self.session_id, %error, "program status pacer unavailable; publishing unpaced");
                    state.dirty = false;
                    self.send(state.root.clone());
                    return;
                }
            }
        }
        wake.notify_all();
    }

    /// Start or stop foreground checks. Called by the drainer under the
    /// terminal lock after every stored report or record change.
    fn set_watching(&self, watching: bool) {
        let (lock, wake) = &*self.shared;
        let mut state = lock.lock().expect("program status poisoned");
        if state.watching != watching {
            state.watching = watching;
            wake.notify_all();
        }
    }

    /// Flush any pending change and stop pacing; later updates publish
    /// directly.
    fn close(&self) {
        let pacer = {
            let mut state = self.shared.0.lock().expect("program status poisoned");
            state.closed = true;
            self.shared.1.notify_all();
            state.pacer.take()
        };
        if let Some(pacer) = pacer {
            let _ = pacer.join();
        }
    }

    fn send(&self, root: Option<ProgramStatusRecord>) {
        let _ = self.events.send(Event::ProgramStatusChanged {
            session_id: self.session_id,
            program_status: root,
        });
    }

    fn spawn_pacer(&self) -> io::Result<thread::JoinHandle<()>> {
        let shared = Arc::clone(&self.shared);
        let events = self.events.clone();
        let session_id = self.session_id;
        let interval = self.interval;
        let watch = self.watch.clone();
        thread::Builder::new()
            .name(format!("broker-pty-status-{session_id}"))
            .spawn(move || {
                let (lock, wake) = &*shared;
                // Kept across events, so a stream of reports cannot keep
                // pushing the next check back.
                let mut next_check: Option<Instant> = None;
                loop {
                    let root = {
                        let mut state = lock.lock().expect("program status poisoned");
                        while !state.dirty && !state.closed {
                            let Some(watch) = watch.as_ref().filter(|_| state.watching) else {
                                next_check = None;
                                state = wake.wait(state).expect("program status poisoned");
                                continue;
                            };
                            let due = *next_check.get_or_insert_with(|| Instant::now() + FOREGROUND_CHECK_INTERVAL);
                            let now = Instant::now();
                            if now < due {
                                state = wake.wait_timeout(state, due - now).expect("program status poisoned").0;
                                continue;
                            }
                            next_check = None;
                            // The check takes the terminal lock, which the
                            // drainer holds while it takes this one.
                            drop(state);
                            watch.check(&shared);
                            state = lock.lock().expect("program status poisoned");
                        }
                        if !state.dirty {
                            return;
                        }
                        state.dirty = false;
                        state.root.clone()
                    };
                    let _ = events.send(Event::ProgramStatusChanged { session_id, program_status: root });
                    // Hold later changes for the interval; closing cuts the
                    // wait short so a pending change flushes promptly.
                    let state = lock.lock().expect("program status poisoned");
                    let _ = wake
                        .wait_timeout_while(state, interval, |state| !state.closed)
                        .expect("program status poisoned");
                }
            })
    }
}

impl Drop for ProgramStatusPublisher {
    fn drop(&mut self) {
        self.close();
    }
}

/// The PTY's foreground process group, read on the master side
/// (`tcgetpgrp`; Linux and macOS both answer it for a pty master).
struct ForegroundGroup {
    session_id: Uuid,
    /// Dup of the PTY master; `None` when the PTY exposes no fd.
    fd: Option<OwnedFd>,
    unreadable_logged: AtomicBool,
}

impl ForegroundGroup {
    fn new(session_id: Uuid, fd: Option<OwnedFd>) -> Self {
        Self { session_id, fd, unreadable_logged: AtomicBool::new(false) }
    }

    /// `None` when the platform or PTY does not report one.
    fn group(&self) -> Option<libc::pid_t> {
        let result = match &self.fd {
            // SAFETY: the fd is open for this borrow; tcgetpgrp only reads.
            Some(fd) => match unsafe { libc::tcgetpgrp(fd.as_raw_fd()) } {
                group if group > 0 => Ok(group),
                _ => Err(io::Error::last_os_error()),
            },
            None => Err(io::Error::from(io::ErrorKind::Unsupported)),
        };
        result
            .map_err(|error| {
                if !self.unreadable_logged.swap(true, Ordering::Relaxed) {
                    tracing::debug!(session_id = %self.session_id, %error, "PTY foreground process group unreadable; program status records keep exit/prompt drops only");
                }
            })
            .ok()
    }
}

/// Spec: when the process attached to the terminal exits, its `working` and
/// `blocked` records no longer describe anything. The broker reads "attached"
/// as the terminal's foreground process group: a program run from a shell is
/// not the PTY leader, so a crash leaves the shell (leader) alive and no
/// prompt mark arrives from shells without OSC 133. Each check drops live
/// records, as an OSC 133 prompt start does, when the group behind the latest
/// report has left the foreground or no longer exists.
struct ForegroundWatch {
    terminal: Arc<Mutex<TerminalState>>,
    foreground: Arc<ForegroundGroup>,
    #[cfg(test)]
    checks: AtomicU64,
}

impl ForegroundWatch {
    fn new(terminal: Arc<Mutex<TerminalState>>, foreground: Arc<ForegroundGroup>) -> Self {
        Self {
            terminal,
            foreground,
            #[cfg(test)]
            checks: AtomicU64::new(0),
        }
    }

    /// Pacing thread only, holding no publisher lock.
    fn check(&self, shared: &PublisherShared) {
        #[cfg(test)]
        self.checks.fetch_add(1, Ordering::SeqCst);
        let mut term = self.terminal.lock().expect("terminal poisoned");
        if drop_if_reporter_left(&mut term, self.foreground.group(), process_group_exists) {
            // Under the terminal lock, like the drainer's and reaper's
            // updates, so a stale root can never overwrite a newer one.
            let mut state = shared.0.lock().expect("program status poisoned");
            state.root = term.program_status_root();
            state.dirty = true;
            state.watching = term.watched_program_status_group().is_some();
        }
    }
}

/// Drop working/blocked/idle records (done/error survive) when the watched
/// reporter group has left the foreground. True when records were dropped.
fn drop_if_reporter_left(
    term: &mut TerminalState,
    foreground: Option<libc::pid_t>,
    group_exists: impl FnOnce(libc::pid_t) -> bool,
) -> bool {
    let Some(reporter) = term.watched_program_status_group() else {
        return false;
    };
    reporter_left_foreground(reporter, foreground, group_exists) && term.drop_transient_program_status()
}

/// An unreadable foreground keeps the records (no new information). A
/// different foreground group drops them at once, even if the reporter
/// regains the foreground later (a job suspended and resumed with `fg` has no
/// live record until it reports again).
fn reporter_left_foreground(
    reporter: libc::pid_t,
    foreground: Option<libc::pid_t>,
    group_exists: impl FnOnce(libc::pid_t) -> bool,
) -> bool {
    match foreground {
        None => false,
        Some(group) if group != reporter => true,
        Some(_) => !group_exists(reporter),
    }
}

/// `kill(-group, 0)`: only ESRCH proves the group is gone (EPERM means it
/// exists under another user).
fn process_group_exists(group: libc::pid_t) -> bool {
    // SAFETY: signal 0 performs only the existence/permission check.
    let result = unsafe { libc::kill(-group, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// How a thread holding the PTY writer flushes queued replies.
#[derive(Clone, Copy)]
enum ReplyWrite {
    /// Drainer thread only (see `PtyInput`).
    NonBlocking,
    /// Client input threads.
    Blocking,
}

/// Holds the PTY master's open file description in `O_NONBLOCK` for one
/// query reply and restores its flags on drop. Drainer thread only.
///
/// A blocking reply write would stall the drainer whenever the program does
/// not read stdin (a raw-mode program flooding `OSC 7501 ; ?` wedges its
/// whole session: no output drain, so the program blocks on stdout too). With
/// the writer mutex held on the drainer thread, nothing else can observe the
/// flag: stdin writes take the same mutex, the reader shares the description
/// but is this drainer thread, and resize is an ioctl on the master. A full
/// input queue drops the reply (possibly after a partial write the program is
/// not reading anyway).
struct NonBlockingReply<'a> {
    fd: BorrowedFd<'a>,
    flags: libc::c_int,
}

impl<'a> NonBlockingReply<'a> {
    fn enter(fd: BorrowedFd<'a>) -> io::Result<Self> {
        let flags = fd_status_flags(fd)?;
        set_fd_status_flags(fd, flags | libc::O_NONBLOCK)?;
        Ok(Self { fd, flags })
    }
}

impl Drop for NonBlockingReply<'_> {
    fn drop(&mut self) {
        let _ = set_fd_status_flags(self.fd, self.flags);
    }
}

/// The session's PTY stdin writer. portable-pty's writer writes `\n` + VEOF
/// to the master when dropped; once the program has exited leaving its input
/// queue full (e.g. unread query replies), nothing will ever read that queue
/// and the blocking write would hang the dropping thread forever. The last
/// owner drops it only after the drainer has stopped reading and stdin writes
/// have ended, so switching the description to non-blocking here is
/// unobservable.
struct PtyWriter {
    inner: Option<Box<dyn Write + Send>>,
    /// Dup of the PTY master; `None` when the PTY exposes no fd.
    fd: Option<OwnedFd>,
}

impl Write for PtyWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.as_mut().expect("writer present until drop").write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.as_mut().expect("writer present until drop").flush()
    }
}

impl Drop for PtyWriter {
    fn drop(&mut self) {
        if let Some(fd) = &self.fd {
            if let Ok(flags) = fd_status_flags(fd.as_fd()) {
                let _ = set_fd_status_flags(fd.as_fd(), flags | libc::O_NONBLOCK);
            }
        }
        drop(self.inner.take());
    }
}

fn dup_master_fd(master: &dyn MasterPty) -> io::Result<Option<OwnedFd>> {
    master
        .as_raw_fd()
        // SAFETY: the master fd is open for the duration of this borrow.
        .map(|fd| unsafe { BorrowedFd::borrow_raw(fd) }.try_clone_to_owned())
        .transpose()
}

fn fd_status_flags(fd: BorrowedFd<'_>) -> io::Result<libc::c_int> {
    // SAFETY: `fd` is a live descriptor; F_GETFL only reads status flags.
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(flags)
}

fn set_fd_status_flags(fd: BorrowedFd<'_>, flags: libc::c_int) -> io::Result<()> {
    // SAFETY: `fd` is a live descriptor; F_SETFL only sets status flags.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn drain_reader<R: Read>(
    r: R,
    terminal: Arc<Mutex<TerminalState>>,
    seq: Arc<AtomicU64>,
    bus: Arc<OutputBus>,
    effects: DrainEffects,
) -> io::Result<()> {
    drain_reader_with_terminal(r, terminal, seq, bus, &effects)
}

fn drain_reader_with_terminal<R: Read, T: TerminalFeed>(
    mut r: R,
    terminal: Arc<Mutex<T>>,
    seq: Arc<AtomicU64>,
    bus: Arc<OutputBus>,
    effects: &DrainEffects,
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
                let reply = {
                    let mut term = terminal.lock().expect("terminal poisoned");
                    // A reaper timeout closes the bus while holding this same
                    // lock. Once forced closed, no later PTY bytes may advance
                    // terminal state or the final output watermark.
                    if bus.is_closed() {
                        break Ok(());
                    }
                    let (new_seq, outcome) = match term.try_feed_chunk(&data) {
                        Ok(outcome) => (seq.fetch_add(1, Ordering::SeqCst) + 1, outcome),
                        Err(error) => break Err(io::Error::other(error)),
                    };
                    // Under the terminal lock, so the reaper's exit update
                    // (same lock) can never be overwritten by a stale root.
                    if outcome.program_status_reported {
                        // The program that wrote the report may already be
                        // gone by the time the chunk is read; the group read
                        // here is then whoever owns the foreground now.
                        term.set_program_status_reporter(effects.foreground.group());
                    }
                    if outcome.program_status_changed {
                        effects.program_status.update(term.program_status_root());
                    }
                    if outcome.program_status_changed || outcome.program_status_reported {
                        effects.program_status.set_watching(term.watched_program_status_group().is_some());
                    }
                    // Publish before releasing the terminal lock. Atomic
                    // snapshot+subscribe takes the same terminal→bus order,
                    // so a chunk cannot be included in both snapshot and live.
                    // OSC 7501 bytes stay in the published chunk (replay and
                    // snapshot fidelity; viewers ignore the unknown OSC).
                    bus.publish(OutputChunk { seq: new_seq, data });
                    outcome.pty_reply
                };
                // Outside the terminal lock, and never waiting on a client
                // write (see `PtyInput`). The reply still precedes any
                // viewer's DA reply, which needs a full broker→browser→broker
                // round trip of the chunk just published.
                effects.input.send_reply(&reply);
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
    final_seq: u64,
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
            final_seq: Some(final_seq.to_string()),
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
    thread::Builder::new().name(name).stack_size(512 * 1024).spawn(f)
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ForcedSetupFailure {
    ReaderClone,
    WriterTake,
    MasterDup,
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
            ForcedSetupFailure::MasterDup => SpawnError::MasterDup("forced failure".into()),
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
    terminal: Arc<Mutex<TerminalState>>,
    output_bus: Arc<OutputBus>,
    seq: Arc<AtomicU64>,
    session_id: Uuid,
    events: EventSender,
    program_status: &ProgramStatusPublisher,
) {
    let exit = child.wait();
    let final_seq = if output_bus.wait_closed(EXIT_DRAIN_BARRIER_TIMEOUT) {
        seq.load(Ordering::SeqCst)
    } else {
        tracing::warn!(
            %session_id,
            "PTY output drainer did not close before exit barrier timeout; closing output bus"
        );
        // Serialize forced closure with terminal feed + sequence publication.
        // The drainer checks bus closure under this same lock before feeding.
        let _terminal = terminal.lock().expect("terminal poisoned");
        output_bus.close();
        seq.load(Ordering::SeqCst)
    };
    // The program is gone: its working/blocked/idle records no longer
    // describe anything; done/error records survive for the user to see.
    {
        let mut term = terminal.lock().expect("terminal poisoned");
        if term.drop_transient_program_status() {
            program_status.update(term.program_status_root());
        }
    }
    // Flush the final change ahead of `session_exited`.
    program_status.close();
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
            final_seq: Some(final_seq.to_string()),
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
        fn try_feed_chunk(&mut self, _data: &[u8]) -> Result<FeedOutcome, TerminalStateError> {
            Err(TerminalStateError::GhosttyLimit { operation: "feed" })
        }
    }

    /// PTY writer double that records what the drainer writes back.
    #[derive(Clone, Default)]
    struct CapturedWrites(Arc<Mutex<Vec<u8>>>);

    impl CapturedWrites {
        fn bytes(&self) -> Vec<u8> {
            self.0.lock().expect("captured writes").clone()
        }
    }

    impl Write for CapturedWrites {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().expect("captured writes").extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn test_drain_effects() -> (DrainEffects, CapturedWrites, broadcast::Receiver<Event>) {
        let writes = CapturedWrites::default();
        let (events, receiver) = broadcast::channel(16);
        let effects = DrainEffects {
            input: Arc::new(PtyInput::new(Uuid::nil(), Box::new(writes.clone()), None)),
            program_status: Arc::new(ProgramStatusPublisher::new(Uuid::nil(), events, Duration::from_secs(1), None)),
            foreground: Arc::new(ForegroundGroup::new(Uuid::nil(), None)),
        };
        (effects, writes, receiver)
    }

    /// Writer double whose writes wait until the test opens the gate.
    struct GatedWrites {
        captured: CapturedWrites,
        entered: std::sync::mpsc::Sender<()>,
        gate: Arc<(Mutex<bool>, Condvar)>,
        /// Bytes the program's input queue still accepts; `None` is unlimited.
        /// At zero a write fails with `WouldBlock`, like a full PTY queue.
        budget: Arc<Mutex<Option<usize>>>,
        /// Runs with the bytes of every write that passed the gate.
        on_write: Option<Box<dyn FnMut(&[u8]) + Send>>,
    }

    impl GatedWrites {
        fn new(captured: CapturedWrites, entered: std::sync::mpsc::Sender<()>, gate: Arc<(Mutex<bool>, Condvar)>) -> Self {
            Self { captured, entered, gate, budget: Arc::new(Mutex::new(None)), on_write: None }
        }
    }

    impl Write for GatedWrites {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let _ = self.entered.send(());
            let (open, opened) = &*self.gate;
            let mut open = open.lock().expect("gate");
            while !*open {
                open = opened.wait(open).expect("gate");
            }
            drop(open);
            let accepted = match *self.budget.lock().expect("budget") {
                Some(0) => return Err(io::ErrorKind::WouldBlock.into()),
                Some(ref mut budget) => {
                    let accepted = buf.len().min(*budget);
                    *budget -= accepted;
                    accepted
                }
                None => buf.len(),
            };
            if let Some(on_write) = self.on_write.as_mut() {
                on_write(&buf[..accepted]);
            }
            self.captured.write(&buf[..accepted])
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn open_gate(gate: &(Mutex<bool>, Condvar)) {
        *gate.0.lock().expect("gate") = true;
        gate.1.notify_all();
    }

    const QUERY_REPLY_BEL: &[u8] = b"\x1b]7501;?\x07";

    #[test]
    fn reply_sent_during_a_client_write_follows_it_without_waiting() {
        let captured = CapturedWrites::default();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let input = Arc::new(PtyInput::new(
            Uuid::nil(),
            Box::new(GatedWrites::new(captured.clone(), entered_tx, Arc::clone(&gate))),
            None,
        ));
        let client = Arc::clone(&input);
        let typing = thread::spawn(move || client.write_input(b"typed").expect("client write"));
        entered_rx.recv_timeout(Duration::from_secs(2)).expect("client write in flight");

        let started = std::time::Instant::now();
        input.send_reply(b"\x1b]7501;?\x07");
        assert!(started.elapsed() < Duration::from_millis(100), "reply waited for the client write");
        assert!(captured.bytes().is_empty());

        open_gate(&gate);
        typing.join().expect("client thread");
        assert_eq!(captured.bytes(), b"typed\x1b]7501;?\x07", "queued reply follows the client write");

        // With the writer free, a reply is written immediately.
        input.send_reply(b"\x1b]7501;?\x1b\\");
        assert_eq!(captured.bytes(), b"typed\x1b]7501;?\x07\x1b]7501;?\x1b\\");
    }

    #[test]
    fn replies_beyond_the_pending_bound_are_dropped_whole() {
        let captured = CapturedWrites::default();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let input = Arc::new(PtyInput::new(
            Uuid::nil(),
            Box::new(GatedWrites::new(captured.clone(), entered_tx, Arc::clone(&gate))),
            None,
        ));
        let client = Arc::clone(&input);
        let typing = thread::spawn(move || client.write_input(b"typed").expect("client write"));
        entered_rx.recv_timeout(Duration::from_secs(2)).expect("client write in flight");

        // The program floods queries while the client write holds the writer.
        let fits = MAX_PENDING_REPLY_BYTES / QUERY_REPLY_BEL.len();
        for _ in 0..fits + 5 {
            input.send_reply(QUERY_REPLY_BEL);
        }
        open_gate(&gate);
        typing.join().expect("client thread");

        let mut expected = b"typed".to_vec();
        for _ in 0..fits {
            expected.extend_from_slice(QUERY_REPLY_BEL);
        }
        assert!(fits * QUERY_REPLY_BEL.len() <= MAX_PENDING_REPLY_BYTES);
        assert_eq!(captured.bytes(), expected, "exactly the replies within the bound, each whole");
        assert!(input.pending_replies.lock().expect("pending").is_empty(), "nothing left queued");
    }

    #[test]
    fn partially_written_reply_is_completed_before_the_next_client_input() {
        let captured = CapturedWrites::default();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let writes = GatedWrites::new(captured.clone(), entered_tx, Arc::clone(&gate));
        let budget = Arc::clone(&writes.budget);
        let input = Arc::new(PtyInput::new(Uuid::nil(), Box::new(writes), None));
        let client = Arc::clone(&input);
        let typing = thread::spawn(move || client.write_input(b"typed").expect("client write"));
        entered_rx.recv_timeout(Duration::from_secs(2)).expect("client write in flight");

        // Two replies queue behind the client write. The program's input queue
        // then takes the client's 5 bytes and only 5 bytes of the reply batch.
        input.send_reply(QUERY_REPLY_BEL);
        input.send_reply(b"\x1b]7501;?\x1b\\");
        *budget.lock().expect("budget") = Some(b"typed".len() + 5);
        open_gate(&gate);
        typing.join().expect("client thread");
        assert_eq!(captured.bytes(), b"typed\x1b]750", "the queue accepted a partial first reply");

        // The program reads again. Its parser is inside an OSC, so the cut
        // reply's tail must land before any further client input; the whole
        // second reply did not fit and is dropped, as the protocol allows.
        *budget.lock().expect("budget") = None;
        input.write_input(b"more").expect("client write");
        assert_eq!(captured.bytes(), b"typed\x1b]7501;?\x07more");
        assert!(input.pending_replies.lock().expect("pending").is_empty());
    }

    #[test]
    fn requeued_tail_evicts_whole_replies_to_keep_the_bound() {
        let captured = CapturedWrites::default();
        let input = PtyInput::new(Uuid::nil(), Box::new(captured.clone()), None);
        // Hold the writer like an in-flight client write so replies queue.
        let writer = input.writer.lock().expect("writer");
        let fits = MAX_PENDING_REPLY_BYTES / QUERY_REPLY_BEL.len();
        for _ in 0..fits {
            input.send_reply(QUERY_REPLY_BEL);
        }
        assert_eq!(input.pending_replies.lock().expect("pending").whole.len(), fits);

        // A batch holding one reply was cut after its ESC: the 8-byte tail
        // does not fit beside the queue, so one whole reply makes room.
        let mut cut = PendingReplies::default();
        cut.whole.push(QUERY_REPLY_BEL.to_vec());
        input.requeue_cut_reply(&cut, 1);
        {
            let pending = input.pending_replies.lock().expect("pending");
            assert_eq!(pending.tail, QUERY_REPLY_BEL[1..].to_vec());
            assert_eq!(pending.whole.len(), fits - 1, "one whole reply dropped, never half");
            assert!(pending.bytes() <= MAX_PENDING_REPLY_BYTES);
        }

        drop(writer);
        input.write_input(b"more").expect("client write");
        let mut expected = QUERY_REPLY_BEL[1..].to_vec();
        for _ in 0..fits - 1 {
            expected.extend_from_slice(QUERY_REPLY_BEL);
        }
        expected.extend_from_slice(b"more");
        assert_eq!(captured.bytes(), expected, "tail first, then whole replies, then the client input");
    }

    #[test]
    fn reply_queued_after_the_in_lock_flush_is_written_right_after_unlock() {
        let captured = CapturedWrites::default();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let mut writes = GatedWrites::new(captured.clone(), entered_tx, Arc::clone(&gate));
        // Reached once the client's in-lock flush writes the first reply: the
        // pending queue has been taken but the client still holds the writer.
        // A reply arriving now can only be flushed by the post-unlock re-check.
        let late_sender: Arc<Mutex<Option<std::sync::Weak<PtyInput>>>> = Arc::new(Mutex::new(None));
        let hook_sender = Arc::clone(&late_sender);
        writes.on_write = Some(Box::new(move |buf: &[u8]| {
            if !buf.starts_with(b"\x1b") {
                return;
            }
            if let Some(input) = hook_sender.lock().expect("late sender").take().and_then(|weak| weak.upgrade()) {
                input.send_reply(b"\x1b]7501;?\x1b\\");
            }
        }));
        let input = Arc::new(PtyInput::new(Uuid::nil(), Box::new(writes), None));
        *late_sender.lock().expect("late sender") = Some(Arc::downgrade(&input));

        let client = Arc::clone(&input);
        let typing = thread::spawn(move || client.write_input(b"typed").expect("client write"));
        entered_rx.recv_timeout(Duration::from_secs(2)).expect("client write in flight");
        input.send_reply(QUERY_REPLY_BEL);
        open_gate(&gate);
        typing.join().expect("client thread");

        assert_eq!(
            captured.bytes(),
            b"typed\x1b]7501;?\x07\x1b]7501;?\x1b\\",
            "reply queued between the in-lock flush and unlock was stranded"
        );
        assert!(input.pending_replies.lock().expect("pending").is_empty());
    }

    struct ChunkReader {
        chunks: std::collections::VecDeque<&'static [u8]>,
    }

    impl Read for ChunkReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let Some(chunk) = self.chunks.pop_front() else {
                return Ok(0);
            };
            buf[..chunk.len()].copy_from_slice(chunk);
            Ok(chunk.len())
        }
    }

    #[test]
    fn drainer_writes_only_the_program_status_reply_back_to_the_pty() {
        let terminal = Arc::new(Mutex::new(TerminalState::try_new(80, 24).expect("terminal init")));
        let bus = OutputBus::with_defaults();
        let (effects, writes, _events) = test_drain_effects();
        // The emitters' probe: 7501 query then DA1; plus DSR and XTVERSION.
        let probe: &'static [u8] = b"\x1b]7501;?\x1b\\\x1b[c\x1b[6n\x1b[>q";
        drain_reader_with_terminal(
            ChunkReader { chunks: [probe].into() },
            terminal,
            Arc::new(AtomicU64::new(0)),
            Arc::clone(&bus),
            &effects,
        )
        .expect("drain");

        assert_eq!(writes.bytes(), b"\x1b]7501;?\x1b\\");
        // Byte fidelity: the query stays in the published output stream.
        let replay = bus.subscribe(Some(0)).replay;
        assert_eq!(replay.iter().flat_map(|chunk| chunk.data.iter().copied()).collect::<Vec<_>>(), probe);
    }

    #[test]
    fn drainer_writes_nothing_for_device_attribute_and_status_queries() {
        let terminal = Arc::new(Mutex::new(TerminalState::try_new(80, 24).expect("terminal init")));
        let (effects, writes, mut events) = test_drain_effects();
        drain_reader_with_terminal(
            ChunkReader { chunks: [&b"\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[>q\x1b[?1$p"[..]].into() },
            terminal,
            Arc::new(AtomicU64::new(0)),
            OutputBus::with_defaults(),
            &effects,
        )
        .expect("drain");

        assert!(writes.bytes().is_empty(), "broker must not answer: {:?}", writes.bytes());
        effects.program_status.close();
        assert!(events.try_recv().is_err(), "no program status event without a report");
    }

    #[test]
    fn drainer_publishes_record_changes_ending_on_the_latest_root() {
        let terminal = Arc::new(Mutex::new(TerminalState::try_new(80, 24).expect("terminal init")));
        let (effects, writes, mut events) = test_drain_effects();
        drain_reader_with_terminal(
            ChunkReader {
                chunks: [
                    &b"\x1b]7501;state=working\x07\x1b]7501;state=blocked:kind=question\x07"[..],
                    // Unchanged report: not a change.
                    b"\x1b]7501;state=blocked:kind=question\x07",
                    b"\x1b]7501;state=clear\x07",
                ]
                .into(),
            },
            terminal,
            Arc::new(AtomicU64::new(0)),
            OutputBus::with_defaults(),
            &effects,
        )
        .expect("drain");
        assert_eq!(effects.program_status.root(), None, "the cached root follows every chunk");
        effects.program_status.close();

        let mut roots = Vec::new();
        while let Ok(event) = events.try_recv() {
            match event {
                Event::ProgramStatusChanged { program_status, .. } => roots.push(program_status),
                other => panic!("unexpected {other:?}"),
            }
        }
        // Paced: the leading event saw whichever root was current when the
        // pacer ran; the clear is always the final event.
        assert!(matches!(roots.as_slice(), [None] | [Some(_), None]), "{roots:?}");
        if let [Some(root), None] = roots.as_slice() {
            assert_eq!(root.state, crate::protocol::ProgramStatusState::Blocked);
            assert_eq!(root.kind, Some(crate::protocol::ProgramStatusKind::Question));
        }
        assert!(writes.bytes().is_empty(), "reports are never echoed");
    }

    fn record(state: crate::protocol::ProgramStatusState) -> Option<ProgramStatusRecord> {
        Some(ProgramStatusRecord {
            id: String::new(),
            state,
            kind: None,
            progress: None,
            app: None,
            title: None,
            message: None,
            updated_at_ms: 0,
        })
    }

    fn next_root(events: &mut broadcast::Receiver<Event>, within: Duration) -> Option<Option<crate::protocol::ProgramStatusState>> {
        let deadline = std::time::Instant::now() + within;
        loop {
            match events.try_recv() {
                Ok(Event::ProgramStatusChanged { program_status, .. }) => {
                    return Some(program_status.map(|record| record.state))
                }
                Ok(other) => panic!("unexpected {other:?}"),
                Err(_) if std::time::Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                Err(_) => return None,
            }
        }
    }

    #[test]
    fn publisher_sends_the_first_change_at_once_and_coalesces_the_rest_to_the_latest() {
        use crate::protocol::ProgramStatusState::{Blocked, Done, Working};
        let (events, mut rx) = broadcast::channel(16);
        let publisher = ProgramStatusPublisher::new(Uuid::nil(), events, Duration::from_millis(400), None);

        publisher.update(record(Working));
        assert_eq!(next_root(&mut rx, Duration::from_millis(150)), Some(Some(Working)), "leading edge");
        publisher.update(record(Blocked));
        publisher.update(record(Done));
        assert_eq!(publisher.root().map(|record| record.state), Some(Done));
        assert_eq!(next_root(&mut rx, Duration::from_millis(150)), None, "held for the interval");
        assert_eq!(next_root(&mut rx, Duration::from_secs(1)), Some(Some(Done)), "trailing edge carries the latest");
        assert_eq!(next_root(&mut rx, Duration::from_millis(500)), None, "one trailing event");

        // A change held by the interval flushes promptly on close; afterwards
        // updates go out at once.
        publisher.update(record(Working));
        assert_eq!(next_root(&mut rx, Duration::from_millis(150)), Some(Some(Working)));
        publisher.update(record(Blocked));
        publisher.close();
        assert_eq!(next_root(&mut rx, Duration::from_millis(50)), Some(Some(Blocked)), "flushed on close");
        publisher.update(None);
        assert_eq!(next_root(&mut rx, Duration::from_millis(50)), Some(None));
    }

    #[derive(Default)]
    struct CountingTerminal {
        feed_count: usize,
    }

    impl TerminalFeed for CountingTerminal {
        fn try_feed_chunk(&mut self, _data: &[u8]) -> Result<FeedOutcome, TerminalStateError> {
            self.feed_count += 1;
            Ok(FeedOutcome::default())
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
        let mut receiver = bus.subscribe(None).receiver;
        let waiter_bus = Arc::clone(&bus);
        let waiter = thread::spawn(move || waiter_bus.wait_closed(Duration::from_millis(200)));

        let (effects, _writes, _events) = test_drain_effects();
        let error = drain_reader_with_terminal(
            OneChunkReader {
                chunk: Some(b"failed chunk"),
            },
            terminal,
            Arc::clone(&seq),
            Arc::clone(&bus),
            &effects,
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
    fn drainer_discards_output_after_forced_close_without_advancing_sequence() {
        let terminal = Arc::new(Mutex::new(CountingTerminal::default()));
        let seq = Arc::new(AtomicU64::new(7));
        let bus = OutputBus::new(4, 4);
        bus.publish(OutputChunk {
            seq: 7,
            data: Arc::new(b"retained chunk".to_vec()),
        });
        bus.close();

        let (effects, _writes, _events) = test_drain_effects();
        drain_reader_with_terminal(
            OneChunkReader {
                chunk: Some(b"late chunk"),
            },
            Arc::clone(&terminal),
            Arc::clone(&seq),
            Arc::clone(&bus),
            &effects,
        )
        .expect("forced close should terminate the drainer cleanly");

        assert_eq!(terminal.lock().expect("terminal").feed_count, 0);
        assert_eq!(seq.load(Ordering::SeqCst), 7);
        assert_eq!(bus.current_seq(), 7);
        assert_eq!(
            bus.subscribe(Some(0))
                .replay
                .iter()
                .map(|chunk| chunk.seq)
                .collect::<Vec<_>>(),
            vec![7],
        );
    }

    #[test]
    fn drainer_propagates_read_failure_after_closing_output() {
        let terminal = Arc::new(Mutex::new(
            TerminalState::try_new(80, 24).expect("terminal init"),
        ));
        let seq = Arc::new(AtomicU64::new(0));
        let bus = OutputBus::with_defaults();

        let (effects, _writes, _events) = test_drain_effects();
        let error = drain_reader(FailingReader, terminal, seq, Arc::clone(&bus), effects)
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

        assert!(mark_pty_read_failed(&inner, id, &error, &events, 7));
        assert!(!mark_pty_read_failed(&inner, id, &error, &events, 7));

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
                final_seq: Some(final_seq),
            }) if session_id == id && final_seq == "7"
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
        let info = sess.info();
        assert_eq!(info.cols, 80);
        assert_eq!(info.rows, 24);
        assert!(info.alive);

        // Cleanup so the test doesn't leak a sleep process.
        let _ = sess.kill(libc::SIGKILL);
        assert!(sess.wait_for_exit(Duration::from_secs(5)));
    }

    #[test]
    fn spawn_injects_its_own_uuid_and_overrides_supplied_identity() {
        let mut previous = None;
        for _ in 0..2 {
            let mut options = opts(vec!["/bin/sh", "-c", "printf '%s' \"$WOLFPACK_SESSION_ID\""]);
            options.env = vec![
                ("WOLFPACK_SESSION_ID".into(), "parent-session-id".into()),
                ("WOLFPACK_SESSION_ID".into(), "caller-override".into()),
            ];
            let session = spawn_session(options).expect("spawn");
            assert!(session.output_bus().wait_closed(Duration::from_secs(5)));
            assert!(session.wait_for_exit(Duration::from_secs(5)));
            let info = session.info();
            let id = info.id.to_string();
            assert_ne!(previous.as_ref(), Some(&id));
            assert_eq!(
                info.env
                    .iter()
                    .filter(|(key, _)| key == "WOLFPACK_SESSION_ID")
                    .map(|(_, value)| value.as_str())
                    .collect::<Vec<_>>(),
                vec![id.as_str()]
            );
            let snapshot = session.snapshot_terminal(None, None).expect("snapshot");
            assert!(
                screen_contains(&snapshot, &id),
                "child must receive its own broker UUID"
            );
            assert!(!screen_contains(&snapshot, "caller-override"));
            previous = Some(id);
        }
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
            ForcedSetupFailure::MasterDup,
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
                        | SpawnError::MasterDup(_)
                        | SpawnError::ThreadSpawn(_)
                ),
                "{failure:?}: {err:?}"
            );
            if failure == ForcedSetupFailure::MasterDup {
                assert!(matches!(err, SpawnError::MasterDup(_)), "{err:?}");
                assert!(err.to_string().starts_with("PTY master fd duplication failed"), "{err}");
            }
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
        line.cells.iter().map(|c| c.ch.as_ref()).collect()
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
    fn styled_conversion_runs_without_terminal_lock() {
        for subscribe in [false, true] {
            let sess = spawn_session(opts(vec!["printf", "styled"])).expect("spawn");
            assert!(sess.output_bus().wait_closed(Duration::from_secs(5)));
            // The reaper briefly locks the terminal after the bus closes to
            // drop transient program status records; wait it out so the probe
            // only sees snapshot-path locking.
            assert!(sess.wait_for_exit(Duration::from_secs(5)));
            let terminal = Arc::clone(&sess.terminal);
            let observed = Arc::new(AtomicU64::new(0));
            let probe_observed = Arc::clone(&observed);
            crate::terminal_state::CONVERSION_PROBE.with(|probe| {
                *probe.borrow_mut() = Some(Box::new(move || {
                    assert!(terminal.try_lock().is_ok(), "styled conversion holds terminal lock");
                    probe_observed.fetch_add(1, Ordering::SeqCst);
                }));
            });
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if subscribe {
                    sess.snapshot_and_subscribe(None, Some(40)).expect("snapshot subscribe");
                } else {
                    sess.snapshot_terminal(None, Some(40)).expect("snapshot");
                }
            }));
            crate::terminal_state::CONVERSION_PROBE.with(|probe| *probe.borrow_mut() = None);
            assert!(result.is_ok(), "conversion must release terminal lock");
            assert!(observed.load(Ordering::SeqCst) > 0, "probe must exercise real conversion");
        }
    }

    #[test]
    fn output_advances_during_materialization_and_atomic_subscription_retains_it() {
        let sess = spawn_session(opts(vec!["cat"])).expect("spawn");
        let mut observer = sess.output_bus().subscribe(None);
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
        let marker = b"POST-CAPTURE";
        let (snapshot, mut sub) = sess.capture_and_materialize(None, None,
            |seq| sess.bus.subscribe(Some(seq)),
            |raw| {
                // This is the actual materialization boundary, not a delay:
                // require the real PTY drainer to publish before allowing
                // conversion to finish. Holding the terminal lock deadlocks.
                sess.write_stdin(b"POST-CAPTURE\n").expect("input");
                runtime.block_on(async {
                    tokio::time::timeout(Duration::from_secs(5), async {
                        let mut bytes = Vec::new();
                        loop {
                            let chunk = observer.receiver.recv().await.expect("live output");
                            bytes.extend_from_slice(&chunk.data);
                            if bytes.windows(marker.len()).any(|w| w == marker) {
                                break;
                            }
                        }
                    }).await
                }).expect("drainer blocked during materialization");
                raw.materialize()
            }).expect("snapshot and subscription");
        assert!(!screen_contains(&snapshot, "POST-CAPTURE"));
        assert_eq!(sub.current_seq, snapshot.seq);
        runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(5), async {
                let mut bytes = Vec::new();
                loop {
                    let chunk = sub.receiver.recv().await.expect("atomic live output");
                    assert!(chunk.seq > snapshot.seq);
                    bytes.extend_from_slice(&chunk.data);
                    if bytes.windows(marker.len()).any(|w| w == marker) {
                        break;
                    }
                }
            }).await
        }).expect("post-capture bytes lost");
        let _ = sess.kill(libc::SIGKILL);
        assert!(sess.wait_for_exit(Duration::from_secs(5)));
    }

    #[test]
    fn resize_during_materialization_cannot_repopulate_stale_cache() {
        let (events, _) = broadcast::channel(16);
        let sess = spawn_session(opts(vec!["sleep", "30"])).expect("spawn");
        let (before, ()) = sess.capture_and_materialize(None, None, |_| (), |raw| {
            sess.resize(132, 50, &events).expect("resize during conversion");
            raw.materialize()
        }).expect("captured snapshot");
        assert_eq!((before.cols, before.rows), (80, 24));
        assert!(sess.snapshot_cache.lock().expect("snapshot cache poisoned").is_none());
        let after = sess.snapshot_terminal(None, None).expect("post-resize snapshot");
        assert_eq!(after.seq, before.seq, "resize does not advance output seq");
        assert_eq!((after.cols, after.rows), (132, 50));
        let repeated = sess.snapshot_terminal(None, None).expect("cache hit");
        assert!(Arc::ptr_eq(&after, &repeated));
        let _ = sess.kill(libc::SIGKILL);
        assert!(sess.wait_for_exit(Duration::from_secs(5)));
    }

    #[test]
    fn repeated_snapshot_key_reuses_immutable_cache_without_deep_copying() {
        let sess = spawn_session(opts(vec!["printf", "cached"])).expect("spawn");
        assert!(sess.output_bus().wait_closed(Duration::from_secs(5)));
        let first = sess.snapshot_terminal(Some(10), Some(80)).expect("snapshot");
        let second = sess.snapshot_terminal(Some(10), Some(80)).expect("cached snapshot");
        assert!(Arc::ptr_eq(&first, &second), "cache hit must share the snapshot graph");
        let cache = sess.snapshot_cache.lock().expect("snapshot cache poisoned");
        let cached = cache.as_ref().expect("snapshot should be cached");
        assert!(Arc::ptr_eq(&first, &cached.snapshot));
        assert_eq!(cached.seq, first.seq);
        assert_eq!(cached.scrollback_lines, Some(10));
        assert_eq!(cached.target_cols, Some(80));
        drop(cache);

        // A caller can opt into copy-on-write without mutating the cache or a
        // future response. The ordinary cache-hit path above remains shared.
        let mut caller_copy = Arc::clone(&second);
        Arc::make_mut(&mut caller_copy).title = Some("caller-local".into());
        assert!(!Arc::ptr_eq(&second, &caller_copy));
        assert_ne!(second.title.as_deref(), Some("caller-local"));
        assert_eq!(caller_copy.title.as_deref(), Some("caller-local"));

        // One-entry replacement releases the old graph as soon as no caller
        // retains it; callers that still hold an Arc remain valid by design.
        let old = Arc::downgrade(&second);
        drop(first);
        drop(second);
        drop(caller_copy);
        let replacement = sess.snapshot_terminal(Some(9), Some(80)).expect("different key materializes replacement");
        assert!(old.upgrade().is_none(), "replaced cache must not retain old graph");
        assert_eq!(sess.snapshot_cache.lock().expect("snapshot cache poisoned").as_ref().unwrap().seq, replacement.seq);
    }

    #[test]
    fn new_output_replaces_cache_and_releases_unheld_old_snapshot() {
        let sess = spawn_session(opts(vec!["cat"])).expect("spawn");
        sess.write_stdin(b"FIRST\\n").expect("write first marker");
        wait_for_bus_quiet(&sess, Duration::from_millis(100), Duration::from_secs(5));
        let first = sess.snapshot_terminal(None, None).expect("first snapshot");
        let first_seq = first.seq;
        let old = Arc::downgrade(&first);
        drop(first);

        sess.write_stdin(b"SECOND\\n").expect("write second marker");
        wait_for_bus_quiet(&sess, Duration::from_millis(100), Duration::from_secs(5));
        let second = sess.snapshot_terminal(None, None).expect("second snapshot");
        assert!(second.seq > first_seq, "new terminal output must advance the cache key");
        assert!(old.upgrade().is_none(), "new cache entry must release unheld prior graph");

        let _ = sess.kill(libc::SIGKILL);
        let _ = sess.wait_for_exit(Duration::from_secs(5));
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
    fn session_info_exposes_output_sequence_without_materializing_snapshot() {
        let sess = spawn_session(opts(vec!["printf", "abc"])).expect("spawn");
        assert!(sess.output_bus().wait_closed(Duration::from_secs(5)));
        let _ = sess.wait_for_exit(Duration::from_secs(5));

        let info = sess.info();
        let output_seq = info.output_seq.expect("new broker session info must include output_seq");
        assert_ne!(output_seq, "0", "session info must expose ingested PTY output");
        assert_eq!(output_seq, sess.output_bus().current_seq().to_string());
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
            resize_terminal_pty_and_state(&inner, id, &mut pty, &terminal, 132, 50, &events, || {})
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
    fn resize_pty_failure_rolls_terminal_back_without_invalidating_cached_snapshot() {
        let id = Uuid::new_v4();
        let inner = resize_test_state(id);
        let (events, mut receiver) = broadcast::channel(4);
        let mut pty = RecordingPtyResize {
            fail: true,
            ..RecordingPtyResize::default()
        };
        let terminal = Mutex::new(RecordingTerminalResize::new(80, 24));
        let cached = Arc::new(Snapshot {
            session_id: id,
            seq: 0,
            cols: 80,
            rows: 24,
            visible_screen: vec![],
            scrollback: vec![],
            cursor: Default::default(),
            modes: Default::default(),
            scroll_region: Default::default(),
            title: None,
            captured_at_ms: 0,
        });
        let cache = Mutex::new(Some(Arc::clone(&cached)));
        let cached_weak = Arc::downgrade(&cached);
        drop(cached);

        let error = resize_terminal_pty_and_state(
            &inner,
            id,
            &mut pty,
            &terminal,
            132,
            50,
            &events,
            || *cache.lock().expect("snapshot cache poisoned") = None,
        )
        .expect_err("PTY resize failure must abort transaction");

        assert!(matches!(error, ResizeError::Pty(_)));
        assert!(cached_weak.upgrade().is_some(), "failed resize must retain valid cache");
        assert!(cache.lock().expect("snapshot cache poisoned").is_some());
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
            resize_terminal_pty_and_state(&inner, id, &mut pty, &terminal, 132, 50, &events, || {})
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
        let stale = sess.snapshot_terminal(None, None).expect("snapshot before resize");
        let stale_weak = Arc::downgrade(&stale);
        drop(stale);

        sess.resize(132, 50, &test_events()).expect("resize ok");
        assert!(stale_weak.upgrade().is_none(), "successful resize must release cache ownership");

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
            .subscribe(Some(prefill_seq));

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

    /// Runs `probe` in a raw-mode PTY, then prints whatever stdin delivered
    /// within one second as hex: `reply=[<hex>]`.
    fn pty_reply_to(probe: &str) -> String {
        let script = format!(
            "stty raw -echo min 0 time 10; printf '{probe}'; \
             r=$(dd bs=64 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n'); \
             stty sane; printf 'reply=[%s]\\n' \"$r\""
        );
        let sess = spawn_session(opts(vec!["sh", "-c", &script])).expect("spawn");
        assert!(sess.output_bus().wait_closed(Duration::from_secs(10)));
        assert!(sess.wait_for_exit(Duration::from_secs(5)));
        let snap = sess.snapshot_terminal(None, None).expect("snapshot");
        snap.visible_screen
            .iter()
            .map(line_text)
            .find(|line| line.contains("reply=["))
            .unwrap_or_else(|| panic!("no reply line: {:?}", snap.visible_screen.iter().map(line_text).collect::<Vec<_>>()))
            .trim()
            .to_string()
    }

    #[test]
    fn broker_answers_the_program_status_query_on_a_real_pty() {
        // ESC ] 7501 ; ? ESC \ written back by the broker, with no viewer.
        assert_eq!(pty_reply_to("\\033]7501;?\\033\\\\"), "reply=[1b5d373530313b3f1b5c]");
        assert_eq!(pty_reply_to("\\033]7501;?\\007"), "reply=[1b5d373530313b3f07]");
    }

    #[test]
    fn broker_does_not_answer_device_attributes_on_a_real_pty() {
        assert_eq!(pty_reply_to("\\033[c\\033[6n"), "reply=[]");
    }

    #[test]
    fn query_flood_without_reading_stdin_does_not_wedge_the_session() {
        // Replies fill the PTY input queue the raw-mode program never reads;
        // a blocking reply write would stall the drainer and, with stdout
        // undrained, the program itself.
        let sess = spawn_session(opts(vec![
            "sh",
            "-c",
            "stty raw -echo; i=0; while [ $i -lt 20000 ]; do printf '\\033]7501;?\\007'; i=$((i+1)); done; \
             stty sane; echo FLOOD-DONE",
        ]))
        .expect("spawn");
        let exited = sess.wait_for_exit(Duration::from_secs(20));
        if !exited {
            let _ = sess.kill(libc::SIGKILL);
        }
        assert!(exited, "query flood wedged the session");
        assert!(sess.output_bus().wait_closed(Duration::from_secs(5)));
        let snap = sess.snapshot_terminal(None, None).expect("snapshot");
        assert!(screen_contains(&snap, "FLOOD-DONE"));

        // The unread replies are still queued; dropping the session (its
        // writer sends `\n` + VEOF) must not block on them.
        let (dropped_tx, dropped_rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            drop(sess);
            let _ = dropped_tx.send(());
        });
        assert!(
            dropped_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "session drop blocked on the PTY"
        );
    }

    #[test]
    fn query_reply_does_not_wait_behind_a_blocked_stdin_write() {
        // The program stops reading stdin, a client write fills the input
        // queue and blocks holding the writer, then the program queries. The
        // drainer must keep draining output instead of waiting for the writer.
        // Once told to (the go file), the program reads again: it consumes
        // the client's bytes and the queued reply, and prints the reply with
        // its ESC and BEL replaced so the check cannot match the query itself.
        const CLIENT_BYTES: usize = 1 << 20;
        let go = std::env::temp_dir().join(format!("wolfpack-blocked-stdin-{}", Uuid::new_v4()));
        let program = format!(
            "stty raw -echo; sleep 1; printf '\\033]7501;?\\007'; sleep 0.5; echo AFTER-QUERY; \
             while [ ! -e '{}' ]; do sleep 0.05; done; \
             head -c {} | tr -d x | tr '\\033\\007' 'E~'; echo; echo REPLY-DONE; sleep 5",
            go.display(),
            CLIENT_BYTES + QUERY_REPLY_BEL.len()
        );
        let sess = Arc::new(spawn_session(opts(vec!["sh", "-c", &program])).expect("spawn"));
        // Raw mode first: canonical mode discards overflow instead of blocking.
        thread::sleep(Duration::from_millis(400));
        let writer = Arc::clone(&sess);
        let blocked_write = thread::spawn(move || {
            let _ = writer.write_stdin(&vec![b'x'; CLIENT_BYTES]);
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let drained = loop {
            let snap = sess.snapshot_terminal(None, None).expect("snapshot");
            if screen_contains(&snap, "AFTER-QUERY") {
                break true;
            }
            if std::time::Instant::now() >= deadline {
                break false;
            }
            thread::sleep(Duration::from_millis(50));
        };
        assert!(!blocked_write.is_finished(), "stdin write was expected to block");
        assert!(drained, "drainer stalled behind the blocked stdin write");

        // The program drains stdin: the client write completes and the reply
        // it held back follows it into the PTY.
        std::fs::write(&go, b"").expect("go file");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let replied = loop {
            let snap = sess.snapshot_terminal(None, None).expect("snapshot");
            if screen_contains(&snap, "REPLY-DONE") {
                break screen_contains(&snap, "E]7501;?~");
            }
            if std::time::Instant::now() >= deadline {
                break false;
            }
            thread::sleep(Duration::from_millis(50));
        };
        let _ = sess.kill(libc::SIGKILL);
        let _ = std::fs::remove_file(&go);
        blocked_write.join().expect("client write thread");
        assert!(replied, "queued query reply never reached the program");
        let _ = sess.wait_for_exit(Duration::from_secs(5));
    }

    #[test]
    fn info_does_not_wait_for_the_terminal_lock() {
        let sess = Arc::new(
            Session::spawn(
                opts(vec!["sh", "-c", "printf '\\033]7501;state=working\\007'; sleep 5"]),
                test_events(),
            )
            .expect("spawn"),
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while sess.info().program_status.is_none() {
            assert!(std::time::Instant::now() < deadline, "root record never reported");
            std::thread::sleep(Duration::from_millis(20));
        }
        // list_sessions builds one info() per session: it must not queue
        // behind a long terminal feed or snapshot capture.
        let held = sess.terminal.lock().expect("terminal");
        let (tx, rx) = std::sync::mpsc::channel();
        let reader = Arc::clone(&sess);
        thread::spawn(move || {
            let _ = tx.send(reader.info().program_status.map(|record| record.state));
        });
        let state = rx.recv_timeout(Duration::from_secs(2));
        drop(held);
        assert_eq!(
            state.expect("info() blocked on the terminal lock"),
            Some(crate::protocol::ProgramStatusState::Working)
        );
        let _ = sess.kill(libc::SIGKILL);
        let _ = sess.wait_for_exit(Duration::from_secs(5));
    }

    #[test]
    fn program_status_flood_is_paced_and_ends_on_the_latest_state() {
        let events = test_events();
        let mut rx = events.subscribe();
        let started = std::time::Instant::now();
        let sess = Session::spawn(
            opts(vec![
                "sh",
                "-c",
                "i=0; while [ $i -lt 3000 ]; do \
                 printf '\\033]7501;state=working:progress=%d\\007' $((i % 100)); i=$((i+1)); done; \
                 printf '\\033]7501;state=blocked:kind=question\\007'; sleep 1",
            ]),
            events,
        )
        .expect("spawn");
        assert!(sess.wait_for_exit(Duration::from_secs(20)));
        let elapsed = started.elapsed();
        let mut changes = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let Event::ProgramStatusChanged { program_status, .. } = event {
                changes.push(program_status);
            }
        }
        // At most one event per pacing interval (plus the leading edge and
        // the exit flush), however fast the program reports.
        let bound = (elapsed.as_millis() / PROGRAM_STATUS_EVENT_INTERVAL.as_millis()) as usize + 3;
        assert!(changes.len() <= bound, "{} events in {elapsed:?} (bound {bound})", changes.len());
        // The latest state is always delivered: blocked, then exit drops it.
        let blocked = changes
            .iter()
            .rposition(|change| matches!(change, Some(record) if record.state == crate::protocol::ProgramStatusState::Blocked))
            .expect("final blocked report was delivered");
        assert_eq!(changes.len(), blocked + 2, "only the exit change follows: {changes:?}");
        assert_eq!(changes.last(), Some(&None));
    }

    #[test]
    fn session_info_carries_the_root_record_and_exit_drops_live_records() {
        let events = test_events();
        let mut rx = events.subscribe();
        let sess = Session::spawn(
            opts(vec![
                "sh",
                "-c",
                "printf '\\033]7501;state=done:id=build\\007\\033]7501;state=blocked:kind=permission\\007'; sleep 1",
            ]),
            events,
        )
        .expect("spawn");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let root = loop {
            if let Some(root) = sess.info().program_status {
                break root;
            }
            assert!(std::time::Instant::now() < deadline, "root record never reported");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(root.state, crate::protocol::ProgramStatusState::Blocked);
        assert_eq!(sess.program_status_records().len(), 2);

        assert!(sess.wait_for_exit(Duration::from_secs(5)));
        assert!(sess.info().program_status.is_none(), "exit drops the blocked root");
        let remaining: Vec<String> = sess.program_status_records().into_iter().map(|record| record.id).collect();
        assert_eq!(remaining, vec!["build"], "done records survive exit");

        let mut changes = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let Event::ProgramStatusChanged { program_status, .. } = event {
                changes.push(program_status.map(|record| record.state));
            }
        }
        assert_eq!(changes.last(), Some(&None), "exit publishes the cleared root: {changes:?}");
    }

    #[test]
    fn reporter_left_foreground_only_on_a_readable_change_or_a_vanished_group() {
        let exists = |_| true;
        assert!(!reporter_left_foreground(10, Some(10), exists), "same group keeps");
        assert!(reporter_left_foreground(10, Some(11), exists), "another foreground group drops");
        assert!(reporter_left_foreground(10, Some(10), |_| false), "a vanished group drops");
        assert!(!reporter_left_foreground(10, None, exists), "unreadable foreground keeps");
        assert!(!reporter_left_foreground(10, None, |_| false), "unreadable foreground keeps");
    }

    fn ids_of(term: &TerminalState) -> Vec<String> {
        term.program_status_records().into_iter().map(|record| record.id).collect()
    }

    #[test]
    fn foreground_check_drops_working_and_blocked_and_keeps_done_and_error() {
        let mut term = TerminalState::try_new(80, 24).expect("real terminal");
        term.try_feed(
            b"\x1b]7501;state=done:id=d\x07\x1b]7501;state=error:id=e\x07\
              \x1b]7501;state=blocked:id=b\x07\x1b]7501;state=working\x07",
        )
        .expect("feed");
        term.set_program_status_reporter(Some(10));

        assert!(!drop_if_reporter_left(&mut term, Some(10), |_| true), "same group");
        assert!(!drop_if_reporter_left(&mut term, None, |_| true), "unreadable foreground");
        assert_eq!(ids_of(&term), vec!["", "b", "d", "e"]);

        assert!(drop_if_reporter_left(&mut term, Some(11), |_| true));
        assert_eq!(ids_of(&term), vec!["d", "e"]);
        assert!(term.program_status_root().is_none());
        assert!(!drop_if_reporter_left(&mut term, Some(12), |_| false), "nothing left to watch");
    }

    #[test]
    fn foreground_check_ignores_records_whose_reporter_group_was_unreadable() {
        let mut term = TerminalState::try_new(80, 24).expect("real terminal");
        term.try_feed(b"\x1b]7501;state=working\x07").expect("feed");
        term.set_program_status_reporter(None);
        assert!(!drop_if_reporter_left(&mut term, Some(11), |_| false));
        assert_eq!(ids_of(&term), vec![""]);
    }

    fn foreground_checks(sess: &Session) -> u64 {
        sess.program_status.watch.as_ref().expect("session watch").checks.load(Ordering::SeqCst)
    }

    fn wait_until(what: &str, within: Duration, mut done: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + within;
        while !done() {
            assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// A job-control shell runs the reporter in its own foreground group; the
    /// reporter dies by SIGKILL (no clear, no exit of the PTY leader, no OSC
    /// 133), the shell takes the foreground back, and the live record goes.
    #[test]
    fn killed_foreground_reporter_under_a_job_control_shell_drops_live_records() {
        let mut o = opts(vec!["bash", "--norc", "--noprofile", "-i"]);
        o.env = vec![
            ("PS1".into(), "$ ".into()),
            ("BASH_SILENCE_DEPRECATION_WARNING".into(), "1".into()),
        ];
        let events = test_events();
        let mut rx = events.subscribe();
        let sess = Session::spawn(o, events).expect("spawn");
        let shell_group = sess.pid().expect("shell pid") as libc::pid_t;
        let foreground = || sess.program_status.watch.as_ref().expect("session watch").foreground.group();
        wait_until("the shell to own the foreground", Duration::from_secs(5), || foreground() == Some(shell_group));

        // A done record alone (reported by the shell itself) needs no checks.
        sess.write_stdin(b"printf '\\033]7501;state=done:id=d\\007'\n").expect("write");
        wait_until("the done record", Duration::from_secs(5), || !sess.program_status_records().is_empty());
        std::thread::sleep(FOREGROUND_CHECK_INTERVAL * 2 + Duration::from_millis(100));
        assert_eq!(foreground_checks(&sess), 0, "no working/blocked record: no foreground checks");

        sess.write_stdin(b"sh -c \"printf '\\033]7501;state=working\\007'; exec sleep 30\"\n").expect("write");
        wait_until("the working root", Duration::from_secs(5), || sess.info().program_status.is_some());
        let reporter = foreground().expect("readable foreground group");
        assert_ne!(reporter, shell_group, "job control runs the reporter in its own group");

        // Its group keeps the foreground: checks run and keep the record.
        wait_until("a foreground check", FOREGROUND_CHECK_INTERVAL * 3, || foreground_checks(&sess) > 0);
        assert_eq!(
            sess.info().program_status.map(|record| record.state),
            Some(crate::protocol::ProgramStatusState::Working)
        );

        // SAFETY: signals only the reporter's own process group.
        assert_eq!(unsafe { libc::kill(-reporter, libc::SIGKILL) }, 0);
        let killed = std::time::Instant::now();
        wait_until("the working root to drop", Duration::from_secs(5), || sess.info().program_status.is_none());
        let latency = killed.elapsed();
        assert!(latency <= FOREGROUND_CHECK_INTERVAL * 2, "dropped {latency:?} after the kill");
        assert_eq!(ids_of(&sess.terminal.lock().expect("terminal")), vec!["d"], "done survives");
        assert!(sess.alive(), "the shell (PTY leader) is still running");
        // Published like any other change (paced), while the shell lives on.
        let mut last = None;
        wait_until("the cleared root event", PROGRAM_STATUS_EVENT_INTERVAL * 3, || {
            while let Ok(event) = rx.try_recv() {
                if let Event::ProgramStatusChanged { program_status, .. } = event {
                    last = Some(program_status);
                }
            }
            last == Some(None)
        });

        let _ = sess.kill(libc::SIGKILL);
        assert!(sess.wait_for_exit(Duration::from_secs(5)));
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
