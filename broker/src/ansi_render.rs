//! Snapshot → ANSI byte renderer for attach prefill.
//!
//! Byte-identical port of the relay's `renderSnapshotToAnsi`
//! (`src/broker/snapshot-render.ts`); `tests/ansi_render_fixtures.rs` pins the
//! two against each other. Output layout:
//!
//!   1. clear visible + scrollback, cursor home, SGR reset
//!   2. scrollback (oldest first), each line followed by `\r\n`
//!   3. `CSI ?1049h` when the snapshot was captured on the alt screen
//!   4. visible screen, lines separated by `\r\n`
//!   5. SGR reset (if styled), DEC mode preamble, cursor position + visibility
//!
//! Per-cell SGR is a full `CSI 0;…m` emitted only when attrs change; the
//! last-emitted attrs carry across the whole render. Trailing blank cells with
//! default attrs are trimmed per line. `wrapped` and `title` are not rendered.

use crate::protocol::{CellAttrs, MouseMode, Snapshot, StyledLine, TerminalModes};

const CSI: &[u8] = b"\x1b[";
const CLEAR_AND_HOME: &[u8] = b"\x1b[2J\x1b[3J\x1b[H\x1b[0m";
const SGR_RESET: &[u8] = b"\x1b[0m";
const ENTER_ALT_SCREEN: &[u8] = b"\x1b[?1049h";
const LINE_SEPARATOR: &[u8] = b"\r\n";

/// Longest SGR `write_sgr` can produce (every flag plus two 24-bit colors):
/// `ESC[0;1;2;3;4;5;7;8;9;38;2;255;255;255;48;2;255;255;255m` is 54 bytes.
const MAX_SGR_BYTES: usize = 54;

/// Newest scrollback lines rendered first when searching for the budget cut.
const INITIAL_WINDOW_LINES: usize = 64;

static DEFAULT_ATTRS: CellAttrs = CellAttrs {
    fg: None,
    bg: None,
    bold: false,
    italic: false,
    underline: false,
    reverse: false,
    blink: false,
    strike: false,
    dim: false,
    hidden: false,
};

/// Rendered prefill plus how many of the oldest scrollback lines the byte
/// budget dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BudgetedAnsi {
    pub bytes: Vec<u8>,
    pub trimmed_lines: usize,
}

/// Render the complete snapshot, identical to `renderSnapshotToAnsi`.
pub fn render_snapshot_ansi(snapshot: &Snapshot) -> Vec<u8> {
    render_from(snapshot, 0, None)
}

/// Render the snapshot within a scrollback byte budget.
///
/// The result is exactly `render_snapshot_ansi` of the snapshot with its
/// oldest `trimmed_lines` scrollback lines removed, for the smallest such
/// trim whose output fits `max_bytes`. The visible screen is never cut: when
/// it alone exceeds the budget, all scrollback is dropped and the output is
/// larger than `max_bytes`.
pub fn render_snapshot_ansi_budgeted(snapshot: &Snapshot, max_bytes: usize) -> BudgetedAnsi {
    let line_count = snapshot.scrollback.len();
    // Output length strictly decreases as more oldest lines are trimmed: a
    // dropped line costs at least its `\r\n`, and any SGR it lets the next
    // line skip was paid for inside the dropped line. So grow a window of the
    // newest lines until its render overflows; the answer lies inside it, and
    // the cost stays proportional to what is kept rather than total history.
    let mut window = INITIAL_WINDOW_LINES.min(line_count);
    let (window_start, window_bytes, line_starts) = loop {
        let start = line_count - window;
        let mut line_starts = Vec::with_capacity(window);
        let bytes = render_from(snapshot, start, Some(&mut line_starts));
        if bytes.len() <= max_bytes {
            if start == 0 {
                return BudgetedAnsi { bytes, trimmed_lines: 0 };
            }
            window = window.saturating_mul(2).min(line_count);
            continue;
        }
        break (start, bytes, line_starts);
    };
    // A standalone render of scrollback[k..] matches the window render's
    // suffix from line k except for the SGR before the first painted cell
    // after the cut (or a final reset when nothing is painted), so its length
    // is within MAX_SGR_BYTES of this estimate. Start at the first cut that
    // could fit and step forward to the first that does.
    let estimated_len = |start: usize| CLEAR_AND_HOME.len() + window_bytes.len() - start;
    let mut trimmed = window_start
        + line_starts
            .partition_point(|&start| estimated_len(start) > max_bytes.saturating_add(MAX_SGR_BYTES));
    loop {
        let bytes = render_from(snapshot, trimmed, None);
        if bytes.len() <= max_bytes || trimmed == line_count {
            return BudgetedAnsi { bytes, trimmed_lines: trimmed };
        }
        trimmed += 1;
    }
}

