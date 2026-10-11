//! Byte-identity gate for the broker's snapshot → ANSI renderer.
//!
//! Each case in `tests/fixtures/ansi/cases.json` pairs a snapshot captured from
//! the real ghostty terminal (`<name>.snapshot.json`) with the bytes the relay's
//! TypeScript renderer (`src/broker/snapshot-render.ts`) produces for it
//! (`<name>.ansi`). Budgeted cases also pin the TS brute-force oracle's
//! `trimmed_lines` (`expected.json`). The Rust output must match byte-for-byte.
//!
//! Regenerate (only when the scenarios or the TS renderer change):
//!   (umask 022; cargo test --manifest-path broker/Cargo.toml --release \
//!     --test ansi_render_fixtures -- --ignored regenerate_snapshot_fixtures)
//!   bun scripts/gen-broker-ansi-fixtures.ts

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use wolfpack_broker::ansi_render::{render_snapshot_ansi, render_snapshot_ansi_budgeted};
use wolfpack_broker::protocol::{
    CellAttrs, CursorShape, CursorState, MouseMode, ScrollRegion, Snapshot, StyledCell, StyledLine,
    TerminalModes,
};
use wolfpack_broker::terminal_state::TerminalState;

#[derive(Debug, Serialize, Deserialize)]
struct Case {
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_bytes: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct Expected {
    trimmed_lines: usize,
}

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ansi")
}

fn read_cases() -> Vec<Case> {
    let raw = std::fs::read_to_string(fixture_dir().join("cases.json")).expect("read cases.json");
    serde_json::from_str(&raw).expect("parse cases.json")
}

fn read_snapshot(name: &str) -> Snapshot {
    let raw = std::fs::read_to_string(fixture_dir().join(format!("{name}.snapshot.json")))
        .unwrap_or_else(|error| panic!("read {name}.snapshot.json: {error}"));
    serde_json::from_str(&raw).unwrap_or_else(|error| panic!("parse {name}.snapshot.json: {error}"))
}

fn read_expected_ansi(name: &str) -> Vec<u8> {
    std::fs::read(fixture_dir().join(format!("{name}.ansi")))
        .unwrap_or_else(|error| panic!("read {name}.ansi (run the bun generator): {error}"))
}

fn read_expected_trims() -> BTreeMap<String, Expected> {
    let raw = std::fs::read_to_string(fixture_dir().join("expected.json")).expect("read expected.json");
    serde_json::from_str(&raw).expect("parse expected.json")
}

fn first_difference(actual: &[u8], expected: &[u8]) -> String {
    let index = actual
        .iter()
        .zip(expected)
        .position(|(a, e)| a != e)
        .unwrap_or_else(|| actual.len().min(expected.len()));
    let window = |bytes: &[u8]| {
        let start = index.saturating_sub(24);
        let end = (index + 24).min(bytes.len());
        format!("{:?}", String::from_utf8_lossy(&bytes[start.min(end)..end]))
    };
    format!(
        "first difference at byte {index} (actual len {}, expected len {}): actual {} expected {}",
        actual.len(),
        expected.len(),
        window(actual),
        window(expected),
    )
}

