//! Fixture-driven regression tests for the broker's terminal-state emulator.
//!
//! Each fixture in `tests/terminal_fixtures/` is a small escape-encoded byte
//! stream that exercises one snapshot dimension (plain text, CR redraw, SGR
//! color, alt-screen partial redraw). The test decodes the fixture, drives a
//! `TerminalState` of the declared geometry, and pins the resulting `Snapshot`
//! grid + cell attrs against expected values so future emulator changes can't
//! silently shift reconnect fidelity.
//!
//! Fixture escape format (ASCII-only; safe through any text transport):
//!   * `\r`   → CR (0x0D)
//!   * `\n`   → LF (0x0A)
//!   * `\t`   → TAB (0x09)
//!   * `\e`   → ESC (0x1B)
//!   * `\\`   → backslash
//!   * `\xNN` → byte NN (two hex digits)
//!   * any other char → literal byte
//!
//! Trailing whitespace in the fixture file is stripped before decoding so the
//! test is robust to editors that append a final newline.

use uuid::Uuid;

use wolfpack_broker::protocol::{CellAttrs, Snapshot, StyledLine};
use wolfpack_broker::terminal_state::TerminalState;

const PLAIN_SHELL: &str = include_str!("terminal_fixtures/plain_shell.bin");
const CR_REDRAW: &str = include_str!("terminal_fixtures/cr_redraw.bin");
const ANSI_COLOR: &str = include_str!("terminal_fixtures/ansi_color.bin");
const TUI_PARTIAL_REDRAW: &str = include_str!("terminal_fixtures/tui_partial_redraw.bin");
const TUI_EDIT_OPS: &str = include_str!("terminal_fixtures/tui_edit_ops.bin");

fn decode(src: &str) -> Vec<u8> {
    let trimmed = src.trim_end_matches(|c: char| c == '\n' || c == '\r' || c == ' ');
    let mut out = Vec::with_capacity(trimmed.len());
    let mut chars = trimmed.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            // Fixtures are ASCII; a single escape-free char is one byte.
            let mut buf = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            continue;
        }
        let esc = chars.next().expect("trailing backslash in fixture");
        match esc {
            'r' => out.push(b'\r'),
            'n' => out.push(b'\n'),
            't' => out.push(b'\t'),
            'e' => out.push(0x1B),
            '\\' => out.push(b'\\'),
            'x' => {
                let h1 = chars.next().expect("\\x missing hi nibble");
                let h2 = chars.next().expect("\\x missing lo nibble");
                let hex = [h1 as u8, h2 as u8];
                let s = std::str::from_utf8(&hex).expect("\\x non-ascii");
                let v = u8::from_str_radix(s, 16).expect("\\x not hex");
                out.push(v);
            }
            other => panic!("unknown fixture escape: \\{other}"),
        }
    }
    out
}

fn snapshot_for(cols: u16, rows: u16, fixture: &str) -> Snapshot {
    let bytes = decode(fixture);
    let mut t = TerminalState::try_new(cols, rows).expect("terminal init");
    t.try_feed(&bytes).expect("terminal feed");
    t.try_snapshot(Uuid::nil(), 0, 0).expect("snapshot")
}

fn line_text(line: &StyledLine) -> String {
    line.cells.iter().map(|c| c.ch.as_str()).collect()
}

fn cell_chars(line: &StyledLine, range: std::ops::Range<usize>) -> String {
    line.cells[range].iter().map(|c| c.ch.as_str()).collect()
}

fn ansi_color(idx: u8) -> u32 {
    const PALETTE: [u32; 16] = [
        0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0, 0x808080,
        0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
    ];
    PALETTE[idx as usize]
}

