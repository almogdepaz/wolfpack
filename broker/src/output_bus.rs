//! Per-session live-output fanout primitive.
//!
//! `OutputBus` couples a small ring buffer (for `since_seq` replay) with a
//! `tokio::sync::broadcast` channel (for live fanout to attached subscribers).
//! The drainer thread owns publishing; subscriptions atomically capture both
//! a replay snapshot of the ring and a live receiver under a single lock so
//! no chunk is ever observed twice and no chunk in flight is silently
//! dropped between snapshot-time and receiver-attach.
//!
//! Closure: when the drainer exits (PTY EOF) it calls `close()`, which
//! drops the inner broadcast sender and signals any thread blocked on
//! `wait_closed()`. This is the canonical "drainer is done, every byte the
//! child produced has been ingested" handshake — used by tests to
//! synchronise on snapshot inspection without sleep loops.
//!
//! Lagged subscribers: tokio's broadcast channel returns `RecvError::Lagged`
//! when a slow receiver falls more than `broadcast_capacity` chunks behind.
//! Callers are expected to recover by re-querying the ring with the last
//! seq they observed (or by hitting `snapshot` for a hard re-sync). The bus
//! itself does not paper over lag — it surfaces it.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use tokio::sync::broadcast;

use crate::ring_buffer::{OutputChunk, RingBuffer};

/// Default per-session retention: 256 chunks. Sized to comfortably absorb
/// a one-second burst from a chatty TUI at 8KB per chunk while keeping
/// per-session memory bounded.
pub const DEFAULT_RING_CAPACITY: usize = 256;
pub const DEFAULT_RING_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Default live broadcast lag tolerance (chunks). A subscriber that falls
/// further behind than this surfaces `Lagged` and must recover via the ring
/// or a fresh snapshot.
pub const DEFAULT_BROADCAST_CAPACITY: usize = 256;

pub struct OutputBus {
    /// Live fanout. Held inside an `Option` so `close()` can drop the
    /// sender (which signals "no more publishes" to every attached
    /// receiver via `RecvError::Closed`).
    sender: Mutex<Option<broadcast::Sender<OutputChunk>>>,
    /// Replay ring. Locked together with `sender` on subscribe so a new
    /// subscriber atomically observes a consistent (replay snapshot,
    /// live receiver) pair without missing or duplicating chunks.
    ring: Mutex<RingBuffer>,
    /// Last published seq, or 0 if nothing has been published yet. Read
    /// by `subscribe` to populate `current_seq` in the protocol response.
    last_seq: AtomicU64,
    /// Set to true by `close()`. `wait_closed()` returns once observed.
    closed: AtomicBool,
    closed_signal: (Mutex<()>, Condvar),
}

impl std::fmt::Debug for OutputBus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutputBus")
            .field("last_seq", &self.last_seq.load(Ordering::Relaxed))
            .field("closed", &self.closed.load(Ordering::Relaxed))
            .finish()
    }
}

/// Snapshot returned by `OutputBus::subscribe` so callers can stitch the
/// replay slice in front of the live broadcast without any extra
/// synchronisation.
pub struct Subscription {
    /// Chunks already in the ring whose seq satisfies the caller's
    /// `since_seq`. Empty when the caller passed `None` for `since_seq`.
    pub replay: Vec<OutputChunk>,
    /// Live receiver. Attached BEFORE the lock was released, so every
    /// chunk published after this call lands here.
    pub receiver: broadcast::Receiver<OutputChunk>,
    /// Seq value at the moment of subscription. Populates the
    /// `subscribe` response's `current_seq` field.
    pub current_seq: u64,
    /// True when the caller asked for `since_seq = S` but the ring's
    /// oldest retained chunk has a seq > S — some bytes were evicted
    /// before this subscribe arrived and the ring cannot replay the gap.
    /// The client should treat this as a signal to re-snapshot before
    /// consuming the replayed + live stream.
    pub replay_truncated: bool,
}