#[test]
fn rust_renderer_matches_typescript_renderer_byte_for_byte() {
    let cases = read_cases();
    let trims = read_expected_trims();
    assert!(cases.len() >= 6, "fixture set too small: {}", cases.len());
    for case in cases {
        let snapshot = read_snapshot(&case.name);
        let expected = read_expected_ansi(&case.name);
        match case.max_bytes {
            None => {
                let actual = render_snapshot_ansi(&snapshot);
                assert!(
                    actual == expected,
                    "{}: {}",
                    case.name,
                    first_difference(&actual, &expected)
                );
            }
            Some(max_bytes) => {
                let rendered = render_snapshot_ansi_budgeted(&snapshot, max_bytes as usize);
                assert!(
                    rendered.bytes == expected,
                    "{}: {}",
                    case.name,
                    first_difference(&rendered.bytes, &expected)
                );
                let oracle = trims
                    .get(&case.name)
                    .unwrap_or_else(|| panic!("{}: missing expected.json entry", case.name));
                assert_eq!(rendered.trimmed_lines, oracle.trimmed_lines, "{}: trimmed_lines", case.name);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Snapshot fixture generator (real ghostty terminal)
// ---------------------------------------------------------------------------

struct Scenario {
    name: &'static str,
    cols: u16,
    rows: u16,
    bytes: Vec<u8>,
    scrollback_limit: Option<usize>,
    target_cols: Option<usize>,
    max_bytes: Option<u32>,
}

fn scenario(name: &'static str, cols: u16, rows: u16, bytes: impl Into<Vec<u8>>) -> Scenario {
    Scenario {
        name,
        cols,
        rows,
        bytes: bytes.into(),
        scrollback_limit: None,
        target_cols: None,
        max_bytes: None,
    }
}

fn dense_line(index: usize, width: usize) -> String {
    let mut line = String::new();
    for col in 0..width {
        let fg = (index * 7 + col * 13) % 256;
        let (r, g, b) = ((index * 31) % 256, (col * 17) % 256, ((index + col) * 5) % 256);
        line.push_str(&format!("\x1b[38;5;{fg};48;2;{r};{g};{b}m{}", (b'a' + (col % 26) as u8) as char));
    }
    line.push_str("\x1b[0m\r\n");
    line
}

fn dense_lines(count: usize, width: usize) -> String {
    (0..count).map(|index| dense_line(index, width)).collect()
}

fn scenarios() -> Vec<Scenario> {
    let mut list = Vec::new();

    list.push(scenario("plain_empty_scrollback", 20, 5, "hello\r\nworld"));

    list.push(scenario("dense_colors", 24, 6, dense_lines(18, 20)));

    list.push(scenario(
        "sgr_attrs",
        48,
        10,
        concat!(
            "\x1b[1mbold\x1b[0m \x1b[2mdim\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munder\x1b[0m\r\n",
            "\x1b[5mblink\x1b[0m \x1b[7minverse\x1b[0m \x1b[8mhidden\x1b[0m \x1b[9mstrike\x1b[0m\r\n",
            "\x1b[1;3;4;31;44mcombo\x1b[22m-nobold\x1b[23m-noitalic\x1b[24m-nounder\x1b[0m\r\n",
            "\x1b[38;2;255;128;1mtruecolor\x1b[39m default-fg \x1b[48;2;1;2;3mbg-only\x1b[49m\r\n",
            "\x1b[91mbright\x1b[0m \x1b[38;5;196m256\x1b[0m plain \x1b[7;1mrev-bold\x1b[27m bold\x1b[0m\r\n",
            "\x1b[32mgreen line runs to the end and keeps going\x1b[0m",
        ),
    ));

    list.push(scenario(
        "wide_glyphs",
        12,
        6,
        "日本語テキスト\r\nemoji 🙂🐺!\r\ne\u{301} cafe\u{301}\r\nabcdefghijk日\r\n\x1b[35m漢字\x1b[0m end",
    ));

    let long_lines = "the quick brown fox jumps over the lazy dog 0123456789\r\n\x1b[33mwrapped yellow text that spans several rows of the terminal\x1b[0m\r\nshort\r\n";
    let mut wrapped_raw = scenario("wrapped_raw", 16, 4, long_lines.repeat(2));
    wrapped_raw.scrollback_limit = Some(500);
    list.push(wrapped_raw);
    let mut wrapped_reflow = scenario("wrapped_reflow", 16, 4, long_lines.repeat(2));
    wrapped_reflow.scrollback_limit = Some(500);
    wrapped_reflow.target_cols = Some(24);
    list.push(wrapped_reflow);

    list.push(scenario(
        "modes_title_cursor",
        30,
        6,
        concat!(
            "\x1b]0;wolfpack title\x07",
            "prompt$ vim file\r\nline two\r\n",
            "\x1b[?1h\x1b=\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[4h\x1b[?7l\x1b[?25l",
            "\x1b[4;11H",
        ),
    ));
    list.push(scenario("mouse_x10", 10, 2, "\x1b[?9hx"));
    list.push(scenario("mouse_vt200", 10, 2, "\x1b[?1000hx"));
    list.push(scenario("mouse_button_event", 10, 2, "\x1b[?1002hx"));
    list.push(scenario("mouse_any_event", 10, 2, "\x1b[?1003hx"));
    list.push(scenario("origin_mode", 10, 4, "\x1b[2;3r\x1b[?6hx"));

    list.push(scenario(
        "alt_screen_tui",
        30,
        6,
        format!(
            "{}\x1b[?1049h\x1b[H\x1b[2J\x1b[44;37m status bar \x1b[0m\x1b[3;5H\x1b[1mmenu\x1b[0m\x1b[5;1H> \x1b[32mitem\x1b[0m\x1b[4;8H",
            "primary one\r\nprimary two\r\nprimary three\r\nprimary four\r\nprimary five\r\nprimary six\r\nprimary seven\r\n",
        ),
    ));

    list.push(scenario(
        "trailing_blanks",
        24,
        6,
        concat!(
            "trailing spaces      \r\n",
            "\x1b[44mbg pad    \x1b[0m\r\n",
            "nbsp\u{a0}\u{a0}\u{a0}\r\n",
            "\r\n",
            "\x1b[41m          \x1b[0m\r\n",
            "\x1b[7m \x1b[0m",
        ),
    ));

    let mut over_budget = scenario("scrollback_over_budget", 20, 4, dense_lines(60, 16));
    over_budget.max_bytes = Some(4096);
    list.push(over_budget);

    let mut visible_over = scenario("visible_over_budget", 24, 6, dense_lines(12, 22));
    visible_over.max_bytes = Some(64);
    list.push(visible_over);

    let mut fits = scenario("budget_fits", 24, 6, dense_lines(10, 20));
    fits.max_bytes = Some(1024 * 1024);
    list.push(fits);

    list
}

fn write_snapshot(dir: &std::path::Path, name: &str, snapshot: &Snapshot) {
    let json = serde_json::to_string(snapshot).expect("serialize snapshot");
    std::fs::write(dir.join(format!("{name}.snapshot.json")), json + "\n").expect("write snapshot");
}

fn cell(ch: &str, attrs: CellAttrs) -> StyledCell {
    StyledCell { ch: Cow::Owned(ch.to_string()), attrs }
}

fn synthetic_edges() -> Snapshot {
    let bold = CellAttrs { bold: true, ..CellAttrs::default() };
    let high_bits = CellAttrs { fg: Some(0xff12_3456), bg: Some(0x00ab_cdef), ..CellAttrs::default() };
    let blue_bg = CellAttrs { bg: Some(0x0000_00ff), ..CellAttrs::default() };
    Snapshot {
        session_id: Uuid::nil(),
        seq: 0,
        cols: 6,
        rows: 3,
        scrollback: vec![
            // Empty glyph mid-line counts as text before a non-blank cell.
            StyledLine {
                cells: vec![cell("a", bold.clone()), cell("", bold.clone()), cell("b", CellAttrs::default())],
                wrapped: true,
            },
            // No cells at all.
            StyledLine::default(),
            // Trailing blank with non-default attrs is kept; NBSP default blanks are trimmed.
            StyledLine {
                cells: vec![
                    cell("x", high_bits.clone()),
                    cell(" ", blue_bg),
                    cell("\u{a0}", CellAttrs::default()),
                    cell("", CellAttrs::default()),
                ],
                wrapped: false,
            },
        ],
        visible_screen: vec![
            StyledLine { cells: vec![cell("y", high_bits)], wrapped: false },
            StyledLine { cells: vec![cell(" ", CellAttrs::default())], wrapped: false },
            StyledLine { cells: vec![cell("z", bold)], wrapped: false },
        ],
        cursor: CursorState { row: 2, col: 1, visible: true, shape: CursorShape::Bar },
        modes: TerminalModes {
            alt_screen: true,
            auto_wrap: true,
            mouse_mode: MouseMode::Sgr,
            ..TerminalModes::default()
        },
        scroll_region: ScrollRegion { top: 0, bottom: 2 },
        title: Some("synthetic".to_string()),
        captured_at_ms: 0,
    }
}

#[test]
#[ignore = "regenerates checked-in fixtures; run explicitly, then run the bun generator"]
fn regenerate_snapshot_fixtures() {
    let dir = fixture_dir();
    std::fs::create_dir_all(&dir).expect("create fixture dir");
    let mut cases = Vec::new();
    for scenario in scenarios() {
        let mut terminal = TerminalState::try_new(scenario.cols, scenario.rows).expect("terminal");
        terminal.try_feed(&scenario.bytes).expect("feed");
        let snapshot = terminal
            .try_snapshot_with_reflow(Uuid::nil(), 0, 0, scenario.scrollback_limit, scenario.target_cols)
            .expect("snapshot");
        write_snapshot(&dir, scenario.name, &snapshot);
        cases.push(Case { name: scenario.name.to_string(), max_bytes: scenario.max_bytes });
    }
    // Shapes the terminal does not emit but the renderers must agree on.
    write_snapshot(&dir, "synthetic_edges", &synthetic_edges());
    cases.push(Case { name: "synthetic_edges".to_string(), max_bytes: None });
    let manifest = serde_json::to_string_pretty(&cases).expect("serialize cases");
    std::fs::write(dir.join("cases.json"), manifest + "\n").expect("write cases.json");
}