#[test]
fn fixture_files_contain_expected_escape_encoded_source() {
    // Pin the fixture file contents so a botched manual edit (or a transport
    // corruption that double-decoded escapes) surfaces here, not as a confusing
    // emulator-shape failure further down.
    fn rstrip(s: &str) -> &str {
        s.trim_end_matches(|c: char| c == '\n' || c == '\r' || c == ' ')
    }
    assert_eq!(rstrip(PLAIN_SHELL), r"hello\r\nworld\r\n$ done\r\n");
    assert_eq!(
        rstrip(CR_REDRAW),
        r"loading...\r[####    ]\r[########]\rdone      \r\n"
    );
    assert_eq!(rstrip(ANSI_COLOR), r"\e[1;31mERROR\e[0m: \e[32mOK\e[0m");
    assert_eq!(
        rstrip(TUI_PARTIAL_REDRAW),
        r"\e[?1049h\e[2J\e[1;1Htop\e[2;1Hbody1\e[3;1Hbottom\e[2;1H\e[Knew2"
    );
    assert_eq!(
        rstrip(TUI_EDIT_OPS),
        r"\e[?1049h\e[2J\e[1;1HABCDE\e[1;2H\e[2P\e[2;1HABCDE\e[2;2H\e[2@\e[3;1HABCDE\e[3;2H\e[2X"
    );
}

#[test]
fn decoder_handles_all_documented_escapes() {
    // Sanity-check the tiny decoder: regressions here would silently corrupt
    // every fixture, so pin the contract directly.
    assert_eq!(decode(r"a\rb\nc"), b"a\rb\nc");
    assert_eq!(decode(r"\e[m"), b"\x1b[m");
    assert_eq!(decode(r"\\"), b"\\");
    assert_eq!(decode(r"\x1bX"), b"\x1bX");
    assert_eq!(decode("plain"), b"plain");
    // Trailing whitespace must be stripped so editor-added EOF newlines
    // don't smuggle a stray LF byte into the byte stream.
    assert_eq!(decode("hi\n"), b"hi");
    assert_eq!(decode("hi\r\n"), b"hi");
}

#[test]
fn plain_shell_renders_each_line_at_column_zero() {
    let snap = snapshot_for(40, 5, PLAIN_SHELL);
    assert_eq!(snap.cols, 40);
    assert_eq!(snap.rows, 5);
    assert_eq!(snap.visible_screen.len(), 5);

    assert_eq!(cell_chars(&snap.visible_screen[0], 0..5), "hello");
    assert_eq!(cell_chars(&snap.visible_screen[1], 0..5), "world");
    assert_eq!(cell_chars(&snap.visible_screen[2], 0..6), "$ done");
    // Row 3 onward is blank.
    assert!(line_text(&snap.visible_screen[3]).chars().all(|c| c == ' '));
    assert!(line_text(&snap.visible_screen[4]).chars().all(|c| c == ' '));

    // No SGR was issued; every cell carries default attrs.
    for row in &snap.visible_screen {
        for cell in &row.cells {
            assert_eq!(cell.attrs, CellAttrs::default(), "default attrs expected");
        }
    }

    // CR\LF after `$ done` parks the cursor at the start of row 3.
    assert_eq!(snap.cursor.row, 3);
    assert_eq!(snap.cursor.col, 0);

    // No scrollback — content fits on screen.
    assert!(snap.scrollback.is_empty());
}

#[test]
fn cr_redraw_collapses_to_final_overwrite() {
    let snap = snapshot_for(20, 2, CR_REDRAW);
    assert_eq!(snap.cols, 20);
    assert_eq!(snap.rows, 2);

    // Each `\r` parks the cursor at column 0; subsequent prints overwrite
    // the previous content. The final write is "done      " (10 chars).
    assert_eq!(cell_chars(&snap.visible_screen[0], 0..10), "done      ");
    // Columns 10..20 were never touched, so they remain blank.
    assert!(snap.visible_screen[0]
        .cells
        .iter()
        .skip(10)
        .all(|c| c.ch == " " && c.attrs == CellAttrs::default()));

    // Row 1 is fully blank.
    assert!(line_text(&snap.visible_screen[1]).chars().all(|c| c == ' '));

    // Trailing CRLF advances cursor to row 1, col 0.
    assert_eq!(snap.cursor.row, 1);
    assert_eq!(snap.cursor.col, 0);
}

