use uuid::Uuid;

use wolfpack_broker::protocol::ScrollRegion;
use wolfpack_broker::terminal_state::TerminalState;

fn snapshot_region_after(bytes: &[u8], rows: u16) -> ScrollRegion {
    let mut terminal = TerminalState::try_new(10, rows).expect("terminal init");
    terminal.try_feed(bytes).expect("terminal feed");
    terminal
        .try_snapshot(Uuid::nil(), 0, 0)
        .expect("snapshot")
        .scroll_region
}

#[test]
fn ghostty_authoritative_reports_default_full_screen_scroll_region() {
    assert_eq!(
        snapshot_region_after(b"", 5),
        ScrollRegion { top: 0, bottom: 4 }
    );
}

#[test]
fn ghostty_authoritative_reports_decstbm_scroll_region() {
    assert_eq!(
        snapshot_region_after(b"\x1b[2;4r", 5),
        ScrollRegion { top: 1, bottom: 3 }
    );
}

#[test]
fn ghostty_authoritative_reports_decstbm_reset() {
    assert_eq!(
        snapshot_region_after(b"\x1b[2;4r\x1b[r", 5),
        ScrollRegion { top: 0, bottom: 4 }
    );
}

#[test]
fn ghostty_authoritative_scroll_region_resets_on_resize() {
    let mut terminal = TerminalState::try_new(10, 5).expect("terminal init");
    terminal.try_feed(b"\x1b[2;4r").expect("terminal feed");
    terminal.try_resize(10, 3).expect("terminal resize");

    assert_eq!(
        terminal
            .try_snapshot(Uuid::nil(), 0, 0)
            .expect("snapshot")
            .scroll_region,
        ScrollRegion { top: 0, bottom: 2 }
    );
}
