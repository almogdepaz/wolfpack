//! Authoritative libghostty-vt terminal state for broker snapshots.
//!
//! Rust retains ownership of PTYs, sessions, replay, sequencing, and the wire
//! snapshot contract. This module owns only terminal semantics through the
//! narrow checked C shim.

use std::ffi::c_void;
use std::ptr::NonNull;

use thiserror::Error;
use uuid::Uuid;

use crate::codec::MAX_FRAME_PAYLOAD;
use crate::protocol::{
    CellAttrs, CursorShape, CursorState, MouseMode, ScrollRegion, Snapshot, StyledCell, StyledLine,
    TerminalModes,
};

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TerminalStateError {
    #[error("ghostty-vt allocation failed")]
    GhosttyAllocation,
    #[error("ghostty-vt {operation} failed with code {code}")]
    GhosttyStatus { operation: &'static str, code: i32 },
    #[error("ghostty-vt extraction exceeded bounded limit during {operation}")]
    GhosttyLimit { operation: &'static str },
    #[error("ghostty-vt invalid text range: offset {offset}, len {len}, buffer {buffer_len}")]
    GhosttyInvalidTextRange {
        offset: usize,
        len: usize,
        buffer_len: usize,
    },
    #[error("ghostty-vt semantic processing failure observed during {operation}")]
    GhosttyVtProcessing { operation: &'static str },
}

const DEFAULT_SCROLLBACK_LIMIT: usize = 5000;
const WP_OK: i32 = 0;
const WP_ERR_NO_SPACE: i32 = -3;
const WP_ERR_OOM: i32 = -4;
const WP_ERR_LIMIT: i32 = -5;
const MAX_EXTRACT_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TITLE_BYTES: usize = 1024 * 1024;

const _: () = assert!(MAX_EXTRACT_TEXT_BYTES < MAX_FRAME_PAYLOAD as usize);
const _: () = assert!(MAX_TITLE_BYTES < MAX_FRAME_PAYLOAD as usize);

#[repr(C)]
struct WpGhosttyTerminal(c_void);

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct WpGhosttySnapshotMeta {
    cols: u16,
    rows: u16,
    cursor_col: u16,
    cursor_row: u16,
    cursor_visible: u8,
    cursor_shape: u8,
    on_alt_screen: u8,
    application_cursor: u8,
    application_keypad: u8,
    bracketed_paste: u8,
    mouse_mode: u8,
    origin_mode: u8,
    auto_wrap: u8,
    insert_mode: u8,
    vt_processing_error: u8,
    scroll_region_top: u16,
    scroll_region_bottom: u16,
    scrollback_rows: usize,
    title_len: usize,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct WpGhosttyRow {
    wrapped: u8,
}

#[repr(C)]
#[derive(Clone, Copy)]
enum WpGhosttyRowSource {
    Active = 1,
    History = 2,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct WpGhosttyCell {
    text_offset: u32,
    text_len: u32,
    fg_rgb: u32,
    bg_rgb: u32,
    has_fg: u8,
    has_bg: u8,
    bold: u8,
    italic: u8,
    underline: u8,
    reverse: u8,
    blink: u8,
    strike: u8,
    dim: u8,
    hidden: u8,
    continuation: u8,
}

extern "C" {
    fn wp_ghostty_terminal_new(
        cols: u16,
        rows: u16,
        scrollback_limit: usize,
    ) -> *mut WpGhosttyTerminal;
    fn wp_ghostty_terminal_free(terminal: *mut WpGhosttyTerminal);
    fn wp_ghostty_terminal_feed(
        terminal: *mut WpGhosttyTerminal,
        data: *const u8,
        len: usize,
    ) -> i32;
    fn wp_ghostty_terminal_resize(terminal: *mut WpGhosttyTerminal, cols: u16, rows: u16) -> i32;
    fn wp_ghostty_terminal_snapshot_meta(
        terminal: *mut WpGhosttyTerminal,
        out: *mut WpGhosttySnapshotMeta,
    ) -> i32;
    fn wp_ghostty_terminal_copy_title(
        terminal: *mut WpGhosttyTerminal,
        buf: *mut u8,
        cap: usize,
        out_len: *mut usize,
    ) -> i32;
    fn wp_ghostty_terminal_extract_rows(
        terminal: *mut WpGhosttyTerminal,
        row_source: WpGhosttyRowSource,
        start_y: usize,
        row_count: u16,
        rows: *mut WpGhosttyRow,
        cells: *mut WpGhosttyCell,
        text: *mut u8,
        text_cap: usize,
        out_text_len: *mut usize,
    ) -> i32;
}

struct GhosttyTerminal {
    raw: NonNull<WpGhosttyTerminal>,
}

impl GhosttyTerminal {
    fn try_new(cols: u16, rows: u16) -> Result<Self, TerminalStateError> {
        // SAFETY: constructor returns either a valid owned terminal handle or NULL.
        let raw =
            unsafe { wp_ghostty_terminal_new(cols.max(1), rows.max(1), DEFAULT_SCROLLBACK_LIMIT) };
        Ok(Self {
            raw: NonNull::new(raw).ok_or(TerminalStateError::GhosttyAllocation)?,
        })
    }

    fn feed(&mut self, bytes: &[u8]) -> Result<(), TerminalStateError> {
        // SAFETY: `self.raw` is an owned live terminal and `bytes` is valid for this call.
        let rc =
            unsafe { wp_ghostty_terminal_feed(self.raw.as_ptr(), bytes.as_ptr(), bytes.len()) };
        status("feed", rc)
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<(), TerminalStateError> {
        // SAFETY: `self.raw` is an owned live terminal. Dimensions are clamped nonzero.
        let rc = unsafe { wp_ghostty_terminal_resize(self.raw.as_ptr(), cols.max(1), rows.max(1)) };
        status("resize", rc)
    }

    fn meta(&self, operation: &'static str) -> Result<WpGhosttySnapshotMeta, TerminalStateError> {
        let mut meta = WpGhosttySnapshotMeta::default();
        // SAFETY: output points to initialized stack storage and `self.raw` is live.
        let rc = unsafe { wp_ghostty_terminal_snapshot_meta(self.raw.as_ptr(), &mut meta) };
        status(operation, rc)?;
        reject_vt_processing_error(meta, operation)?;
        Ok(meta)
    }

    fn title(&self, title_len: usize) -> Result<Option<String>, TerminalStateError> {
        if title_len == 0 {
            return Ok(None);
        }
        if title_len > MAX_TITLE_BYTES {
            return Err(TerminalStateError::GhosttyLimit { operation: "title" });
        }
        let mut bytes = vec![0u8; title_len];
        let mut written = 0usize;
        // SAFETY: buffer is valid for `title_len` bytes and out_len is valid.
        let rc = unsafe {
            wp_ghostty_terminal_copy_title(
                self.raw.as_ptr(),
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut written,
            )
        };
        status("title", rc)?;
        if written > bytes.len() {
            return Err(TerminalStateError::GhosttyInvalidTextRange {
                offset: 0,
                len: written,
                buffer_len: bytes.len(),
            });
        }
        bytes.truncate(written);
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    fn rows(
        &self,
        row_source: WpGhosttyRowSource,
        start_y: usize,
        row_count: u16,
        cols: u16,
    ) -> Result<Vec<StyledLine>, TerminalStateError> {
        if row_count == 0 {
            return Ok(Vec::new());
        }
        let row_count_usize = usize::from(row_count);
        let cols_usize = usize::from(cols);
        let cell_count =
            row_count_usize
                .checked_mul(cols_usize)
                .ok_or(TerminalStateError::GhosttyLimit {
                    operation: "row cell allocation",
                })?;
        let mut rows = vec![WpGhosttyRow::default(); row_count_usize];
        let mut cells = vec![WpGhosttyCell::default(); cell_count];
        let initial_text_capacity = cell_count
            .checked_mul(4)
            .ok_or(TerminalStateError::GhosttyLimit {
                operation: "row text allocation",
            })?
            .clamp(1, MAX_EXTRACT_TEXT_BYTES);
        let mut text = vec![0u8; initial_text_capacity];

        let written = loop {
            let mut written = 0usize;
            // SAFETY: output arrays are sized for the requested row_count/cols, and the text
            // buffer remains live for the complete call. Ordinary snapshots finish in one pass;
            // unusually dense combining text retries with geometrically bounded storage.
            let rc = unsafe {
                wp_ghostty_terminal_extract_rows(
                    self.raw.as_ptr(),
                    row_source,
                    start_y,
                    row_count,
                    rows.as_mut_ptr(),
                    cells.as_mut_ptr(),
                    text.as_mut_ptr(),
                    text.len(),
                    &mut written,
                )
            };
            if rc == WP_OK {
                break written;
            }
            if rc != WP_ERR_NO_SPACE {
                status("row extraction", rc)?;
            }
            if text.len() == MAX_EXTRACT_TEXT_BYTES {
                return Err(TerminalStateError::GhosttyLimit {
                    operation: "row text extraction",
                });
            }
            let next_capacity = text.len().saturating_mul(2).min(MAX_EXTRACT_TEXT_BYTES);
            text.resize(next_capacity, 0);
        };
        if written > text.len() {
            return Err(TerminalStateError::GhosttyInvalidTextRange {
                offset: 0,
                len: written,
                buffer_len: text.len(),
            });
        }
        text.truncate(written);

        rows.into_iter()
            .enumerate()
            .map(|(row_idx, row)| {
                let start = row_idx * cols_usize;
                let cells = cells[start..start + cols_usize]
                    .iter()
                    .map(|cell| cell_to_styled(cell, &text))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(StyledLine {
                    cells,
                    wrapped: row.wrapped != 0,
                })
            })
            .collect()
    }
}

impl Drop for GhosttyTerminal {
    fn drop(&mut self) {
        // SAFETY: `raw` is owned by this wrapper and freed exactly once here.
        unsafe { wp_ghostty_terminal_free(self.raw.as_ptr()) };
    }
}

// SAFETY: Wolfpack serializes every access to a terminal behind the existing
// per-session mutex. The raw handle is never shared independently of this Rust
// wrapper, and all methods require `&mut self` for mutation.
unsafe impl Send for GhosttyTerminal {}

pub struct TerminalState {
    ghostty: GhosttyTerminal,
}

impl TerminalState {
    pub fn try_new(cols: u16, rows: u16) -> Result<Self, TerminalStateError> {
        Ok(Self {
            ghostty: GhosttyTerminal::try_new(cols, rows)?,
        })
    }

    pub fn try_feed(&mut self, bytes: &[u8]) -> Result<(), TerminalStateError> {
        self.ghostty.feed(bytes)
    }

    pub fn try_resize(&mut self, cols: u16, rows: u16) -> Result<(), TerminalStateError> {
        self.ghostty.resize(cols, rows)
    }

    pub fn try_snapshot(
        &self,
        session_id: Uuid,
        seq: u64,
        captured_at_ms: u64,
    ) -> Result<Snapshot, TerminalStateError> {
        self.try_snapshot_with_reflow(session_id, seq, captured_at_ms, None, None)
    }

    pub fn try_snapshot_with_reflow(
        &self,
        session_id: Uuid,
        seq: u64,
        captured_at_ms: u64,
        scrollback_limit: Option<usize>,
        target_cols: Option<usize>,
    ) -> Result<Snapshot, TerminalStateError> {
        let meta = self.ghostty.meta("snapshot")?;
        let visible_screen =
            self.ghostty
                .rows(WpGhosttyRowSource::Active, 0, meta.rows, meta.cols)?;
        let scrollback_count = if meta.on_alt_screen != 0 {
            0
        } else {
            scrollback_limit
                .map(|limit| limit.min(meta.scrollback_rows))
                .unwrap_or(meta.scrollback_rows)
        };
        let scrollback_start = meta.scrollback_rows.saturating_sub(scrollback_count);
        let mut scrollback = Vec::new();
        if scrollback_count > 0 {
            let row_count = u16::try_from(scrollback_count).unwrap_or(u16::MAX);
            scrollback = self.ghostty.rows(
                WpGhosttyRowSource::History,
                scrollback_start,
                row_count,
                meta.cols,
            )?;
        }
        if let Some(target_cols) = target_cols.filter(|cols| *cols > 0) {
            scrollback = reflow_styled_lines(&scrollback, target_cols);
        }

        Ok(Snapshot {
            session_id,
            seq,
            cols: meta.cols,
            rows: meta.rows,
            visible_screen,
            scrollback,
            cursor: cursor_from_meta(meta),
            modes: modes_from_meta(meta),
            scroll_region: scroll_region_from_meta(meta),
            title: self.ghostty.title(meta.title_len)?,
            captured_at_ms,
        })
    }
}

fn status(operation: &'static str, code: i32) -> Result<(), TerminalStateError> {
    match code {
        WP_OK => Ok(()),
        WP_ERR_OOM => Err(TerminalStateError::GhosttyAllocation),
        WP_ERR_LIMIT => Err(TerminalStateError::GhosttyLimit { operation }),
        other => Err(TerminalStateError::GhosttyStatus {
            operation,
            code: other,
        }),
    }
}

fn reject_vt_processing_error(
    meta: WpGhosttySnapshotMeta,
    operation: &'static str,
) -> Result<(), TerminalStateError> {
    if meta.vt_processing_error != 0 {
        Err(TerminalStateError::GhosttyVtProcessing { operation })
    } else {
        Ok(())
    }
}

fn modes_from_meta(meta: WpGhosttySnapshotMeta) -> TerminalModes {
    TerminalModes {
        alt_screen: meta.on_alt_screen != 0,
        application_cursor: meta.application_cursor != 0,
        application_keypad: meta.application_keypad != 0,
        bracketed_paste: meta.bracketed_paste != 0,
        mouse_mode: match meta.mouse_mode {
            1 => MouseMode::X10,
            2 => MouseMode::Vt200,
            3 => MouseMode::ButtonEvent,
            4 => MouseMode::AnyEvent,
            5 => MouseMode::Sgr,
            _ => MouseMode::Off,
        },
        origin_mode: meta.origin_mode != 0,
        auto_wrap: meta.auto_wrap != 0,
        insert_mode: meta.insert_mode != 0,
    }
}

fn scroll_region_from_meta(meta: WpGhosttySnapshotMeta) -> ScrollRegion {
    let last_row = meta.rows.saturating_sub(1);
    let top = meta.scroll_region_top.min(last_row);
    let bottom = meta.scroll_region_bottom.min(last_row);
    if top < bottom {
        ScrollRegion { top, bottom }
    } else {
        ScrollRegion {
            top: 0,
            bottom: last_row,
        }
    }
}

fn cursor_from_meta(meta: WpGhosttySnapshotMeta) -> CursorState {
    CursorState {
        row: meta.cursor_row.min(meta.rows.saturating_sub(1)),
        col: meta.cursor_col.min(meta.cols.saturating_sub(1)),
        visible: meta.cursor_visible != 0,
        shape: match meta.cursor_shape {
            1 => CursorShape::Underline,
            2 => CursorShape::Bar,
            _ => CursorShape::Block,
        },
    }
}

fn cell_to_styled(cell: &WpGhosttyCell, text: &[u8]) -> Result<StyledCell, TerminalStateError> {
    let ch = if cell.continuation != 0 {
        String::new()
    } else if cell.text_len == 0 {
        " ".to_string()
    } else {
        let start = cell.text_offset as usize;
        let len = cell.text_len as usize;
        let end = start
            .checked_add(len)
            .ok_or(TerminalStateError::GhosttyInvalidTextRange {
                offset: start,
                len,
                buffer_len: text.len(),
            })?;
        let slice = text
            .get(start..end)
            .ok_or(TerminalStateError::GhosttyInvalidTextRange {
                offset: start,
                len,
                buffer_len: text.len(),
            })?;
        String::from_utf8_lossy(slice).into_owned()
    };
    Ok(StyledCell {
        ch,
        attrs: CellAttrs {
            fg: (cell.has_fg != 0).then_some(cell.fg_rgb),
            bg: (cell.has_bg != 0).then_some(cell.bg_rgb),
            bold: cell.bold != 0,
            italic: cell.italic != 0,
            underline: cell.underline != 0,
            reverse: cell.reverse != 0,
            blink: cell.blink != 0,
            strike: cell.strike != 0,
            dim: cell.dim != 0,
            hidden: cell.hidden != 0,
        },
    })
}

fn reflow_styled_lines(rows: &[StyledLine], target_cols: usize) -> Vec<StyledLine> {
    let target_cols = target_cols.max(1);
    let mut out = Vec::new();
    let mut para = Vec::new();
    let mut terminal_wrapped = false;
    for row in rows {
        para.extend_from_slice(&row.cells);
        terminal_wrapped = row.wrapped;
        if !row.wrapped {
            flush_styled_paragraph(&mut para, terminal_wrapped, target_cols, &mut out);
        }
    }
    if !para.is_empty() {
        let _ = terminal_wrapped;
        flush_styled_paragraph(&mut para, false, target_cols, &mut out);
    }
    out
}

fn flush_styled_paragraph(
    para: &mut Vec<StyledCell>,
    terminal_wrapped: bool,
    target_cols: usize,
    out: &mut Vec<StyledLine>,
) {
    while let Some(last) = para.last() {
        if last.ch == " " && last.attrs == CellAttrs::default() {
            para.pop();
        } else {
            break;
        }
    }
    if para.is_empty() {
        out.push(StyledLine {
            cells: vec![blank_cell(); target_cols],
            wrapped: false,
        });
        return;
    }

    let mut start = 0usize;
    while start < para.len() {
        let mut end = (start + target_cols).min(para.len());
        if end < para.len() && para[end].ch.is_empty() && end > start {
            end -= 1;
        }
        if end == start {
            end = (start + 2).min(para.len());
        }
        let mut cells = para[start..end].to_vec();
        cells.resize_with(target_cols, blank_cell);
        let is_last = end >= para.len();
        out.push(StyledLine {
            cells,
            wrapped: if is_last { terminal_wrapped } else { true },
        });
        start = end;
    }
    para.clear();
}

fn blank_cell() -> StyledCell {
    StyledCell {
        ch: " ".into(),
        attrs: CellAttrs::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WP_ERR_INVALID: i32 = -1;

    extern "C" {
        fn wp_ghostty_test_required_cps_allocation(required_cps: usize) -> i32;
        fn wp_ghostty_test_accumulate_text(
            used: usize,
            encoded_len: usize,
            cell_used: usize,
        ) -> i32;
        fn wp_ghostty_test_cell_index(
            row_idx: usize,
            cols: u16,
            col: u16,
            out_index: *mut usize,
        ) -> i32;
        fn wp_ghostty_test_point_y(start_y: usize, row_idx: u16, out_y: *mut u32) -> i32;
        fn wp_ghostty_test_row_source_mapping(row_source: i32, out_is_history: *mut u8) -> i32;
    }

    fn line_text(line: &StyledLine) -> String {
        line.cells.iter().map(|cell| cell.ch.as_str()).collect()
    }

    #[test]
    fn c_error_returns_map_to_typed_errors() {
        assert_eq!(status("forced", WP_OK), Ok(()));
        assert!(matches!(
            status("forced", WP_ERR_OOM),
            Err(TerminalStateError::GhosttyAllocation)
        ));
        assert!(matches!(
            status("forced", WP_ERR_LIMIT),
            Err(TerminalStateError::GhosttyLimit {
                operation: "forced"
            })
        ));
        assert!(matches!(
            status("forced", -2),
            Err(TerminalStateError::GhosttyStatus {
                operation: "forced",
                code: -2
            })
        ));
    }

    #[test]
    fn vt_processing_metadata_maps_to_typed_error() {
        let meta = WpGhosttySnapshotMeta {
            vt_processing_error: 1,
            ..Default::default()
        };

        assert!(matches!(
            reject_vt_processing_error(meta, "snapshot"),
            Err(TerminalStateError::GhosttyVtProcessing {
                operation: "snapshot"
            })
        ));
    }

    #[test]
    fn c_checks_reject_unbounded_grapheme_allocation() {
        let too_many = MAX_EXTRACT_TEXT_BYTES;
        assert_eq!(
            unsafe { wp_ghostty_test_required_cps_allocation(too_many) },
            WP_ERR_LIMIT
        );
        assert_eq!(
            unsafe { wp_ghostty_test_required_cps_allocation(usize::MAX) },
            WP_ERR_LIMIT
        );
    }

    #[test]
    fn c_checks_reject_oversized_utf8_accumulation() {
        assert_eq!(
            unsafe { wp_ghostty_test_accumulate_text(MAX_EXTRACT_TEXT_BYTES - 1, 2, 0) },
            WP_ERR_LIMIT
        );
        assert_eq!(
            unsafe { wp_ghostty_test_accumulate_text(0, 1, 4096) },
            WP_ERR_LIMIT
        );
    }

    #[test]
    fn c_row_source_mapping_accepts_only_wolfpack_owned_selectors() {
        let mut is_history = 9u8;
        assert_eq!(
            unsafe {
                wp_ghostty_test_row_source_mapping(
                    WpGhosttyRowSource::Active as i32,
                    &mut is_history,
                )
            },
            WP_OK
        );
        assert_eq!(is_history, 0);

        assert_eq!(
            unsafe {
                wp_ghostty_test_row_source_mapping(
                    WpGhosttyRowSource::History as i32,
                    &mut is_history,
                )
            },
            WP_OK
        );
        assert_eq!(is_history, 1);

        assert_eq!(
            unsafe { wp_ghostty_test_row_source_mapping(3, &mut is_history) },
            WP_ERR_INVALID
        );
        assert_eq!(
            unsafe { wp_ghostty_test_row_source_mapping(99, &mut is_history) },
            WP_ERR_INVALID
        );
    }

    #[test]
    fn c_checks_reject_cell_index_and_coordinate_overflow() {
        let mut index = 0usize;
        assert_eq!(
            unsafe { wp_ghostty_test_cell_index((usize::MAX / 2) + 1, 2, 0, &mut index) },
            WP_ERR_LIMIT
        );
        let mut y = 0u32;
        assert_eq!(
            unsafe { wp_ghostty_test_point_y(u32::MAX as usize, 1, &mut y) },
            WP_ERR_LIMIT
        );
    }

    #[test]
    fn rust_rejects_c_provided_invalid_text_range() {
        let cell = WpGhosttyCell {
            text_offset: 5,
            text_len: 2,
            ..Default::default()
        };
        assert!(matches!(
            cell_to_styled(&cell, b"abcdef"),
            Err(TerminalStateError::GhosttyInvalidTextRange { .. })
        ));
    }

    #[test]
    fn reflow_preserves_wide_continuation_pairs() {
        let rows = vec![StyledLine {
            cells: vec![
                StyledCell {
                    ch: "a".into(),
                    attrs: CellAttrs::default(),
                },
                StyledCell {
                    ch: "界".into(),
                    attrs: CellAttrs::default(),
                },
                StyledCell {
                    ch: String::new(),
                    attrs: CellAttrs::default(),
                },
                StyledCell {
                    ch: "b".into(),
                    attrs: CellAttrs::default(),
                },
            ],
            wrapped: false,
        }];
        let out = reflow_styled_lines(&rows, 2);
        assert_eq!(
            out.iter()
                .flat_map(|row| row.cells.iter())
                .filter(|cell| !cell.ch.is_empty() && cell.ch != " ")
                .map(|cell| cell.ch.as_str())
                .collect::<String>(),
            "a界b"
        );
        for row in out {
            assert_ne!(row.cells.first().map(|cell| cell.ch.as_str()), Some(""));
        }
    }

    #[test]
    fn reflow_trims_only_default_trailing_blanks() {
        let styled_blank = StyledCell {
            ch: " ".into(),
            attrs: CellAttrs {
                bg: Some(0xff00ff),
                ..Default::default()
            },
        };
        let rows = vec![StyledLine {
            cells: vec![
                StyledCell {
                    ch: "a".into(),
                    attrs: CellAttrs::default(),
                },
                styled_blank.clone(),
                blank_cell(),
            ],
            wrapped: false,
        }];
        let out = reflow_styled_lines(&rows, 4);
        assert_eq!(line_text(&out[0]), "a   ");
        assert_eq!(out[0].cells[1], styled_blank);
    }
}
