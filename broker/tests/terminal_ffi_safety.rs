use uuid::Uuid;

use wolfpack_broker::terminal_state::{TerminalState, TerminalStateError};

fn combining_sequence(mark_count: usize) -> Vec<u8> {
    let mut input = String::from("a");
    for _ in 0..mark_count {
        input.push('\u{0301}');
    }
    input.into_bytes()
}

#[test]
fn authoritative_real_archive_handles_large_bounded_combining_sequence() {
    let mut terminal = TerminalState::try_new(20, 5).expect("terminal init");
    terminal
        .try_feed(&combining_sequence(512))
        .expect("terminal feed");

    let snapshot = terminal.try_snapshot(Uuid::nil(), 0, 0).expect("snapshot");
    let first = &snapshot.visible_screen[0].cells[0].ch;
    assert!(first.starts_with('a'));
    assert!(first.chars().count() > 128);
}

#[test]
fn authoritative_rejects_oversized_grapheme_without_panic() {
    let mut terminal = TerminalState::try_new(20, 5).expect("terminal init");
    terminal
        .try_feed(&combining_sequence(1100))
        .expect("terminal feed");

    assert!(matches!(
        terminal.try_snapshot(Uuid::nil(), 0, 0),
        Err(TerminalStateError::GhosttyLimit { .. })
    ));
}
