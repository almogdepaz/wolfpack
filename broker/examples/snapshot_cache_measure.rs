//! Bounded snapshot-cache allocation/scaling harness.
//!
//! This exercises `Session::snapshot_terminal` rather than measuring an
//! isolated `Arc::clone`: each sample feeds real 120-column terminal history,
//! measures fixture construction, cold terminal materialization plus cache
//! insertion, a production cache hit, and serialization of the returned
//! snapshot. Requested allocator bytes and calls are process-heap requests
//! only; they are neither RSS nor RPC latency measurements.
//!
//! Run against this checkout (with a verified native bundle):
//!
//! ```text
//! CARGO_TARGET_DIR=/private/target cargo run --locked --manifest-path broker/Cargo.toml \
//!   --example snapshot_cache_measure
//! ```
//!
//! For a base comparison, export the desired base commit to a separate plain
//! directory, copy this harness and the same verified bundle into that export,
//! and run the identical command with a separate target. This keeps the
//! measured cache/materialization path and native inputs identical while the
//! prior implementation's deep cache clones remain in effect.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use tokio::sync::broadcast;
use wolfpack_broker::protocol::Event;
use wolfpack_broker::session::{Session, SpawnOptions};

struct CountingAllocator;

static TRACK_ALLOCATIONS: AtomicBool = AtomicBool::new(false);
static ALLOCATION_CALLS: AtomicU64 = AtomicU64::new(0);
static ALLOCATION_BYTES: AtomicU64 = AtomicU64::new(0);

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forwards the exact layout supplied by the allocator caller.
        let allocation = unsafe { System.alloc(layout) };
        if TRACK_ALLOCATIONS.load(Ordering::Relaxed) && !allocation.is_null() {
            ALLOCATION_CALLS.fetch_add(1, Ordering::Relaxed);
            ALLOCATION_BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        }
        allocation
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forwards the exact layout supplied by the allocator caller.
        let allocation = unsafe { System.alloc_zeroed(layout) };
        if TRACK_ALLOCATIONS.load(Ordering::Relaxed) && !allocation.is_null() {
            ALLOCATION_CALLS.fetch_add(1, Ordering::Relaxed);
            ALLOCATION_BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        }
        allocation
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: forwards the exact pointer/layout/new size supplied by the
        // allocator caller.
        let allocation = unsafe { System.realloc(ptr, layout, new_size) };
        if TRACK_ALLOCATIONS.load(Ordering::Relaxed) && !allocation.is_null() {
            ALLOCATION_CALLS.fetch_add(1, Ordering::Relaxed);
            ALLOCATION_BYTES.fetch_add(new_size as u64, Ordering::Relaxed);
        }
        allocation
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: forwards the exact pointer/layout supplied by the allocator caller.
        unsafe { System.dealloc(ptr, layout) };
    }
}

#[derive(Debug, Clone, Copy)]
struct AllocationSample {
    calls: u64,
    requested_bytes: u64,
}

fn measure<T>(operation: impl FnOnce() -> T) -> (T, AllocationSample) {
    ALLOCATION_CALLS.store(0, Ordering::Relaxed);
    ALLOCATION_BYTES.store(0, Ordering::Relaxed);
    TRACK_ALLOCATIONS.store(true, Ordering::SeqCst);
    let result = operation();
    TRACK_ALLOCATIONS.store(false, Ordering::SeqCst);
    (
        result,
        AllocationSample {
            calls: ALLOCATION_CALLS.load(Ordering::Relaxed),
            requested_bytes: ALLOCATION_BYTES.load(Ordering::Relaxed),
        },
    )
}

fn print_sample(rows: usize, phase: &str, sample: AllocationSample) {
    println!(
        "rows={rows:>4} phase={phase:<38} allocation_calls={} requested_bytes={}",
        sample.calls, sample.requested_bytes
    );
}

fn fixture_bytes(rows: usize) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(rows * 120);
    for _ in 0..rows {
        bytes.extend_from_slice(&[b'x'; 119]);
        bytes.push(b'\n');
    }
    bytes
}

fn wait_for_bus_quiet(session: &Session) -> Result<(), Box<dyn std::error::Error>> {
    let bus = session.output_bus();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut last_seq = bus.current_seq();
    let mut last_change = Instant::now();
    loop {
        if Instant::now() >= deadline {
            return Err(format!("output bus did not settle (last seq {last_seq})").into());
        }
        thread::sleep(Duration::from_millis(5));
        let current_seq = bus.current_seq();
        if current_seq != last_seq {
            last_seq = current_seq;
            last_change = Instant::now();
        } else if current_seq > 0 && last_change.elapsed() >= Duration::from_millis(100) {
            return Ok(());
        }
    }
}

fn run_sample(rows: usize) -> Result<(), Box<dyn std::error::Error>> {
    let (fixture, fixture_sample) = measure(|| fixture_bytes(rows));
    print_sample(rows, "fixture_construction", fixture_sample);

    let (events, _) = broadcast::channel::<Event>(1);
    let session = Session::spawn(
        SpawnOptions {
            name: format!("snapshot-cache-measure-{rows}"),
            cwd: "/tmp".into(),
            // Keep the child alive while feeding in bounded batches. This
            // avoids the exit reaper's drain barrier becoming part of the
            // materialization/cache measurement.
            command: vec!["sh".into(), "-c".into(), "stty -echo; cat".into()],
            env: vec![],
            cols: 120,
            rows: 24,
        },
        events,
    )?;
    thread::sleep(Duration::from_millis(50));
    for batch in fixture.chunks(120 * 250) {
        session.write_stdin(batch)?;
        wait_for_bus_quiet(&session)?;
    }

    let (cold, cold_sample) = measure(|| session.snapshot_terminal(None, None));
    let cold = cold?;
    let actual_rows = cold.visible_screen.len() + cold.scrollback.len();
    print_sample(rows, "cold_materialize_plus_cache_insert", cold_sample);

    let (cached, hit_sample) = measure(|| session.snapshot_terminal(None, None));
    let cached = cached?;
    print_sample(rows, "production_cache_hit", hit_sample);

    let ((serialized_len, same_snapshot), serialization_sample) = measure(|| {
        let encoded = serde_json::to_vec(&cached).expect("snapshot serialization");
        (encoded.len(), cold == cached)
    });
    print_sample(
        rows,
        "snapshot_response_serialization",
        serialization_sample,
    );
    println!(
        "rows={rows:>4} snapshot_rows={actual_rows} serialized_bytes={serialized_len} cache_value_equal={same_snapshot}"
    );

    let _ = session.kill(libc::SIGKILL);
    let _ = session.wait_for_exit(Duration::from_secs(5));
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("snapshot_cache_measure: requested allocation counts/bytes, not RSS or latency");
    for rows in [500, 1_000, 5_000] {
        run_sample(rows)?;
    }
    Ok(())
}