/// Render with scrollback starting at `scrollback_start`. When requested,
/// records the output offset at which each rendered scrollback line begins.
fn render_from(
    snapshot: &Snapshot,
    scrollback_start: usize,
    mut line_starts: Option<&mut Vec<usize>>,
) -> Vec<u8> {
    let mut renderer = LineRenderer {
        out: Vec::new(),
        last: &DEFAULT_ATTRS,
        in_default: true,
    };
    renderer.out.extend_from_slice(CLEAR_AND_HOME);
    for line in &snapshot.scrollback[scrollback_start.min(snapshot.scrollback.len())..] {
        if let Some(starts) = line_starts.as_deref_mut() {
            starts.push(renderer.out.len());
        }
        renderer.emit_line(line);
        renderer.out.extend_from_slice(LINE_SEPARATOR);
    }
    if snapshot.modes.alt_screen {
        renderer.out.extend_from_slice(ENTER_ALT_SCREEN);
    }
    for (index, line) in snapshot.visible_screen.iter().enumerate() {
        renderer.emit_line(line);
        if index + 1 < snapshot.visible_screen.len() {
            renderer.out.extend_from_slice(LINE_SEPARATOR);
        }
    }
    let mut out = renderer.out;
    if !renderer.in_default {
        out.extend_from_slice(SGR_RESET);
    }
    write_mode_preamble(&mut out, &snapshot.modes);
    out.extend_from_slice(CSI);
    push_decimal(&mut out, u32::from(snapshot.cursor.row) + 1);
    out.push(b';');
    push_decimal(&mut out, u32::from(snapshot.cursor.col) + 1);
    out.push(b'H');
    out.extend_from_slice(if snapshot.cursor.visible { b"\x1b[?25h" } else { b"\x1b[?25l" });
    out
}

struct LineRenderer<'a> {
    out: Vec<u8>,
    last: &'a CellAttrs,
    /// Whether the receiver's SGR state is default; always equals
    /// `is_default(last)` because `last` only changes alongside it.
    in_default: bool,
}

impl<'a> LineRenderer<'a> {
    fn emit_line(&mut self, line: &'a StyledLine) {
        let painted = line
            .cells
            .iter()
            .rposition(|cell| !(is_blank(&cell.ch) && is_default(&cell.attrs)))
            .map_or(0, |index| index + 1);
        for cell in &line.cells[..painted] {
            if cell.attrs != *self.last {
                if !(self.in_default && is_default(&cell.attrs)) {
                    write_sgr(&mut self.out, &cell.attrs);
                    self.in_default = is_default(&cell.attrs);
                }
                self.last = &cell.attrs;
            }
            self.out.extend_from_slice(cell.ch.as_bytes());
        }
    }
}

fn is_blank(ch: &str) -> bool {
    ch.is_empty() || ch == " " || ch == "\u{a0}"
}

fn is_default(attrs: &CellAttrs) -> bool {
    *attrs == DEFAULT_ATTRS
}

fn write_sgr(out: &mut Vec<u8>, attrs: &CellAttrs) {
    out.extend_from_slice(b"\x1b[0");
    for (enabled, param) in [
        (attrs.bold, b"1"),
        (attrs.dim, b"2"),
        (attrs.italic, b"3"),
        (attrs.underline, b"4"),
        (attrs.blink, b"5"),
        (attrs.reverse, b"7"),
        (attrs.hidden, b"8"),
        (attrs.strike, b"9"),
    ] {
        if enabled {
            out.push(b';');
            out.extend_from_slice(param);
        }
    }
    if let Some(fg) = attrs.fg {
        write_rgb(out, b";38;2;", fg);
    }
    if let Some(bg) = attrs.bg {
        write_rgb(out, b";48;2;", bg);
    }
    out.push(b'm');
}

fn write_rgb(out: &mut Vec<u8>, introducer: &[u8], rgb: u32) {
    out.extend_from_slice(introducer);
    push_decimal(out, (rgb >> 16) & 0xff);
    out.push(b';');
    push_decimal(out, (rgb >> 8) & 0xff);
    out.push(b';');
    push_decimal(out, rgb & 0xff);
}

