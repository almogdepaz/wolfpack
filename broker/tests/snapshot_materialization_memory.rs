//! Process-isolated budget for actual production snapshot materialization.
//! Run this integration target alone so unrelated test allocations cannot enter
//! the glibc live-heap delta. This is not RSS or post-expiry acceptance evidence.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
use uuid::Uuid;
#[cfg(all(target_os = "linux", target_env = "gnu"))]
use wolfpack_broker::terminal_state::TerminalState;

#[test]
fn snapshot_materialization_memory_budget() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        type Mallinfo2 = unsafe extern "C" fn() -> libc::mallinfo2;
        // SAFETY: lookup only; RTLD_DEFAULT belongs to the process and is not
        // closed. glibc's optional mallinfo2 has exactly this C ABI/return type.
        let address = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"mallinfo2".as_ptr()) };
        if address.is_null() {
            eprintln!("{{\"status\":\"skipped\",\"reason\":\"glibc mallinfo2 unavailable\"}}");
            return;
        }
        // SAFETY: the non-null symbol is the named glibc accounting function;
        // no allocator substitution, reclamation, or lifetime extension occurs.
        let counter: Mallinfo2 = unsafe { std::mem::transmute(address) };
        // SAFETY: process-local supported glibc accounting, no pointer inputs.
        let before = unsafe { counter() }.uordblks;
        let mut terminals: Vec<_> = (0..50)
            .map(|_| TerminalState::try_new(120, 40).expect("real terminal"))
            .collect();
        let mut bytes = "\x1b[2J\x1b[HPRE_WIDE_界_é_λ\r\n\x1b[?1049hALT_ONLY\x1b[?1049lPRE_ALT_RESTORED\r\n"
            .as_bytes().to_vec();
        for row in 0..100 {
            bytes.extend_from_slice(format!("HISTORY_{row:04}_END\r\n").as_bytes());
        }
        for terminal in &mut terminals {
            terminal.try_feed(&bytes).expect("real native feed");
        }
        let snapshots: Vec<_> = terminals.iter().map(|terminal| {
            terminal.try_snapshot_with_reflow(Uuid::new_v4(), 1, 0, Some(200), None)
                .expect("real production snapshot")
        }).collect();
        std::hint::black_box(&snapshots);
        // SAFETY: same supported accounting function; all snapshots remain live.
        let after = unsafe { counter() }.uordblks;
        let increase = after.checked_sub(before).expect("fixture live-heap growth");
        const MAX_MATERIALIZATION_BYTES: usize = 37 * 1024 * 1024 + 512 * 1024; // 37.5 MiB
        eprintln!("{{\"status\":\"measured\",\"beforeBytes\":{before},\"afterBytes\":{after},\"increaseBytes\":{increase},\"budgetBytes\":{MAX_MATERIALIZATION_BYTES}}}");
        assert_eq!(snapshots.len(), 50);
        assert!(snapshots.iter().all(|snapshot| snapshot.cols == 120 && snapshot.rows == 40
            && snapshot.visible_screen.len() == 40 && !snapshot.scrollback.is_empty()));
        for snapshot in &snapshots {
            let first_line: String = snapshot.scrollback[0].cells.iter()
                .map(|cell| &*cell.ch).collect();
            assert_eq!(first_line.trim_end(), "PRE_WIDE_界_é_λ");
        }
        assert!(increase <= MAX_MATERIALIZATION_BYTES,
            "snapshot materialization live heap {increase} bytes exceeds frozen {MAX_MATERIALIZATION_BYTES}-byte budget");
    }
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    eprintln!("{{\"status\":\"skipped\",\"reason\":\"GNU Linux allocator telemetry required\"}}");
}