impl OutputBus {
    pub fn new(ring_capacity: usize, broadcast_capacity: usize) -> Arc<Self> {
        Self::new_with_byte_limit(ring_capacity, DEFAULT_RING_MAX_BYTES, broadcast_capacity)
    }

    pub fn new_with_byte_limit(ring_capacity: usize, ring_max_bytes: usize, broadcast_capacity: usize) -> Arc<Self> {
        let (tx, _rx) = broadcast::channel(broadcast_capacity);
        Arc::new(Self {
            sender: Mutex::new(Some(tx)),
            ring: Mutex::new(RingBuffer::with_limits(ring_capacity, ring_max_bytes)),
            last_seq: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            closed_signal: (Mutex::new(()), Condvar::new()),
        })
    }

    pub fn with_defaults() -> Arc<Self> {
        Self::new(DEFAULT_RING_CAPACITY, DEFAULT_BROADCAST_CAPACITY)
    }

    /// Append a chunk to the ring AND broadcast it to live subscribers.
    /// Holding the sender lock across both keeps subscribe atomic with
    /// publish: a subscribe call interleaved with a publish either sees
    /// the chunk in its replay slice OR on its live receiver, never both
    /// and never neither. Chunks published after closure are ignored.
    pub fn publish(&self, chunk: OutputChunk) {
        let sender_guard = self.sender.lock().expect("output bus sender poisoned");
        let Some(tx) = sender_guard.as_ref() else {
            return;
        };
        let mut ring = self.ring.lock().expect("output bus ring poisoned");
        ring.push(chunk.clone());
        self.last_seq.store(chunk.seq, Ordering::SeqCst);
        // Err means no receivers; that's fine — bytes are still in the ring
        // for future subscribers.
        let _ = tx.send(chunk);
    }

    /// Atomically capture replay + live receiver + current_seq. After the
    /// lock is released, every newly published chunk arrives on the
    /// receiver. A closed bus still returns its retained replay plus an
    /// already-closed receiver so bounded exited-session tombstones can drain
    /// their final output without pretending a live stream remains.
    pub fn subscribe(&self, since_seq: Option<u64>) -> Subscription {
        let sender_guard = self.sender.lock().expect("output bus sender poisoned");
        let receiver = if let Some(tx) = sender_guard.as_ref() {
            tx.subscribe()
        } else {
            let (closed_tx, closed_rx) = broadcast::channel(1);
            drop(closed_tx);
            closed_rx
        };
        let ring = self.ring.lock().expect("output bus ring poisoned");
        let (replay, replay_truncated) = match since_seq {
            Some(s) => {
                let chunks = ring.replay_since(s);
                // If the caller asked for seq S and the ring's earliest chunk
                // has a seq > S+1, some chunks were evicted — the replay is
                // a truncated window, not the complete gap.
                let truncated = ring
                    .earliest_seq()
                    .map_or(false, |earliest| earliest > s.saturating_add(1));
                (chunks, truncated)
            }
            None => (Vec::new(), false),
        };
        let current_seq = self.last_seq.load(Ordering::SeqCst);
        Subscription {
            replay,
            receiver,
            current_seq,
            replay_truncated,
        }
    }