fn write_mode_preamble(out: &mut Vec<u8>, modes: &TerminalModes) {
    if modes.application_cursor {
        out.extend_from_slice(b"\x1b[?1h");
    }
    if modes.origin_mode {
        out.extend_from_slice(b"\x1b[?6h");
    }
    if !modes.auto_wrap {
        out.extend_from_slice(b"\x1b[?7l");
    }
    match modes.mouse_mode {
        MouseMode::X10 => out.extend_from_slice(b"\x1b[?9h"),
        MouseMode::Vt200 => out.extend_from_slice(b"\x1b[?1000h"),
        MouseMode::ButtonEvent => out.extend_from_slice(b"\x1b[?1002h"),
        MouseMode::AnyEvent => out.extend_from_slice(b"\x1b[?1003h"),
        MouseMode::Sgr => out.extend_from_slice(b"\x1b[?1000h\x1b[?1006h"),
        MouseMode::Off => {}
    }
    if modes.bracketed_paste {
        out.extend_from_slice(b"\x1b[?2004h");
    }
    if modes.application_keypad {
        out.extend_from_slice(b"\x1b=");
    }
    if modes.insert_mode {
        out.extend_from_slice(b"\x1b[4h");
    }
}

fn push_decimal(out: &mut Vec<u8>, value: u32) {
    let mut digits = [0u8; 10];
    let mut remaining = value;
    let mut start = digits.len();
    loop {
        start -= 1;
        digits[start] = b'0' + (remaining % 10) as u8;
        remaining /= 10;
        if remaining == 0 {
            break;
        }
    }
    out.extend_from_slice(&digits[start..]);
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::time::Instant;

    use uuid::Uuid;

    use super::*;
    use crate::protocol::{CursorState, ScrollRegion, StyledCell};

    fn cell(ch: &str, attrs: CellAttrs) -> StyledCell {
        StyledCell { ch: Cow::Owned(ch.to_string()), attrs }
    }

    fn styled(text: &str, attrs: &CellAttrs) -> StyledLine {
        StyledLine { cells: text.chars().map(|ch| cell(&ch.to_string(), attrs.clone())).collect(), wrapped: false }
    }

    fn colored(fg: u32) -> CellAttrs {
        CellAttrs { fg: Some(fg), ..CellAttrs::default() }
    }

    fn snapshot(scrollback: Vec<StyledLine>, visible_screen: Vec<StyledLine>) -> Snapshot {
        Snapshot {
            session_id: Uuid::nil(),
            seq: 0,
            cols: 80,
            rows: visible_screen.len() as u16,
            visible_screen,
            scrollback,
            cursor: CursorState { row: 0, col: 0, visible: true, ..CursorState::default() },
            modes: TerminalModes { auto_wrap: true, ..TerminalModes::default() },
            scroll_region: ScrollRegion::default(),
            title: None,
            captured_at_ms: 0,
        }
    }

    /// Mixed history: default text, styled runs, empty lines, and lines whose
    /// first painted cell repeats the previous attrs, so a cut changes the
    /// leading SGR by varying amounts.
    fn mixed_history(count: usize) -> Vec<StyledLine> {
        (0..count)
            .map(|index| match index % 5 {
                0 => styled(&format!("plain line {index}"), &CellAttrs::default()),
                1 => styled(&format!("red {index}"), &colored(0xff_0000)),
                2 => StyledLine::default(),
                3 => styled(&format!("still red {index}"), &colored(0xff_0000)),
                _ => styled("x", &CellAttrs { bold: true, underline: true, bg: Some(0x12_3456), ..colored(0xab_cdef) }),
            })
            .collect()
    }

    fn brute_force(snapshot: &Snapshot, max_bytes: usize) -> BudgetedAnsi {
        for trimmed in 0..=snapshot.scrollback.len() {
            let mut cut = snapshot.clone();
            cut.scrollback.drain(..trimmed);
            let bytes = render_snapshot_ansi(&cut);
            if bytes.len() <= max_bytes || trimmed == snapshot.scrollback.len() {
                return BudgetedAnsi { bytes, trimmed_lines: trimmed };
            }
        }
        unreachable!("the final trim always returns")
    }

    #[test]
    fn budget_matches_brute_force_smallest_fitting_trim_for_every_budget() {
        let snap = snapshot(
            mixed_history(40),
            vec![styled("visible red", &colored(0xff_0000)), styled("prompt$ ", &CellAttrs::default())],
        );
        let full_len = render_snapshot_ansi(&snap).len();
        for max_bytes in 0..=full_len + 1 {
            assert_eq!(
                render_snapshot_ansi_budgeted(&snap, max_bytes),
                brute_force(&snap, max_bytes),
                "max_bytes {max_bytes}"
            );
        }
    }

    #[test]
    fn budget_matches_brute_force_when_history_exceeds_the_initial_window() {
        let snap = snapshot(mixed_history(INITIAL_WINDOW_LINES * 5 + 3), vec![styled("screen", &colored(0x00_00ff))]);
        let full_len = render_snapshot_ansi(&snap).len();
        for max_bytes in (0..=full_len + 1).step_by(full_len / 150) {
            assert_eq!(
                render_snapshot_ansi_budgeted(&snap, max_bytes),
                brute_force(&snap, max_bytes),
                "max_bytes {max_bytes}"
            );
        }
    }

    #[test]
    fn budget_trims_whole_lines_oldest_first_and_keeps_the_visible_screen() {
        let history: Vec<StyledLine> =
            (0..10).map(|index| styled(&format!("history-{index:02}"), &CellAttrs::default())).collect();
        let visible = vec![styled("visible-top", &CellAttrs::default()), styled("visible-bottom", &CellAttrs::default())];
        let snap = snapshot(history, visible);
        let without_history = render_snapshot_ansi(&snapshot(Vec::new(), snap.visible_screen.clone())).len();
        // Room for exactly three 12-byte history lines ("history-NN\r\n").
        let rendered = render_snapshot_ansi_budgeted(&snap, without_history + 3 * 12);
        let text = String::from_utf8(rendered.bytes).expect("utf8");
        assert_eq!(rendered.trimmed_lines, 7);
        assert!(text.starts_with("\x1b[2J\x1b[3J\x1b[H\x1b[0mhistory-07\r\nhistory-08\r\nhistory-09\r\nvisible-top"));
        assert!(!text.contains("history-06"));
        assert!(text.contains("visible-top\r\nvisible-bottom"));
    }

    #[test]
    fn budget_smaller_than_visible_screen_drops_all_history_and_keeps_screen_complete() {
        let visible = vec![styled("a visible row that alone exceeds the budget", &colored(0x00_ff00))];
        let snap = snapshot(mixed_history(12), visible.clone());
        let rendered = render_snapshot_ansi_budgeted(&snap, 8);
        assert_eq!(rendered.trimmed_lines, 12);
        assert_eq!(rendered.bytes, render_snapshot_ansi(&snapshot(Vec::new(), visible)));
        assert!(rendered.bytes.len() > 8);
    }

    #[test]
    fn budget_that_fits_returns_the_full_render_untrimmed() {
        let snap = snapshot(mixed_history(8), vec![styled("screen", &CellAttrs::default())]);
        let full = render_snapshot_ansi(&snap);
        let rendered = render_snapshot_ansi_budgeted(&snap, full.len());
        assert_eq!(rendered, BudgetedAnsi { bytes: full, trimmed_lines: 0 });
    }

    #[test]
    fn max_sgr_bytes_bounds_the_longest_sgr() {
        let mut out = Vec::new();
        write_sgr(
            &mut out,
            &CellAttrs {
                fg: Some(0xff_ffff),
                bg: Some(0xff_ffff),
                bold: true,
                italic: true,
                underline: true,
                reverse: true,
                blink: true,
                strike: true,
                dim: true,
                hidden: true,
            },
        );
        assert_eq!(out.len(), MAX_SGR_BYTES);
    }

    #[test]
    fn push_decimal_formats_boundaries() {
        for value in [0u32, 9, 10, 255, 65_536, u32::MAX] {
            let mut out = Vec::new();
            push_decimal(&mut out, value);
            assert_eq!(out, value.to_string().into_bytes());
        }
    }

    /// Broker-side render cost for the largest history the terminal retains.
    /// Printed for the status report, not asserted.
    #[test]
    fn dense_5000_line_render_timing() {
        let line = |index: usize| StyledLine {
            cells: (0..120)
                .map(|col| {
                    cell(
                        &((b'a' + (col % 26) as u8) as char).to_string(),
                        CellAttrs { fg: Some((index * 7919 + col * 104_729) as u32 & 0xff_ffff), bg: Some((col * 31) as u32), ..CellAttrs::default() },
                    )
                })
                .collect(),
            wrapped: false,
        };
        let snap = snapshot((0..5000).map(line).collect(), (0..50).map(line).collect());
        let started = Instant::now();
        let full = render_snapshot_ansi(&snap);
        let full_elapsed = started.elapsed();
        let started = Instant::now();
        let budgeted = render_snapshot_ansi_budgeted(&snap, 256 * 1024);
        let budget_elapsed = started.elapsed();
        println!(
            "dense 5000x120 render: full {} bytes in {full_elapsed:?}; 256KiB budget {} bytes (trimmed {}) in {budget_elapsed:?}",
            full.len(),
            budgeted.bytes.len(),
            budgeted.trimmed_lines,
        );
        assert!(budgeted.bytes.len() <= 256 * 1024 || budgeted.trimmed_lines == 5000);
    }
}