#[test]
fn ansi_color_tracks_sgr_attrs_per_cell() {
    let snap = snapshot_for(20, 2, ANSI_COLOR);
    let row = &snap.visible_screen[0];

    // "ERROR" written under SGR 1;31 → bold, fg = ANSI red (palette idx 1).
    assert_eq!(cell_chars(row, 0..5), "ERROR");
    let red = Some(ansi_color(1));
    for (i, cell) in row.cells.iter().take(5).enumerate() {
        assert!(cell.attrs.bold, "cell {i} must be bold");
        assert_eq!(cell.attrs.fg, red, "cell {i} must be red");
    }

    // SGR 0 reset → ": " has default attrs.
    assert_eq!(cell_chars(row, 5..7), ": ");
    for (i, cell) in row.cells.iter().skip(5).take(2).enumerate() {
        assert_eq!(
            cell.attrs,
            CellAttrs::default(),
            "cell {} after reset must be default",
            5 + i
        );
    }

    // SGR 32 → "OK" is non-bold green.
    assert_eq!(cell_chars(row, 7..9), "OK");
    let green = Some(ansi_color(2));
    for (i, cell) in row.cells.iter().skip(7).take(2).enumerate() {
        assert!(!cell.attrs.bold, "cell {} must not be bold", 7 + i);
        assert_eq!(cell.attrs.fg, green, "cell {} must be green", 7 + i);
    }

    // Trailing cells (post-OK reset) are blank with default attrs.
    for (i, cell) in row.cells.iter().enumerate().skip(9) {
        assert_eq!(cell.ch, " ", "cell {i} must be blank");
        assert_eq!(cell.attrs, CellAttrs::default(), "cell {i} must reset");
    }

    // Cursor sits right after "OK" on row 0.
    assert_eq!(snap.cursor.row, 0);
    assert_eq!(snap.cursor.col, 9);
    // Row 1 is untouched.
    assert!(line_text(&snap.visible_screen[1]).chars().all(|c| c == ' '));
}

#[test]
fn tui_edit_operations_produce_authoritative_reconnect_cells() {
    let snapshot = snapshot_for(10, 3, TUI_EDIT_OPS);

    assert!(snapshot.modes.alt_screen);
    assert_eq!(cell_chars(&snapshot.visible_screen[0], 0..3), "ADE");
    assert!(snapshot.visible_screen[0]
        .cells
        .iter()
        .skip(3)
        .all(|cell| cell.ch == " "));
    assert_eq!(cell_chars(&snapshot.visible_screen[1], 0..7), "A  BCDE");
    assert_eq!(cell_chars(&snapshot.visible_screen[2], 0..5), "A  DE");
    assert_eq!(snapshot.cursor.row, 2);
    assert_eq!(snapshot.cursor.col, 1);
}

#[test]
fn tui_partial_redraw_uses_alt_screen_and_overwrites_one_line() {
    let snap = snapshot_for(20, 4, TUI_PARTIAL_REDRAW);

    // Alt-screen mode is active; the visible_screen MUST reflect the alt grid.
    assert!(snap.modes.alt_screen);
    assert!(
        snap.scrollback.is_empty(),
        "alt-screen scrolls don't fill scrollback"
    );

    // Initial draw at three rows, then a CUP+EL+print pass overwrites row 1.
    assert_eq!(cell_chars(&snap.visible_screen[0], 0..3), "top");
    assert_eq!(cell_chars(&snap.visible_screen[1], 0..4), "new2");
    assert_eq!(cell_chars(&snap.visible_screen[2], 0..6), "bottom");

    // `\e[K` (EL 0) clears from cursor to EOL, so row 1 must NOT retain the
    // tail of the original "body1" render — it should be all blank past col 4.
    assert!(snap.visible_screen[1]
        .cells
        .iter()
        .skip(4)
        .all(|c| c.ch == " "));

    // Last write was "new2" at row 1 cols 0..4 → cursor at (1, 4).
    assert_eq!(snap.cursor.row, 1);
    assert_eq!(snap.cursor.col, 4);

    // Default SGR throughout — no styled cells in this fixture.
    for row in &snap.visible_screen {
        for cell in &row.cells {
            assert_eq!(cell.attrs, CellAttrs::default());
        }
    }
}