    pub fn current_seq(&self) -> u64 {
        self.last_seq.load(Ordering::SeqCst)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Called by the drainer when the PTY reader hits EOF. Drops the
    /// broadcast sender (so attached receivers see `Closed`) and wakes
    /// any thread blocked in `wait_closed`.
    pub fn close(&self) {
        {
            let mut sender_guard = self.sender.lock().expect("output bus sender poisoned");
            *sender_guard = None;
        }
        self.closed.store(true, Ordering::SeqCst);
        let (lock, cvar) = &self.closed_signal;
        let _g = lock.lock().expect("output bus close signal poisoned");
        cvar.notify_all();
    }

    /// Block (sync) up to `timeout` for `close()` to be observed. Returns
    /// true if the bus is closed by the time we return. Used by sync tests
    /// to synchronise on "drainer fully ingested every byte" before
    /// inspecting snapshot state.
    pub fn wait_closed(&self, timeout: Duration) -> bool {
        if self.closed.load(Ordering::SeqCst) {
            return true;
        }
        let (lock, cvar) = &self.closed_signal;
        let guard = lock.lock().expect("output bus close signal poisoned");
        let (_g, _to) = cvar
            .wait_timeout_while(guard, timeout, |_| !self.closed.load(Ordering::SeqCst))
            .expect("output bus close signal poisoned");
        self.closed.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(seq: u64, data: &[u8]) -> OutputChunk {
        OutputChunk {
            seq,
            data: Arc::new(data.to_vec()),
        }
    }

    #[tokio::test]
    async fn publish_then_subscribe_with_since_seq_replays_missing() {
        let bus = OutputBus::new(8, 8);
        bus.publish(chunk(1, b"a"));
        bus.publish(chunk(2, b"b"));
        bus.publish(chunk(3, b"c"));

        let sub = bus.subscribe(Some(1));
        let replay_seqs: Vec<u64> = sub.replay.iter().map(|c| c.seq).collect();
        assert_eq!(replay_seqs, vec![2, 3]);
        assert_eq!(sub.current_seq, 3);
    }

    #[test]
    fn subscribe_after_ring_eviction_reports_truncated_replay() {
        let bus = OutputBus::new(2, 8);
        bus.publish(chunk(1, b"a"));
        bus.publish(chunk(2, b"b"));
        bus.publish(chunk(3, b"c"));

        let sub = bus.subscribe(Some(0));
        let replay_seqs: Vec<u64> = sub.replay.iter().map(|chunk| chunk.seq).collect();
        assert!(sub.replay_truncated);
        assert_eq!(replay_seqs, vec![2, 3]);
        assert_eq!(sub.current_seq, 3);
    }

    #[tokio::test]
    async fn live_publish_after_subscribe_arrives_on_receiver() {
        let bus = OutputBus::new(8, 8);
        let sub = bus.subscribe(None);
        let mut rx = sub.receiver;

        bus.publish(chunk(1, b"hello"));

        let got = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("recv timeout")
            .expect("recv ok");
        assert_eq!(got.seq, 1);
        assert_eq!(&*got.data, b"hello");
    }

    #[tokio::test]
    async fn subscribe_after_close_returns_retained_replay_then_closed() {
        let bus = OutputBus::new(4, 4);
        bus.publish(chunk(1, b"x"));
        bus.close();
        let mut sub: Subscription = bus.subscribe(Some(0));
        assert_eq!(sub.replay.iter().map(|chunk| chunk.seq).collect::<Vec<_>>(), vec![1]);
        assert!(sub.receiver.recv().await.is_err());
        assert!(bus.is_closed());
    }

    #[test]
    fn publish_after_close_preserves_replay_and_watermark() {
        let bus = OutputBus::new(4, 4);
        bus.publish(chunk(1, b"before"));
        bus.close();

        bus.publish(chunk(2, b"after"));

        let sub = bus.subscribe(Some(0));
        assert_eq!(
            sub.replay.iter().map(|chunk| chunk.seq).collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(sub.current_seq, 1);
    }

    #[tokio::test]
    async fn close_drops_sender_so_active_receivers_see_closed() {
        let bus = OutputBus::new(4, 4);
        let mut rx = bus.subscribe(None).receiver;
        bus.close();
        let res = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("recv timeout");
        assert!(matches!(res, Err(broadcast::error::RecvError::Closed)));
    }

    #[test]
    fn wait_closed_returns_immediately_after_close() {
        let bus = OutputBus::new(2, 2);
        bus.close();
        assert!(bus.wait_closed(Duration::from_millis(100)));
    }

    #[test]
    fn wait_closed_blocks_until_close_is_called_from_another_thread() {
        let bus = OutputBus::new(2, 2);
        let bus_clone = Arc::clone(&bus);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            bus_clone.close();
        });
        assert!(bus.wait_closed(Duration::from_secs(2)));
    }
}
