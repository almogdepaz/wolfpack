use uuid::Uuid;

use wolfpack_broker::terminal_state::TerminalState;

fn combining_sequence(mark_count: usize) -> Vec<u8> {
    let mut input = String::from("a");
    for _ in 0..mark_count {
        input.push('\u{0301}');
    }
    input.into_bytes()
}

/// libghostty-vt stores at most `grapheme_max_len` (64, `src/terminal/page.zig`)
/// suffix codepoints per cell and ignores the rest, so one cell's text is
/// bounded no matter how many combining marks the program writes. The shim's
/// own per-cell codepoint limit stays covered by `ghostty_native_helpers`.
const GHOSTTY_GRAPHEME_MAX_SUFFIX_CODEPOINTS: usize = 64;

#[test]
fn authoritative_real_archive_caps_large_combining_sequence() {
    let mut terminal = TerminalState::try_new(20, 5).expect("terminal init");
    terminal
        .try_feed(&combining_sequence(512))
        .expect("terminal feed");

    let snapshot = terminal.try_snapshot(Uuid::nil(), 0, 0).expect("snapshot");
    let first = &snapshot.visible_screen[0].cells[0].ch;
    assert!(first.starts_with('a'));
    assert_eq!(
        first.chars().count(),
        1 + GHOSTTY_GRAPHEME_MAX_SUFFIX_CODEPOINTS
    );
}

#[test]
fn authoritative_snapshots_oversized_grapheme_without_panic() {
    let mut terminal = TerminalState::try_new(20, 5).expect("terminal init");
    terminal
        .try_feed(&combining_sequence(1100))
        .expect("terminal feed");

    let snapshot = terminal.try_snapshot(Uuid::nil(), 0, 0).expect("snapshot");
    assert_eq!(
        snapshot.visible_screen[0].cells[0].ch.chars().count(),
        1 + GHOSTTY_GRAPHEME_MAX_SUFFIX_CODEPOINTS
    );
}
