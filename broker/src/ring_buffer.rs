//! Bounded ring buffer of `(seq, Arc<bytes>)` chunks for output replay.
//!
//! Each session owns one ring. The drainer pushes every PTY chunk it
//! produces; subscribers asking for `since_seq = N` walk the ring and
//! collect every retained chunk whose seq is greater than `N` so the
//! client receives the missed slice before live broadcast catches up.
//!
//! When `cap` chunks are already retained, the next push evicts the
//! oldest entry. Callers that ask for a `since_seq` older than the
//! buffer's earliest retained seq simply receive whatever the ring still
//! holds. `OutputBus::subscribe` detects that gap and reports it as
//! `replay_truncated`, so its caller can request a fresh snapshot.
//!
//! Bytes are wrapped in `Arc<Vec<u8>>` so that pushing into the ring,
//! broadcasting to live subscribers, and replaying to a new subscriber
//! all share the same allocation.

use std::collections::VecDeque;
use std::sync::Arc;

/// One chunk of PTY output identified by its broker-assigned seq.
#[derive(Debug, Clone)]
pub struct OutputChunk {
    /// Monotonic per-session seq assigned at publish time. Starts at 1.
    pub seq: u64,
    /// Raw PTY bytes, shared across ring/live/replay paths.
    pub data: Arc<Vec<u8>>,
}

/// Capacity-limited FIFO of recent `OutputChunk`s.
#[derive(Debug)]
pub struct RingBuffer {
    cap: usize,
    chunks: VecDeque<OutputChunk>,
}

impl RingBuffer {
    pub fn new(cap: usize) -> Self {
        assert!(cap > 0, "ring buffer capacity must be > 0");
        Self {
            cap,
            chunks: VecDeque::with_capacity(cap),
        }
    }

    pub fn push(&mut self, chunk: OutputChunk) {
        if self.chunks.len() == self.cap {
            self.chunks.pop_front();
        }
        self.chunks.push_back(chunk);
    }

    /// Collect every retained chunk whose `seq > since_seq`.
    pub fn replay_since(&self, since_seq: u64) -> Vec<OutputChunk> {
        self.chunks
            .iter()
            .filter(|c| c.seq > since_seq)
            .cloned()
            .collect()
    }

    pub fn earliest_seq(&self) -> Option<u64> {
        self.chunks.front().map(|c| c.seq)
    }

    pub fn latest_seq(&self) -> Option<u64> {
        self.chunks.back().map(|c| c.seq)
    }

    pub fn len(&self) -> usize {
        self.chunks.len()
    }

    pub fn capacity(&self) -> usize {
        self.cap
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

    #[test]
    fn push_until_full_keeps_all_entries() {
        let mut r = RingBuffer::new(3);
        r.push(chunk(1, b"a"));
        r.push(chunk(2, b"b"));
        r.push(chunk(3, b"c"));
        assert_eq!(r.len(), 3);
        assert_eq!(r.earliest_seq(), Some(1));
        assert_eq!(r.latest_seq(), Some(3));
    }

    #[test]
    fn push_past_capacity_evicts_oldest() {
        let mut r = RingBuffer::new(2);
        r.push(chunk(1, b"a"));
        r.push(chunk(2, b"b"));
        r.push(chunk(3, b"c"));
        assert_eq!(r.len(), 2);
        assert_eq!(r.earliest_seq(), Some(2));
        assert_eq!(r.latest_seq(), Some(3));
    }

    #[test]
    fn replay_since_returns_strictly_later_chunks() {
        let mut r = RingBuffer::new(4);
        for i in 1..=4 {
            r.push(chunk(i, &[i as u8]));
        }
        let got = r.replay_since(2);
        let seqs: Vec<u64> = got.iter().map(|c| c.seq).collect();
        assert_eq!(seqs, vec![3, 4]);
    }

    #[test]
    fn replay_since_zero_returns_everything_retained() {
        let mut r = RingBuffer::new(3);
        for i in 1..=3 {
            r.push(chunk(i, &[i as u8]));
        }
        let seqs: Vec<u64> = r.replay_since(0).iter().map(|c| c.seq).collect();
        assert_eq!(seqs, vec![1, 2, 3]);
    }

    #[test]
    fn replay_since_after_eviction_only_returns_retained_window() {
        let mut r = RingBuffer::new(2);
        for i in 1..=5 {
            r.push(chunk(i, &[i as u8]));
        }
        // Caller asks for seq=1 onward; ring only retains 4..=5.
        let seqs: Vec<u64> = r.replay_since(1).iter().map(|c| c.seq).collect();
        assert_eq!(seqs, vec![4, 5]);
    }

    #[test]
    fn replay_since_above_latest_returns_empty() {
        let mut r = RingBuffer::new(3);
        r.push(chunk(1, b"a"));
        r.push(chunk(2, b"b"));
        assert!(r.replay_since(2).is_empty());
        assert!(r.replay_since(99).is_empty());
    }

    #[test]
    #[should_panic]
    fn zero_capacity_is_rejected() {
        let _ = RingBuffer::new(0);
    }
}
