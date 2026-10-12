//! Authoritative libghostty-vt terminal state for broker snapshots.
//!
//! Rust retains ownership of PTYs, sessions, replay, sequencing, and the wire
//! snapshot contract. This module owns only terminal semantics through the
//! narrow checked C shim.

use std::borrow::Cow;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::time::{SystemTime, UNIX_EPOCH};

use thiserror::Error;
use uuid::Uuid;

use crate::codec::{MAX_CONTROL_RESPONSE_PAYLOAD, MAX_EVENT_PAYLOAD, MAX_FRAME_PAYLOAD};
use crate::program_status::{
    ProgramStatusAction, ProgramStatusRecords, ProgramStatusReport, MAX_PROGRAM_STATUS_RECORDS,
    MAX_PROGRAM_STATUS_RECORD_TEXT_BYTES,
};
use crate::protocol::{
    CellAttrs, CursorShape, CursorState, MouseMode, ProgramStatusKind, ProgramStatusRecord,
    ProgramStatusState, ScrollRegion, Snapshot, StyledCell, StyledLine, TerminalModes,
    MAX_ANSI_PREFILL_BYTES,
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
const MAX_EXTRACT_CELLS: usize = 2_000_000;
const MAX_TITLE_BYTES: usize = 1024 * 1024;

const _: () = assert!(MAX_EXTRACT_TEXT_BYTES < MAX_FRAME_PAYLOAD as usize);
const _: () = assert!(MAX_TITLE_BYTES < MAX_FRAME_PAYLOAD as usize);
/// Headroom for the non-title, non-prefill fields of a `snapshot_subscribe_ansi` response.
const ANSI_RESPONSE_METADATA_BYTES: usize = 64 * 1024;
// One `snapshot_subscribe_ansi` response must fit a frame: base64 prefill at
// the cap plus a maximal title escaped at 6 bytes per byte (`\u00XX`).
const _: () = assert!(
    (MAX_ANSI_PREFILL_BYTES as usize).div_ceil(3) * 4 + 6 * MAX_TITLE_BYTES + ANSI_RESPONSE_METADATA_BYTES
        <= MAX_CONTROL_RESPONSE_PAYLOAD as usize
);

// Program status JSON is bounded by its text: serde escapes at most 6 bytes
// per input byte (`\u00XX`), plus fixed field overhead per record. One root
// record must fit an event frame; every record must fit a `session_info`
// response next to the SessionInfo metadata.
const PROGRAM_STATUS_RECORD_JSON_BYTES: usize = 6 * MAX_PROGRAM_STATUS_RECORD_TEXT_BYTES + 1024;
const _: () = assert!(PROGRAM_STATUS_RECORD_JSON_BYTES + 1024 <= MAX_EVENT_PAYLOAD as usize);
const _: () = assert!(
    MAX_PROGRAM_STATUS_RECORDS * PROGRAM_STATUS_RECORD_JSON_BYTES + 4 * 1024 * 1024
        <= MAX_CONTROL_RESPONSE_PAYLOAD as usize
);

#[repr(C)]
struct WpGhosttyTerminal(c_void);

/// Mirrors `WpProgramStatusReport` in `ghostty_vt_shim.h`.
#[repr(C)]
struct WpProgramStatusReport {
    state: u8,
    kind: u8,
    progress: i8,
    id: *const u8,
    id_len: usize,
    app: *const u8,
    app_len: usize,
    title: *const u8,
    title_len: usize,
    message: *const u8,
    message_len: usize,
}

/// Mirrors `WpFeedSink` in `ghostty_vt_shim.h`.
#[repr(C)]
struct WpFeedSink {
    ctx: *mut c_void,
    pty_write: Option<unsafe extern "C" fn(ctx: *mut c_void, data: *const u8, len: usize)>,
    program_status: Option<unsafe extern "C" fn(ctx: *mut c_void, report: *const WpProgramStatusReport)>,
    prompt_start: Option<unsafe extern "C" fn(ctx: *mut c_void)>,
}

const WP_PROGRAM_STATUS_IDLE: u8 = 0;
const WP_PROGRAM_STATUS_WORKING: u8 = 1;
const WP_PROGRAM_STATUS_DONE: u8 = 2;
const WP_PROGRAM_STATUS_BLOCKED: u8 = 3;
const WP_PROGRAM_STATUS_ERROR: u8 = 4;
const WP_PROGRAM_STATUS_CLEAR: u8 = 5;
const WP_PROGRAM_STATUS_KIND_PERMISSION: u8 = 1;
const WP_PROGRAM_STATUS_KIND_QUESTION: u8 = 2;
const WP_PROGRAM_STATUS_KIND_AUTH: u8 = 3;

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
        sink: *const WpFeedSink,
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

    fn feed(&mut self, bytes: &[u8], effects: &mut FeedCollector<'_>) -> Result<(), TerminalStateError> {
        let sink = WpFeedSink {
            ctx: (effects as *mut FeedCollector<'_>).cast(),
            pty_write: Some(collect_pty_write),
            program_status: Some(collect_program_status),
            prompt_start: Some(collect_prompt_start),
        };
        // SAFETY: `self.raw` is an owned live terminal and `bytes` is valid for
        // this call. `sink` and the collector it points to outlive the call; the
        // shim invokes the callbacks only synchronously inside it and clears its
        // sink pointer before returning.
        let rc = unsafe {
            wp_ghostty_terminal_feed(self.raw.as_ptr(), bytes.as_ptr(), bytes.len(), &sink)
        };
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

    fn title(&self, title_len: usize) -> Result<Option<Vec<u8>>, TerminalStateError> {
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
        Ok(Some(bytes))
    }

    fn rows(
        &self,
        row_source: WpGhosttyRowSource,
        start_y: usize,
        row_count: u16,
        cols: u16,
    ) -> Result<RawRows, TerminalStateError> {
        if row_count == 0 {
            return Ok(RawRows {
                rows: Vec::new(),
                cells: Vec::new(),
                text: Vec::new(),
                cols: usize::from(cols),
            });
        }
        let row_count_usize = usize::from(row_count);
        let cols_usize = usize::from(cols);
        let cell_count = row_count_usize
            .checked_mul(cols_usize)
            .filter(|count| *count <= MAX_EXTRACT_CELLS)
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

        Ok(RawRows {
            rows,
            cells,
            text,
            cols: cols_usize,
        })
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

/// Owned extraction buffers; no native terminal handle escapes capture.
struct RawRows {
    rows: Vec<WpGhosttyRow>,
    cells: Vec<WpGhosttyCell>,
    text: Vec<u8>,
    cols: usize,
}

impl RawRows {
    fn materialize(self) -> Result<Vec<StyledLine>, TerminalStateError> {
        self.rows
            .into_iter()
            .enumerate()
            .map(|(row_idx, row)| {
                let start = row_idx * self.cols;
                let cells = self.cells[start..start + self.cols]
                    .iter()
                    .map(|cell| cell_to_styled(cell, &self.text))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(StyledLine {
                    cells,
                    wrapped: row.wrapped != 0,
                })
            })
            .collect()
    }
}

pub(crate) struct RawSnapshot {
    session_id: Uuid,
    seq: u64,
    captured_at_ms: u64,
    meta: WpGhosttySnapshotMeta,
    visible_screen: RawRows,
    scrollback: RawRows,
    title: Option<Vec<u8>>,
    target_cols: Option<usize>,
}

impl RawSnapshot {
    pub(crate) fn materialize(self) -> Result<Snapshot, TerminalStateError> {
        let visible_screen = self.visible_screen.materialize()?;
        let mut scrollback = self.scrollback.materialize()?;
        if let Some(target_cols) = self.target_cols.filter(|cols| *cols > 0) {
            scrollback = reflow_styled_lines(&scrollback, target_cols);
        }
        Ok(Snapshot {
            session_id: self.session_id,
            seq: self.seq,
            cols: self.meta.cols,
            rows: self.meta.rows,
            visible_screen,
            scrollback,
            cursor: cursor_from_meta(self.meta),
            modes: modes_from_meta(self.meta),
            scroll_region: scroll_region_from_meta(self.meta),
            title: self.title.map(|bytes| String::from_utf8_lossy(&bytes).into_owned()),
            captured_at_ms: self.captured_at_ms,
        })
    }
}

/// Side effects of one feed beyond terminal state.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct FeedOutcome {
    /// Bytes the broker must write to the PTY: only OSC 7501 query replies.
    pub pty_reply: Vec<u8>,
    /// The program status record set changed during this feed.
    pub program_status_changed: bool,
}

/// libghostty's write_pty is an untyped byte channel shared by every query
/// reply (DA1/DA2, DSR, DECRQM, XTVERSION, OSC color queries, ...) with no
/// structured hook to tell them apart, and the program status query does not
/// pass through the program status callback. The browser terminal already
/// answers the other queries through `/ws/pty` input, so forwarding them here
/// too would double replies in the program's stdin. The OSC 7501 reply is a
/// fixed constant by spec (upstream `stream_terminal.zig`: "The reply is
/// always the same fixed bytes. The specification never allows sending report
/// contents back to the program"), echoing only the query's terminator, and
/// libghostty emits it as one write. Exact equality against the two complete
/// replies therefore matches it and nothing else.
fn is_program_status_query_reply(bytes: &[u8]) -> bool {
    bytes == b"\x1b]7501;?\x1b\\" || bytes == b"\x1b]7501;?\x07"
}

struct FeedCollector<'a> {
    records: &'a mut ProgramStatusRecords,
    outcome: FeedOutcome,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// # Safety
/// `ctx` is the `FeedCollector` passed to `wp_ghostty_terminal_feed`, and
/// `data` is valid for `len` bytes for the duration of the call.
unsafe extern "C" fn collect_pty_write(ctx: *mut c_void, data: *const u8, len: usize) {
    if ctx.is_null() {
        return;
    }
    let collector = &mut *ctx.cast::<FeedCollector<'_>>();
    let bytes = borrowed_bytes(data, len);
    if is_program_status_query_reply(bytes) {
        collector.outcome.pty_reply.extend_from_slice(bytes);
    }
}

/// # Safety
/// A non-null `ptr` must be valid for `len` bytes for the returned lifetime.
unsafe fn borrowed_bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

fn report_action(state: u8) -> Option<ProgramStatusAction> {
    Some(match state {
        WP_PROGRAM_STATUS_IDLE => ProgramStatusAction::Set(ProgramStatusState::Idle),
        WP_PROGRAM_STATUS_WORKING => ProgramStatusAction::Set(ProgramStatusState::Working),
        WP_PROGRAM_STATUS_DONE => ProgramStatusAction::Set(ProgramStatusState::Done),
        WP_PROGRAM_STATUS_BLOCKED => ProgramStatusAction::Set(ProgramStatusState::Blocked),
        WP_PROGRAM_STATUS_ERROR => ProgramStatusAction::Set(ProgramStatusState::Error),
        WP_PROGRAM_STATUS_CLEAR => ProgramStatusAction::Clear,
        _ => return None,
    })
}

fn report_kind(kind: u8) -> Option<ProgramStatusKind> {
    match kind {
        WP_PROGRAM_STATUS_KIND_PERMISSION => Some(ProgramStatusKind::Permission),
        WP_PROGRAM_STATUS_KIND_QUESTION => Some(ProgramStatusKind::Question),
        WP_PROGRAM_STATUS_KIND_AUTH => Some(ProgramStatusKind::Auth),
        _ => None,
    }
}

/// # Safety
/// `ctx` is the `FeedCollector` passed to `wp_ghostty_terminal_feed`; `report`
/// and its strings are valid for the duration of the call.
unsafe extern "C" fn collect_program_status(ctx: *mut c_void, report: *const WpProgramStatusReport) {
    if ctx.is_null() || report.is_null() {
        return;
    }
    let collector = &mut *ctx.cast::<FeedCollector<'_>>();
    let report = &*report;
    let Some(action) = report_action(report.state) else {
        return;
    };
    let parsed = ProgramStatusReport {
        action,
        kind: report_kind(report.kind),
        progress: u8::try_from(report.progress).ok(),
        id: borrowed_bytes(report.id, report.id_len),
        app: borrowed_bytes(report.app, report.app_len),
        title: borrowed_bytes(report.title, report.title_len),
        message: borrowed_bytes(report.message, report.message_len),
    };
    if collector.records.apply(&parsed, now_ms()) {
        collector.outcome.program_status_changed = true;
    }
}

/// # Safety
/// `ctx` is the `FeedCollector` passed to `wp_ghostty_terminal_feed`.
unsafe extern "C" fn collect_prompt_start(ctx: *mut c_void) {
    if ctx.is_null() {
        return;
    }
    let collector = &mut *ctx.cast::<FeedCollector<'_>>();
    if collector.records.drop_transient() {
        collector.outcome.program_status_changed = true;
    }
}

pub struct TerminalState {
    ghostty: GhosttyTerminal,
    program_status: ProgramStatusRecords,
}

impl TerminalState {
    pub fn try_new(cols: u16, rows: u16) -> Result<Self, TerminalStateError> {
        Ok(Self {
            ghostty: GhosttyTerminal::try_new(cols, rows)?,
            program_status: ProgramStatusRecords::default(),
        })
    }

    pub fn try_feed(&mut self, bytes: &[u8]) -> Result<FeedOutcome, TerminalStateError> {
        let mut collector = FeedCollector {
            records: &mut self.program_status,
            outcome: FeedOutcome::default(),
        };
        self.ghostty.feed(bytes, &mut collector)?;
        Ok(collector.outcome)
    }

    /// The root (empty id) program status record, if reported.
    pub fn program_status_root(&self) -> Option<ProgramStatusRecord> {
        self.program_status.root().cloned()
    }

    /// Every program status record, sorted by id.
    pub fn program_status_records(&self) -> Vec<ProgramStatusRecord> {
        self.program_status.records()
    }

    /// The program exited: drop working/blocked/idle records. True on change.
    pub fn drop_transient_program_status(&mut self) -> bool {
        self.program_status.drop_transient()
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
        self.try_capture_snapshot(
            session_id, seq, captured_at_ms, scrollback_limit, target_cols,
        )?.materialize()
    }

    /// Copy bounded native rows/text and metadata while the caller holds the
    /// terminal ordering lock. Styled allocation and reflow happen afterward.
    pub(crate) fn try_capture_snapshot(
        &self,
        session_id: Uuid,
        seq: u64,
        captured_at_ms: u64,
        scrollback_limit: Option<usize>,
        target_cols: Option<usize>,
    ) -> Result<RawSnapshot, TerminalStateError> {
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
        let row_count = u16::try_from(scrollback_count).unwrap_or(u16::MAX);
        let scrollback = self.ghostty.rows(
            WpGhosttyRowSource::History,
            scrollback_start,
            row_count,
            meta.cols,
        )?;
        Ok(RawSnapshot {
            session_id,
            seq,
            captured_at_ms,
            meta,
            visible_screen,
            scrollback,
            title: self.ghostty.title(meta.title_len)?,
            target_cols,
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

#[cfg(test)]
thread_local! {
    pub(crate) static CONVERSION_PROBE: std::cell::RefCell<Option<Box<dyn FnMut()>>> =
        std::cell::RefCell::new(None);
}

fn cell_to_styled(cell: &WpGhosttyCell, text: &[u8]) -> Result<StyledCell, TerminalStateError> {
    #[cfg(test)]
    CONVERSION_PROBE.with(|probe| {
        if let Some(probe) = probe.borrow_mut().as_mut() {
            probe();
        }
    });
    let ch = if cell.continuation != 0 {
        Cow::Borrowed("")
    } else if cell.text_len == 0 {
        Cow::Borrowed(" ")
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
        if slice == b" " {
            Cow::Borrowed(" ")
        } else {
            Cow::Owned(String::from_utf8_lossy(slice).into_owned())
        }
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

    fn line_text(line: &StyledLine) -> String {
        line.cells.iter().map(|cell| cell.ch.as_ref()).collect()
    }

    const OSC_7501_QUERY_ST: &[u8] = b"\x1b]7501;?\x1b\\";
    const OSC_7501_QUERY_BEL: &[u8] = b"\x1b]7501;?\x07";

    #[test]
    fn program_status_query_is_answered_with_exactly_the_fixed_reply() {
        let mut terminal = TerminalState::try_new(80, 24).expect("real terminal");
        let outcome = terminal.try_feed(OSC_7501_QUERY_ST).expect("feed");
        assert_eq!(outcome.pty_reply, OSC_7501_QUERY_ST);
        assert!(!outcome.program_status_changed);
        let outcome = terminal.try_feed(OSC_7501_QUERY_BEL).expect("feed");
        assert_eq!(outcome.pty_reply, OSC_7501_QUERY_BEL);
    }

    #[test]
    fn other_query_replies_are_never_forwarded_by_the_broker() {
        // The browser terminal answers these through /ws/pty input; a broker
        // reply too would double them in the program's stdin.
        let mut terminal = TerminalState::try_new(80, 24).expect("real terminal");
        for query in [
            &b"\x1b[c"[..],      // DA1
            b"\x1b[0c",          // DA1
            b"\x1b[>c",          // DA2
            b"\x1b[5n",          // DSR status
            b"\x1b[6n",          // DSR cursor position
            b"\x1b[>q",          // XTVERSION
            b"\x1b[?2026$p",     // DECRQM
            b"\x1b]10;?\x1b\\", // OSC 10 color query
            b"\x05",             // ENQ
        ] {
            let outcome = terminal.try_feed(query).expect("feed");
            assert!(outcome.pty_reply.is_empty(), "unexpected reply to {query:?}: {:?}", outcome.pty_reply);
        }
        // The emitter's probe pair: only the 7501 reply crosses the broker.
        let mut probe = OSC_7501_QUERY_ST.to_vec();
        probe.extend_from_slice(b"\x1b[c");
        let outcome = terminal.try_feed(&probe).expect("feed");
        assert_eq!(outcome.pty_reply, OSC_7501_QUERY_ST);
    }

    #[test]
    fn program_status_reports_update_records_and_report_changes() {
        let mut terminal = TerminalState::try_new(80, 24).expect("real terminal");
        // "Apply?" in base64; id-less = root record.
        let outcome = terminal
            .try_feed(b"\x1b]7501;state=blocked:kind=permission:app=terraform:msg=QXBwbHk/\x1b\\")
            .expect("feed");
        assert!(outcome.program_status_changed);
        assert!(outcome.pty_reply.is_empty(), "reports are never echoed");
        let root = terminal.program_status_root().expect("root record");
        assert_eq!(root.state, crate::protocol::ProgramStatusState::Blocked);
        assert_eq!(root.kind, Some(crate::protocol::ProgramStatusKind::Permission));
        assert_eq!(root.app.as_deref(), Some("terraform"));
        assert_eq!(root.message.as_deref(), Some("Apply?"));

        // A report split across chunks lands once complete.
        let outcome = terminal.try_feed(b"\x1b]7501;state=working:id=sync:msg=U3lu").expect("feed");
        assert!(!outcome.program_status_changed);
        let outcome = terminal.try_feed(b"Y2luZw==\x07").expect("feed");
        assert!(outcome.program_status_changed);
        assert_eq!(terminal.program_status_records().len(), 2);

        // Identical report: no change.
        let outcome = terminal.try_feed(b"\x1b]7501;state=working:id=sync:msg=U3luY2luZw==\x07").expect("feed");
        assert!(!outcome.program_status_changed);

        // RIS clears every record.
        let outcome = terminal.try_feed(b"\x1bc").expect("feed");
        assert!(outcome.program_status_changed);
        assert!(terminal.program_status_records().is_empty());
    }

    #[test]
    fn primary_shell_prompt_drops_live_program_records() {
        let mut terminal = TerminalState::try_new(80, 24).expect("real terminal");
        terminal.try_feed(b"\x1b]7501;state=working\x07\x1b]7501;state=done:id=build\x07").expect("feed");
        let outcome = terminal.try_feed(b"\x1b]133;A\x07$ ").expect("feed");
        assert!(outcome.program_status_changed);
        let ids: Vec<String> = terminal.program_status_records().into_iter().map(|record| record.id).collect();
        assert_eq!(ids, vec!["build"]);
    }

    #[test]
    fn exit_drop_keeps_done_and_error_records() {
        let mut terminal = TerminalState::try_new(80, 24).expect("real terminal");
        terminal.try_feed(b"\x1b]7501;state=blocked\x07\x1b]7501;state=error:id=x\x07").expect("feed");
        assert!(terminal.drop_transient_program_status());
        assert!(terminal.program_status_root().is_none());
        assert_eq!(terminal.program_status_records().len(), 1);
        assert!(!terminal.drop_transient_program_status());
    }

    #[test]
    fn program_status_reply_matcher_accepts_only_the_two_fixed_replies() {
        assert!(is_program_status_query_reply(OSC_7501_QUERY_ST));
        assert!(is_program_status_query_reply(OSC_7501_QUERY_BEL));
        assert!(!is_program_status_query_reply(b"\x1b]7501;?"));
        assert!(!is_program_status_query_reply(b"\x1b]7501;state=idle\x07"));
        assert!(!is_program_status_query_reply(b"\x1b[?62;22c"));
        assert!(!is_program_status_query_reply(b"\x1b]7501;?\x1b\\\x1b[?62;22c"));
    }

    #[test]
    fn dense_styled_snapshot_matches_pre_split_json() {
        let mut terminal = TerminalState::try_new(4, 2).expect("real terminal");
        terminal.try_feed("\x1b]2;fixture\x07\x1b[1;31mAB界\r\nCDef\r\n\x1b[0;44mghij\r\nklmn".as_bytes())
            .expect("native feed");
        let snapshot = terminal.try_snapshot_with_reflow(Uuid::nil(), 7, 123, None, Some(3))
            .expect("snapshot");
        let encoded = serde_json::to_string(&snapshot).expect("serialize");
        assert_eq!(encoded, include_str!("../tests/fixtures/dense-styled-snapshot.json").trim());
    }

    #[test]
    fn snapshot_glyphs_outlive_terminal_and_mutate_independently() {
        let mut terminal = TerminalState::try_new(8, 2).expect("real terminal");
        terminal.try_feed("\x1b[1m 界é\x1b[0m".as_bytes()).expect("native feed");
        let mut snapshot = terminal.try_snapshot_with_reflow(Uuid::nil(), 1, 0, None, None)
            .expect("snapshot");
        drop(terminal);
        assert_eq!(snapshot.visible_screen[0].cells[0].ch, " ");
        assert!(snapshot.visible_screen[0].cells[0].attrs.bold);
        assert_eq!(snapshot.visible_screen[0].cells[1].ch, "界");
        assert_eq!(snapshot.visible_screen[0].cells[2].ch, "");
        assert_eq!(snapshot.visible_screen[0].cells[3].ch, "é");
        assert!(matches!(snapshot.visible_screen[0].cells[0].ch, Cow::Borrowed(" ")));
        assert!(matches!(snapshot.visible_screen[0].cells[1].ch, Cow::Owned(_)));
        assert!(matches!(snapshot.visible_screen[0].cells[2].ch, Cow::Borrowed("")));
        assert!(matches!(snapshot.visible_screen[0].cells[3].ch, Cow::Owned(_)));
        assert!(matches!(snapshot.visible_screen[0].cells[4].ch, Cow::Borrowed(" ")));
        let original = snapshot.clone();
        snapshot.visible_screen[0].cells[0].ch.to_mut().push('x');
        snapshot.visible_screen[0].cells[2].ch.to_mut().push('!');
        assert_eq!(original.visible_screen[0].cells[0].ch, " ");
        assert_eq!(original.visible_screen[0].cells[2].ch, "");
        assert_eq!(snapshot.visible_screen[0].cells[0].ch, " x");
        assert_eq!(snapshot.visible_screen[0].cells[2].ch, "!");
        let encoded = serde_json::to_string(&original).expect("wire serialize");
        let mut decoded: Snapshot = serde_json::from_str(&encoded).expect("wire deserialize");
        drop(encoded);
        assert_eq!(decoded, original);
        assert!(decoded.visible_screen.iter().chain(&decoded.scrollback)
            .flat_map(|line| &line.cells)
            .all(|cell| matches!(cell.ch, Cow::Owned(_))));
        decoded.visible_screen[0].cells[0].ch.to_mut().push('y');
        assert_eq!(decoded.visible_screen[0].cells[0].ch, " y");
        assert_eq!(original.visible_screen[0].cells[0].ch, " ");
    }

    #[test]
    fn converted_text_owns_native_buffer_and_preserves_lossy_utf8() {
        let implicit = cell_to_styled(&WpGhosttyCell::default(), &[])
            .expect("real implicit-space conversion");
        assert!(matches!(implicit.ch, Cow::Borrowed(" ")));
        let explicit = cell_to_styled(&WpGhosttyCell {
            text_len: 1,
            ..Default::default()
        }, b" ").expect("real explicit-space conversion");
        assert!(matches!(explicit.ch, Cow::Borrowed(" ")));
        let continuation = cell_to_styled(&WpGhosttyCell {
            continuation: 1,
            ..Default::default()
        }, &[]).expect("real wide-continuation conversion");
        assert!(matches!(continuation.ch, Cow::Borrowed("")));
        let nonblank = cell_to_styled(&WpGhosttyCell {
            text_len: 1,
            ..Default::default()
        }, b"a").expect("real nonblank conversion");
        assert_eq!(nonblank.ch, "a");
        assert!(matches!(nonblank.ch, Cow::Owned(_)));
        let bytes = vec![0xff, b'a'];
        let cell = cell_to_styled(&WpGhosttyCell {
            text_len: 2,
            ..Default::default()
        }, &bytes).expect("real checked conversion");
        drop(bytes);
        assert_eq!(cell.ch, "�a");
        assert!(matches!(cell.ch, Cow::Owned(_)));
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
                    ch: String::new().into(),
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
                .map(|cell| cell.ch.as_ref())
                .collect::<String>(),
            "a界b"
        );
        for row in out {
            assert_ne!(row.cells.first().map(|cell| cell.ch.as_ref()), Some(""));
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
