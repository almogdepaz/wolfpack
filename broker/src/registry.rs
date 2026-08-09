//! In-memory session registry.
//!
//! `Registry` owns every live `Session` the broker has spawned and enforces
//! name uniqueness. Sessions are addressed by UUID; the secondary name map
//! exists purely so `create_session` can reject duplicate names and so the
//! anonymous-name generator can skip collisions.
//!
//! Session creation reserves the name under the registry mutex, releases the
//! mutex while `Session::spawn` performs PTY/process setup, then replaces the
//! reservation with the live session id. Concurrent creators observe the
//! reservation as occupied without serializing unrelated process creation.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use thiserror::Error;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::protocol::Event;
use crate::session::{EventSender, Session, SpawnError, SpawnOptions};

#[derive(Debug, Clone)]
pub struct CreateOptions {
    pub name: Option<String>,
    pub cwd: String,
    pub command: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Error)]
pub enum CreateError {
    #[error("session name {0:?} already in use")]
    DuplicateName(String),
    #[error("spawn failed: {0}")]
    Spawn(#[from] SpawnError),
}

const EXITED_TOMBSTONE_TTL: Duration = Duration::from_secs(30);
const MAX_EXITED_TOMBSTONES: usize = 64;
pub(crate) const MAX_CONCURRENT_SNAPSHOTS: usize = 4;
pub(crate) const SNAPSHOT_CONCURRENCY_LIMIT_MESSAGE: &str =
    "snapshot concurrency limit reached; retry";

pub(crate) struct SnapshotPermit<'a>(&'a AtomicUsize);

impl Drop for SnapshotPermit<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Release);
    }
}

struct Tombstone {
    session: Arc<Session>,
    expires_at: Instant,
}

#[derive(Default)]
struct Inner {
    sessions: BTreeMap<Uuid, Arc<Session>>,
    tombstones: BTreeMap<Uuid, Tombstone>,
    names: BTreeMap<String, Uuid>,
    /// Monotonic counter for anonymous "session-N" names. Never decrements,
    /// even when collisions skip values, so a killed session's slot is not
    /// silently reused.
    next_anon: u64,
}

impl Inner {
    fn purge_expired_tombstones(&mut self) {
        let now = Instant::now();
        self.tombstones.retain(|_, tombstone| tombstone.expires_at > now);
        while self.tombstones.len() > MAX_EXITED_TOMBSTONES {
            let Some(oldest) = self.tombstones
                .iter()
                .min_by_key(|(_, tombstone)| tombstone.expires_at)
                .map(|(id, _)| *id)
            else { break };
            self.tombstones.remove(&oldest);
        }
    }
}

pub struct Registry {
    inner: Mutex<Inner>,
    events: EventSender,
    snapshots_in_flight: AtomicUsize,
}

impl Registry {
    pub fn new(events: EventSender) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            events,
            snapshots_in_flight: AtomicUsize::new(0),
        }
    }

    pub(crate) fn try_acquire_snapshot(&self) -> Option<SnapshotPermit<'_>> {
        let previous = self.snapshots_in_flight.fetch_add(1, Ordering::Acquire);
        if previous >= MAX_CONCURRENT_SNAPSHOTS {
            self.snapshots_in_flight.fetch_sub(1, Ordering::Release);
            return None;
        }
        Some(SnapshotPermit(&self.snapshots_in_flight))
    }

    pub fn create(&self, opts: CreateOptions) -> Result<Arc<Session>, CreateError> {
        // Reserve the name atomically, then release the registry lock before
        // openpty/spawn/thread setup. Concurrent creates see the reservation
        // as occupied without serialising unrelated process creation.
        let (name, reservation_id) = {
            let mut guard = self.inner.lock().expect("registry poisoned");
            let inner = &mut *guard;
            inner.purge_expired_tombstones();
            let name = resolve_name(opts.name.as_deref(), &inner.names, &mut inner.next_anon)?;
            let reservation_id = Uuid::new_v4();
            inner.names.insert(name.clone(), reservation_id);
            (name, reservation_id)
        };
        let spawn_opts = SpawnOptions {
            name: name.clone(),
            cwd: opts.cwd,
            command: opts.command,
            env: opts.env,
            cols: opts.cols,
            rows: opts.rows,
        };
        let session = match Session::spawn(spawn_opts, self.events.clone()) {
            Ok(session) => Arc::new(session),
            Err(error) => {
                let mut inner = self.inner.lock().expect("registry poisoned");
                if inner.names.get(&name) == Some(&reservation_id) {
                    inner.names.remove(&name);
                }
                return Err(CreateError::Spawn(error));
            }
        };
        let id = session.id();
        {
            let mut inner = self.inner.lock().expect("registry poisoned");
            debug_assert_eq!(inner.names.get(&name), Some(&reservation_id));
            inner.sessions.insert(id, Arc::clone(&session));
            inner.names.insert(name, id);
        }
        // Publish AFTER releasing the registry lock so a slow subscriber can
        // never stall registry mutations. Best-effort: an Err means no one
        // is currently subscribed.
        let _ = self.events.send(Event::SessionStarted {
            session: session.info(),
        });
        Ok(session)
    }

    pub fn get(&self, id: Uuid) -> Option<Arc<Session>> {
        let mut inner = self.inner.lock().expect("registry poisoned");
        inner.purge_expired_tombstones();
        inner.sessions.get(&id).cloned()
            .or_else(|| inner.tombstones.get(&id).map(|tombstone| Arc::clone(&tombstone.session)))
    }

    pub fn list(&self) -> Vec<Arc<Session>> {
        let inner = self.inner.lock().expect("registry poisoned");
        inner.sessions.values().cloned().collect()
    }

    pub fn count(&self) -> usize {
        let inner = self.inner.lock().expect("registry poisoned");
        inner.sessions.len()
    }

    /// Drop a session entry whose process has exited. Frees the name slot so
    /// the same name can be reused by a future `create`. The anonymous-name
    /// counter is intentionally NOT rewound — `next_anon` stays monotonic so a
    /// killed session-N's slot is not silently reused.
    ///
    /// Called by the reaper task spawned via [`spawn_exit_reaper`]; safe to
    /// call repeatedly with the same id (no-op after the first call).
    pub fn reap(&self, id: Uuid) {
        let mut guard = self.inner.lock().expect("registry poisoned");
        let inner = &mut *guard;
        let Some(session) = inner.sessions.remove(&id) else {
            return;
        };
        let name = session.snapshot().name;
        if inner.names.get(&name) == Some(&id) {
            inner.names.remove(&name);
        }
        inner.tombstones.insert(id, Tombstone {
            session,
            expires_at: Instant::now() + EXITED_TOMBSTONE_TTL,
        });
        inner.purge_expired_tombstones();
    }
}

