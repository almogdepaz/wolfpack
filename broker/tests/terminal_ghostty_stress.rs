use std::panic::{catch_unwind, AssertUnwindSafe};

use uuid::Uuid;

use wolfpack_broker::protocol::Snapshot;
use wolfpack_broker::terminal_state::TerminalState;

fn snapshot(terminal: &TerminalState, seq: u64) -> Snapshot {
    terminal
        .try_snapshot(Uuid::nil(), seq, 0)
        .expect("snapshot should not fail")
}

fn cell_text(snapshot: &Snapshot, row: usize, cols: std::ops::Range<usize>) -> String {
    snapshot.visible_screen[row]
        .cells
        .iter()
        .skip(cols.start)
        .take(cols.end - cols.start)
        .map(|cell| cell.ch.as_str())
        .collect()
}

#[test]
fn deterministic_split_utf8_and_escape_chunks_match_single_feed() {
    let input = concat!(
        "plain ",
        "caf\u{00e9}",
        "\r\n",
        "\x1b[31mred\x1b[0m",
        "\x1b[2;5H",
        "xy",
        "\x1b]0;split-title\x07",
        " done",
    )
    .as_bytes();

    let mut single = TerminalState::try_new(24, 4).expect("terminal init");
    single.try_feed(input).expect("single feed");
    let single_snapshot = snapshot(&single, 1);

    let mut chunked = TerminalState::try_new(24, 4).expect("terminal init");
    for byte in input {
        chunked
            .try_feed(std::slice::from_ref(byte))
            .expect("chunk feed");
    }
    let chunked_snapshot = snapshot(&chunked, 1);

    assert_eq!(chunked_snapshot, single_snapshot);
    assert_eq!(chunked_snapshot.title.as_deref(), Some("split-title"));
    assert_eq!(cell_text(&chunked_snapshot, 0, 0..10), "plain café");
    assert_eq!(cell_text(&chunked_snapshot, 1, 4..11), "xy done");
}

#[test]
fn malformed_and_truncated_vt_input_does_not_panic() {
    let malformed: &[u8] =
        b"ok\xff\xfe\x1b[999999999999999999999999999999D\x1b[?25l\x1b]0;unterminated-title\x1bPq";
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut terminal = TerminalState::try_new(16, 3).expect("terminal init");
        terminal.try_feed(malformed).expect("malformed feed");
        let snap = snapshot(&terminal, 2);
        assert_eq!(snap.cols, 16);
        assert_eq!(snap.rows, 3);
        assert!(snap.cursor.row < snap.rows);
        assert!(snap.cursor.col < snap.cols);
        assert!(cell_text(&snap, 0, 0..2).contains("ok"));
    }));

    assert!(
        result.is_ok(),
        "malformed/truncated VT input must not panic"
    );
}

#[test]
fn repeated_resize_content_and_snapshot_sequence_stays_bounded() {
    const SIZES: &[(u16, u16)] = &[(12, 4), (18, 5), (9, 3), (20, 6), (14, 4), (16, 5)];
    let mut terminal = TerminalState::try_new(12, 4).expect("terminal init");

    for step in 0..18u64 {
        let (cols, rows) = SIZES[step as usize % SIZES.len()];
        terminal.try_resize(cols, rows).expect("resize");
        let bytes = format!(
            "\x1b[{};1Hstep-{step:02}-width-{cols}\x1b[K\r\nline-{step:02}\r\n",
            (step % u64::from(rows)).saturating_add(1),
        );
        terminal.try_feed(bytes.as_bytes()).expect("feed");
        let snap = snapshot(&terminal, step);

        assert_eq!(snap.cols, cols);
        assert_eq!(snap.rows, rows);
        assert_eq!(snap.visible_screen.len(), usize::from(rows));
        assert!(snap.cursor.row < rows);
        assert!(snap.cursor.col < cols);
        assert!(snap
            .visible_screen
            .iter()
            .all(|line| line.cells.len() <= usize::from(cols)));
        assert!(snap.scrollback.len() <= 128);
    }
}