/// Subscribe to `SessionExited` events and call `Registry::reap` for each.
/// Holds a `Weak<Registry>` so the task self-terminates when the registry is
/// dropped. On `Lagged`, fall back to an authoritative sweep: walk the
/// registry and reap any session whose process has already exited. Without
/// this, a dropped exit event would pin the session in the registry forever
/// (SessionExited fires once per session, so the next event for that id
/// never arrives).
pub fn spawn_exit_reaper(registry: &Arc<Registry>) {
    let weak: Weak<Registry> = Arc::downgrade(registry);
    let mut rx = registry.events.subscribe();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(Event::SessionExited { session_id, .. }) => {
                    let Some(reg) = weak.upgrade() else { break };
                    reg.reap(session_id);
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        lagged = n,
                        "exit reaper lagged events; sweeping registry for dead sessions"
                    );
                    let Some(reg) = weak.upgrade() else { break };
                    let dead: Vec<Uuid> = reg
                        .list()
                        .into_iter()
                        .filter(|s| !s.alive())
                        .map(|s| s.id())
                        .collect();
                    for id in dead {
                        reg.reap(id);
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Pure name resolver. If `requested` is `Some(name)`, validate uniqueness; if
/// `None`, generate `session-N` by incrementing `next_anon` until an unused
/// slot is found. The counter advances past collisions so subsequent calls
/// don't keep re-probing the same gaps.
fn resolve_name(
    requested: Option<&str>,
    names: &BTreeMap<String, Uuid>,
    next_anon: &mut u64,
) -> Result<String, CreateError> {
    if let Some(name) = requested {
        if names.contains_key(name) {
            return Err(CreateError::DuplicateName(name.to_string()));
        }
        return Ok(name.to_string());
    }
    loop {
        *next_anon += 1;
        let candidate = format!("session-{}", next_anon);
        if !names.contains_key(&candidate) {
            return Ok(candidate);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::broadcast;

    fn test_events() -> EventSender {
        broadcast::channel::<Event>(64).0
    }

    fn map_with(names: &[(&str, Uuid)]) -> BTreeMap<String, Uuid> {
        names
            .iter()
            .map(|(n, id)| ((*n).to_string(), *id))
            .collect()
    }

    #[test]
    fn resolve_name_anonymous_on_empty_map_returns_session_1() {
        let names = BTreeMap::new();
        let mut counter = 0u64;
        let resolved = resolve_name(None, &names, &mut counter).expect("resolve");
        assert_eq!(resolved, "session-1");
        assert_eq!(counter, 1);
    }

    #[test]
    fn resolve_name_duplicate_named_errors() {
        let id = Uuid::new_v4();
        let names = map_with(&[("foo", id)]);
        let mut counter = 0u64;
        let err = resolve_name(Some("foo"), &names, &mut counter).expect_err("duplicate must err");
        match err {
            CreateError::DuplicateName(n) => assert_eq!(n, "foo"),
            other => panic!("unexpected error: {other:?}"),
        }
        assert_eq!(counter, 0, "duplicate must not advance the anon counter");
    }

    #[test]
    fn resolve_name_named_unique_succeeds() {
        let names = map_with(&[("alpha", Uuid::new_v4())]);
        let mut counter = 0u64;
        let resolved = resolve_name(Some("beta"), &names, &mut counter).expect("resolve");
        assert_eq!(resolved, "beta");
        assert_eq!(counter, 0, "named resolves must not bump the anon counter");
    }

    #[test]
    fn resolve_name_anonymous_increments_across_calls() {
        let names = BTreeMap::new();
        let mut counter = 0u64;
        let a = resolve_name(None, &names, &mut counter).expect("first");
        let b = resolve_name(None, &names, &mut counter).expect("second");
        assert_eq!(a, "session-1");
        assert_eq!(b, "session-2");
        assert_eq!(counter, 2);
    }

    #[test]
    fn resolve_name_anonymous_skips_existing_collisions() {
        let names = map_with(&[
            ("session-1", Uuid::new_v4()),
            ("session-2", Uuid::new_v4()),
        ]);
        let mut counter = 0u64;
        let resolved = resolve_name(None, &names, &mut counter).expect("resolve");
        assert_eq!(resolved, "session-3");
        assert_eq!(
            counter, 3,
            "counter must advance past skipped collisions, not stay at the gap"
        );
    }

    fn create_opts(name: Option<&str>, cmd: &[&str]) -> CreateOptions {
        CreateOptions {
            name: name.map(String::from),
            cwd: "/tmp".into(),
            command: cmd.iter().map(|s| (*s).to_string()).collect(),
            env: vec![],
            cols: 80,
            rows: 24,
        }
    }

    fn cleanup(sess: &Session) {
        let _ = sess.kill(libc::SIGKILL);
        let _ = sess.wait_for_exit(Duration::from_secs(5));
    }

    #[test]
    fn registry_create_two_sessions_lists_both_and_rejects_duplicate_name() {
        let reg = Registry::new(test_events());
        assert_eq!(reg.count(), 0);
        assert!(reg.list().is_empty());

        let sess_a = reg
            .create(create_opts(Some("alpha"), &["sleep", "30"]))
            .expect("create alpha");
        let sess_b = reg
            .create(create_opts(None, &["sleep", "30"]))
            .expect("create anonymous");

        assert_eq!(reg.count(), 2);
        let listed = reg.list();
        assert_eq!(listed.len(), 2);
        let listed_ids: Vec<Uuid> = listed.iter().map(|s| s.id()).collect();
        assert!(listed_ids.contains(&sess_a.id()));
        assert!(listed_ids.contains(&sess_b.id()));

        let by_id = reg.get(sess_a.id()).expect("get by id");
        assert_eq!(by_id.id(), sess_a.id());
        assert!(reg.get(Uuid::nil()).is_none());

        let snap_a = sess_a.snapshot();
        let snap_b = sess_b.snapshot();
        assert_eq!(snap_a.name, "alpha");
        assert_eq!(snap_b.name, "session-1");

        let dup = reg
            .create(create_opts(Some("alpha"), &["sleep", "30"]))
            .expect_err("duplicate name must error");
        match dup {
            CreateError::DuplicateName(n) => assert_eq!(n, "alpha"),
            other => panic!("unexpected error: {other:?}"),
        }
        assert_eq!(reg.count(), 2, "failed create must not change the registry");

        cleanup(&sess_a);
        cleanup(&sess_b);
    }

    #[test]
    fn create_publishes_session_started_event() {
        let events = test_events();
        let mut rx = events.subscribe();
        let reg = Registry::new(events);
        let sess = reg
            .create(create_opts(Some("started-target"), &["sleep", "30"]))
            .expect("create");

        // The send happens inline in `create`, so by the time create
        // returns the event is queued. try_recv must succeed without
        // a wait.
        match rx.try_recv() {
            Ok(Event::SessionStarted { session }) => {
                assert_eq!(session.id, sess.id());
                assert_eq!(session.name, "started-target");
            }
            other => panic!("expected SessionStarted, got {other:?}"),
        }

        cleanup(&sess);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exited_session_frees_its_name_for_recreate() {
        let events = test_events();
        let reg = Arc::new(Registry::new(events));
        spawn_exit_reaper(&reg);

        // Use `true` so the child exits immediately and the reaper publishes
        // SessionExited without us having to send a signal.
        let sess = reg
            .create(create_opts(Some("ghost"), &["true"]))
            .expect("create ghost");
        let id = sess.id();
        assert!(sess.wait_for_exit(Duration::from_secs(5)), "child must exit");
        drop(sess);

        // The reaper removes the session from the live list and name map but
        // retains a bounded by-id tombstone for final output replay.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if reg.list().iter().all(|session| session.id() != id) {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "reaper did not tombstone exited session");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(reg.get(id).is_some(), "exited session should remain replayable by id");

        // Name slot must be free — recreating with the same name must succeed.
        let sess2 = reg
            .create(create_opts(Some("ghost"), &["sleep", "30"]))
            .expect("recreate after reap");
        assert_eq!(sess2.snapshot().name, "ghost");
        cleanup(&sess2);
    }
}
