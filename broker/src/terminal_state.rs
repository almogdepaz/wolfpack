//! Minimal vte-driven terminal grid emulator for the broker.
//!
//! The broker owns canonical terminal state per session. PTY output bytes
//! flow through `vte::Parser` and into the data structures here, which
//! preserve a faithful enough screen + scrollback + cursor + mode model to
//! satisfy reconnect-snapshot fidelity for shells and standard TUIs.
//!
//! Scope is intentionally narrow:
//!   * printable cells with SGR-tracked attrs
//!   * cursor and CR/LF/BS/HT
//!   * common CSI cursor moves (CUU/CUD/CUF/CUB/CHA/VPA/CUP/HVP)
//!   * ED (CSI J) and EL (CSI K)
//!   * alt screen (DECSET 47/1047/1049)
//!   * scroll region (DECSTBM, CSI r) with IND/RI/NEL
//!   * common DEC private modes (1, 6, 7, 25, 47, 1047, 1048, 1049, 2004,
//!     9/1000/1002/1003/1006 mouse)
//!
//! Wider features (sixel, charsets, DECCOLM, tab stops, insert/delete line,
//! double-width chars) are out of scope here.

use std::collections::VecDeque;

use uuid::Uuid;
use vte::{Params, Parser, Perform};

use crate::protocol::{
    CellAttrs, CursorShape, CursorState, MouseMode, ScrollRegion, Snapshot, StyledCell,
    StyledLine, TerminalModes,
};

const DEFAULT_SCROLLBACK_LIMIT: usize = 5000;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Cell {
    ch: char,
    attrs: CellAttrs,
}

impl Default for Cell {
    fn default() -> Self {
        Self::blank()
    }
}

impl Cell {
    fn blank() -> Self {
        Self { ch: ' ', attrs: CellAttrs::default() }
    }
    fn with_attrs(attrs: CellAttrs) -> Self {
        Self { ch: ' ', attrs }
    }
}

#[derive(Clone, Debug, Default)]
struct Row {
    cells: Vec<Cell>,
    wrapped: bool,
}

#[derive(Clone, Debug)]
struct ReflowedRow {
    row: Row,
    para_idx: usize,
    start_offset: usize,
    end_offset: usize,
}

#[derive(Clone, Debug)]
struct Grid {
    cols: usize,
    rows: usize,
    lines: Vec<Row>,
}

impl Grid {
    fn new(cols: usize, rows: usize) -> Self {
        Self {
            cols,
            rows,
            lines: (0..rows).map(|_| blank_line(cols)).collect(),
        }
    }

    fn clear_with(&mut self, attrs: &CellAttrs) {
        for line in &mut self.lines {
            for cell in line.cells.iter_mut() {
                *cell = Cell::with_attrs(attrs.clone());
            }
        }
    }
}

fn blank_line(cols: usize) -> Row {
    Row { cells: vec![Cell::blank(); cols], wrapped: false }
}

fn blank_line_with(cols: usize, attrs: &CellAttrs) -> Row {
    Row { cells: vec![Cell::with_attrs(attrs.clone()); cols], wrapped: false }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct CursorPos {
    row: usize,
    col: usize,
}

#[derive(Clone, Debug)]
struct SavedCursor {
    pos: CursorPos,
    sgr: CellAttrs,
}

pub struct TerminalState {
    parser: Parser,
    inner: Inner,
}

struct Inner {
    cols: usize,
    rows: usize,
    primary: Grid,
    alt: Grid,
    on_alt: bool,
    scrollback: VecDeque<Row>,
    scrollback_max: usize,
    cursor: CursorPos,
    saved_primary: Option<SavedCursor>,
    saved_alt: Option<SavedCursor>,
    pending_wrap: bool,
    sgr: CellAttrs,
    scroll_top: usize,
    scroll_bottom: usize,
    modes: TerminalModes,
    cursor_visible: bool,
    title: Option<String>,
}

impl TerminalState {
    pub fn new(cols: u16, rows: u16) -> Self {
        let cols = cols.max(1) as usize;
        let rows = rows.max(1) as usize;
        Self {
            parser: Parser::new(),
            inner: Inner {
                cols,
                rows,
                primary: Grid::new(cols, rows),
                alt: Grid::new(cols, rows),
                on_alt: false,
                scrollback: VecDeque::new(),
                scrollback_max: DEFAULT_SCROLLBACK_LIMIT,
                cursor: CursorPos { row: 0, col: 0 },
                saved_primary: None,
                saved_alt: None,
                pending_wrap: false,
                sgr: CellAttrs::default(),
                scroll_top: 0,
                scroll_bottom: rows - 1,
                modes: TerminalModes { auto_wrap: true, ..Default::default() },
                cursor_visible: true,
                title: None,
            },
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.parser.advance(&mut self.inner, b);
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let cols = cols.max(1) as usize;
        let rows = rows.max(1) as usize;
        self.inner.resize(cols, rows);
    }

    pub fn cols(&self) -> u16 {
        self.inner.cols as u16
    }

    pub fn rows(&self) -> u16 {
        self.inner.rows as u16
    }

    pub fn modes(&self) -> &TerminalModes {
        &self.inner.modes
    }

    pub fn on_alt_screen(&self) -> bool {
        self.inner.on_alt
    }

    pub fn cursor(&self) -> CursorState {
        let inner = &self.inner;
        CursorState {
            row: inner.cursor.row.min(inner.rows.saturating_sub(1)) as u16,
            col: inner.cursor.col.min(inner.cols.saturating_sub(1)) as u16,
            visible: inner.cursor_visible,
            shape: CursorShape::Block,
        }
    }

    pub fn title(&self) -> Option<&str> {
        self.inner.title.as_deref()
    }

    pub fn scroll_region(&self) -> ScrollRegion {
        ScrollRegion {
            top: self.inner.scroll_top as u16,
            bottom: self.inner.scroll_bottom as u16,
        }
    }

    pub fn snapshot(&self, session_id: Uuid, seq: u64, captured_at_ms: u64) -> Snapshot {
        self.snapshot_with_reflow(session_id, seq, captured_at_ms, None, None)
    }

    /// Like `snapshot` but optionally truncates scrollback then reflows to `target_cols`.
    ///
    /// `scrollback_limit` truncates to the last N raw rows BEFORE reflow — the
    /// caller's "how much history" budget. `target_cols` reflowing happens after,
    /// so the returned row count may differ from `scrollback_limit`.
    pub fn snapshot_with_reflow(
        &self,
        session_id: Uuid,
        seq: u64,
        captured_at_ms: u64,
        scrollback_limit: Option<usize>,
        target_cols: Option<usize>,
    ) -> Snapshot {
        let inner = &self.inner;
        let active = if inner.on_alt { &inner.alt } else { &inner.primary };
        let visible_screen = active.lines.iter().map(|l| line_to_styled(l)).collect();

        // Truncate first (at raw-row granularity), then reflow.
        let total = inner.scrollback.len();
        let start = scrollback_limit
            .map(|n| total.saturating_sub(n))
            .unwrap_or(0);
        let scrollback_rows: Vec<Row> = inner.scrollback.iter().skip(start).cloned().collect();
        let scrollback_rows = match target_cols {
            Some(tc) if tc > 0 => reflow_lines(&scrollback_rows, tc),
            _ => scrollback_rows,
        };
        let scrollback = scrollback_rows.iter().map(|l| line_to_styled(l)).collect();
        Snapshot {
            session_id,
            seq,
            cols: inner.cols as u16,
            rows: inner.rows as u16,
            visible_screen,
            scrollback,
            cursor: self.cursor(),
            modes: inner.modes.clone(),
            scroll_region: self.scroll_region(),
            title: inner.title.clone(),
            captured_at_ms,
        }
    }
}

fn line_to_styled(row: &Row) -> StyledLine {
    StyledLine {
        cells: row
            .cells
            .iter()
            .map(|c| StyledCell {
                ch: c.ch.to_string(),
                attrs: c.attrs.clone(),
            })
            .collect(),
        wrapped: row.wrapped,
    }
}

impl Inner {
    fn resize(&mut self, cols: usize, rows: usize) {
        // Capture primary's logical cursor BEFORE mutating the grid. Alt-screen
        // apps (vim, less, fzf) redraw on SIGWINCH so a simple clamp/pad is
        // both correct and avoids producing a corrupted-looking transient frame
        // before the app's own redraw lands.
        let primary_logical = if !self.on_alt {
            Some(cursor_to_logical(&self.primary, &self.cursor))
        } else {
            None
        };

        self.cols = cols;
        self.rows = rows;

        let primary_kept = reflow_grid_for_resize(
            &mut self.primary,
            cols,
            rows,
            Some((&mut self.scrollback, self.scrollback_max)),
        );
        simple_resize_grid(&mut self.alt, cols, rows);

        self.scroll_top = 0;
        self.scroll_bottom = rows - 1;
        self.cursor = if let Some((para, offset)) = primary_logical {
            logical_to_cursor(&primary_kept, para, offset, rows, cols)
        } else {
            CursorPos {
                row: self.cursor.row.min(rows.saturating_sub(1)),
                col: self.cursor.col.min(cols.saturating_sub(1)),
            }
        };
        self.pending_wrap = false;
    }

    fn put_char(&mut self, c: char) {
        if self.modes.auto_wrap && self.pending_wrap {
            // Mark this row as a wrapped continuation before it scrolls out.
            // Inner block ensures the mutable borrow of the grid is released
            // before linefeed() borrows self again.
            {
                let row = self.cursor.row;
                let grid = if self.on_alt { &mut self.alt } else { &mut self.primary };
                if let Some(line) = grid.lines.get_mut(row) {
                    line.wrapped = true;
                }
            }
            self.cursor.col = 0;
            self.linefeed();
            self.pending_wrap = false;
        }
        if self.cursor.col >= self.cols {
            self.cursor.col = self.cols - 1;
        }

        let row = self.cursor.row;
        let col = self.cursor.col;
        let attrs = self.sgr.clone();
        let grid = if self.on_alt { &mut self.alt } else { &mut self.primary };
        if let Some(line) = grid.lines.get_mut(row) {
            if let Some(cell) = line.cells.get_mut(col) {
                cell.ch = c;
                cell.attrs = attrs;
            }
        }

        if col + 1 >= self.cols {
            if self.modes.auto_wrap {
                self.pending_wrap = true;
            }
        } else {
            self.cursor.col += 1;
            self.pending_wrap = false;
        }
    }

    fn carriage_return(&mut self) {
        self.cursor.col = 0;
        self.pending_wrap = false;
    }

    fn linefeed(&mut self) {
        self.pending_wrap = false;
        if self.cursor.row == self.scroll_bottom {
            self.scroll_up(1);
        } else if self.cursor.row + 1 < self.rows {
            self.cursor.row += 1;
        }
    }

    fn next_line(&mut self) {
        self.linefeed();
        self.cursor.col = 0;
    }

    fn reverse_index(&mut self) {
        self.pending_wrap = false;
        if self.cursor.row == self.scroll_top {
            self.scroll_down(1);
        } else if self.cursor.row > 0 {
            self.cursor.row -= 1;
        }
    }

    fn backspace(&mut self) {
        self.pending_wrap = false;
        if self.cursor.col > 0 {
            self.cursor.col -= 1;
        }
    }

    fn tab(&mut self) {
        self.pending_wrap = false;
        let next = ((self.cursor.col / 8) + 1) * 8;
        self.cursor.col = next.min(self.cols.saturating_sub(1));
    }

    fn scroll_up(&mut self, n: usize) {
        let top = self.scroll_top;
        let bottom = self.scroll_bottom;
        if bottom < top {
            return;
        }
        let region_height = bottom - top + 1;
        let n = n.min(region_height);
        let cols = self.cols;
        let attrs = self.sgr.clone();
        // Lines that fall off the top of the primary screen's full-height
        // region (top == 0) flow into scrollback; lines lost from a partial
        // scroll region or from the alt screen do not.
        let push_scrollback = !self.on_alt && top == 0;

        let mut removed: Vec<Row> = Vec::with_capacity(n);
        {
            let grid = if self.on_alt { &mut self.alt } else { &mut self.primary };
            for _ in 0..n {
                let line = grid.lines.remove(top);
                grid.lines.insert(bottom, blank_line_with(cols, &attrs));
                removed.push(line);
            }
        }
        if push_scrollback {
            for line in removed {
                self.push_scrollback(line);
            }
        }
    }

    fn scroll_down(&mut self, n: usize) {
        let top = self.scroll_top;
        let bottom = self.scroll_bottom;
        if bottom < top {
            return;
        }
        let region_height = bottom - top + 1;
        let n = n.min(region_height);
        let cols = self.cols;
        let attrs = self.sgr.clone();
        let grid = if self.on_alt { &mut self.alt } else { &mut self.primary };
        for _ in 0..n {
            let _ = grid.lines.remove(bottom);
            grid.lines.insert(top, blank_line_with(cols, &attrs));
        }
    }

    fn push_scrollback(&mut self, line: Row) {
        self.scrollback.push_back(line);
        while self.scrollback.len() > self.scrollback_max {
            self.scrollback.pop_front();
        }
    }

    fn cursor_up(&mut self, n: usize) {
        self.pending_wrap = false;
        let lower = if self.modes.origin_mode { self.scroll_top } else { 0 };
        let target = self.cursor.row.saturating_sub(n);
        self.cursor.row = target.max(lower);
    }

    fn cursor_down(&mut self, n: usize) {
        self.pending_wrap = false;
        let upper = if self.modes.origin_mode {
            self.scroll_bottom
        } else {
            self.rows - 1
        };
        self.cursor.row = (self.cursor.row + n).min(upper);
    }

    fn cursor_forward(&mut self, n: usize) {
        self.pending_wrap = false;
        self.cursor.col = (self.cursor.col + n).min(self.cols - 1);
    }

    fn cursor_backward(&mut self, n: usize) {
        self.pending_wrap = false;
        self.cursor.col = self.cursor.col.saturating_sub(n);
    }

    fn cursor_column(&mut self, col_1based: usize) {
        self.pending_wrap = false;
        self.cursor.col = col_1based.saturating_sub(1).min(self.cols - 1);
    }

    fn cursor_row(&mut self, row_1based: usize) {
        self.pending_wrap = false;
        self.cursor.row = row_1based.saturating_sub(1).min(self.rows - 1);
    }

    fn cursor_position(&mut self, row_1based: usize, col_1based: usize) {
        self.pending_wrap = false;
        let row = row_1based.saturating_sub(1);
        let col = col_1based.saturating_sub(1).min(self.cols - 1);
        let row = if self.modes.origin_mode {
            (self.scroll_top + row).min(self.scroll_bottom)
        } else {
            row.min(self.rows - 1)
        };
        self.cursor.row = row;
        self.cursor.col = col;
    }

    fn erase_in_display(&mut self, mode: u16) {
        let attrs = self.sgr.clone();
        let cols = self.cols;
        let rows = self.rows;
        let row = self.cursor.row;
        let col = self.cursor.col.min(cols - 1);
        {
            let grid = if self.on_alt { &mut self.alt } else { &mut self.primary };
            match mode {
                0 => {
                    if let Some(line) = grid.lines.get_mut(row) {
                        for cell in line.cells.iter_mut().skip(col) {
                            *cell = Cell::with_attrs(attrs.clone());
                        }
                    }
                    for r in row + 1..rows {
                        grid.lines[r] = blank_line_with(cols, &attrs);
                    }
                }
                1 => {
                    for r in 0..row {
                        grid.lines[r] = blank_line_with(cols, &attrs);
                    }
                    if let Some(line) = grid.lines.get_mut(row) {
                        for cell in line.cells.iter_mut().take(col + 1) {
                            *cell = Cell::with_attrs(attrs.clone());
                        }
                    }
                }
                2 | 3 => {
                    for r in 0..rows {
                        grid.lines[r] = blank_line_with(cols, &attrs);
                    }
                }
                _ => {}
            }
        }
        if mode == 3 {
            self.scrollback.clear();
        }
    }

    fn erase_in_line(&mut self, mode: u16) {
        let attrs = self.sgr.clone();
        let cols = self.cols;
        let row = self.cursor.row;
        let col = self.cursor.col.min(cols - 1);
        let grid = if self.on_alt { &mut self.alt } else { &mut self.primary };
        let line = match grid.lines.get_mut(row) {
            Some(l) => l,
            None => return,
        };
        match mode {
            0 => {
                for cell in line.cells.iter_mut().skip(col) {
                    *cell = Cell::with_attrs(attrs.clone());
                }
            }
            1 => {
                for cell in line.cells.iter_mut().take(col + 1) {
                    *cell = Cell::with_attrs(attrs.clone());
                }
            }
            2 => {
                *line = blank_line_with(cols, &attrs);
            }
            _ => {}
        }
    }

    fn set_scroll_region(&mut self, top_1based: u16, bottom_1based: u16) {
        let top = (top_1based.max(1) as usize).saturating_sub(1);
        let bottom = (bottom_1based.max(1) as usize)
            .saturating_sub(1)
            .min(self.rows - 1);
        if top >= bottom {
            return;
        }
        self.scroll_top = top;
        self.scroll_bottom = bottom;
        let row = if self.modes.origin_mode { self.scroll_top } else { 0 };
        self.cursor = CursorPos { row, col: 0 };
        self.pending_wrap = false;
    }

    fn save_cursor(&mut self) {
        let saved = SavedCursor {
            pos: self.cursor.clone(),
            sgr: self.sgr.clone(),
        };
        if self.on_alt {
            self.saved_alt = Some(saved);
        } else {
            self.saved_primary = Some(saved);
        }
    }

    fn restore_cursor(&mut self) {
        let saved = if self.on_alt {
            self.saved_alt.clone()
        } else {
            self.saved_primary.clone()
        };
        if let Some(SavedCursor { pos, sgr }) = saved {
            self.cursor = pos;
            self.sgr = sgr;
        } else {
            self.cursor = CursorPos { row: 0, col: 0 };
        }
        self.pending_wrap = false;
    }

    fn switch_alt(&mut self, enable: bool, save_restore: bool, clear_on_enter: bool) {
        if enable && !self.on_alt {
            if save_restore {
                self.save_cursor();
            }
            self.on_alt = true;
            self.modes.alt_screen = true;
            if clear_on_enter {
                let attrs = self.sgr.clone();
                self.alt.clear_with(&attrs);
            }
            self.cursor = CursorPos { row: 0, col: 0 };
            self.pending_wrap = false;
        } else if !enable && self.on_alt {
            self.on_alt = false;
            self.modes.alt_screen = false;
            if save_restore {
                self.restore_cursor();
            } else {
                self.pending_wrap = false;
            }
        }
    }

    fn apply_sgr(&mut self, params: &Params) {
        // Flatten semicolon-separated params + colon-packed sub-params into
        // one stream so 38;5;n / 38;2;r;g;b / 38:5:n / 38:2:r:g:b all parse
        // through the same index-based loop.
        let flat: Vec<u16> = params.iter().flat_map(|p| p.iter().copied()).collect();
        if flat.is_empty() {
            self.sgr = CellAttrs::default();
            return;
        }
        let mut i = 0;
        while i < flat.len() {
            let code = flat[i];
            match code {
                0 => self.sgr = CellAttrs::default(),
                1 => self.sgr.bold = true,
                2 => self.sgr.dim = true,
                3 => self.sgr.italic = true,
                4 => self.sgr.underline = true,
                5 | 6 => self.sgr.blink = true,
                7 => self.sgr.reverse = true,
                8 => self.sgr.hidden = true,
                9 => self.sgr.strike = true,
                22 => {
                    self.sgr.bold = false;
                    self.sgr.dim = false;
                }
                23 => self.sgr.italic = false,
                24 => self.sgr.underline = false,
                25 => self.sgr.blink = false,
                27 => self.sgr.reverse = false,
                28 => self.sgr.hidden = false,
                29 => self.sgr.strike = false,
                30..=37 => self.sgr.fg = Some(ansi_color((code - 30) as u8)),
                39 => self.sgr.fg = None,
                40..=47 => self.sgr.bg = Some(ansi_color((code - 40) as u8)),
                49 => self.sgr.bg = None,
                90..=97 => self.sgr.fg = Some(ansi_color((code - 90 + 8) as u8)),
                100..=107 => self.sgr.bg = Some(ansi_color((code - 100 + 8) as u8)),
                38 | 48 => {
                    let is_fg = code == 38;
                    if let Some(mode) = flat.get(i + 1).copied() {
                        match mode {
                            5 => {
                                if let Some(idx) = flat.get(i + 2).copied() {
                                    let color = palette_color(idx as u8);
                                    if is_fg {
                                        self.sgr.fg = Some(color);
                                    } else {
                                        self.sgr.bg = Some(color);
                                    }
                                    i += 3;
                                    continue;
                                }
                            }
                            2 => {
                                if let (Some(r), Some(g), Some(b)) = (
                                    flat.get(i + 2).copied(),
                                    flat.get(i + 3).copied(),
                                    flat.get(i + 4).copied(),
                                ) {
                                    let color = rgb(r, g, b);
                                    if is_fg {
                                        self.sgr.fg = Some(color);
                                    } else {
                                        self.sgr.bg = Some(color);
                                    }
                                    i += 5;
                                    continue;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            i += 1;
        }
    }

    fn set_dec_modes(&mut self, params: &Params, set: bool) {
        for p in params.iter() {
            let code = p.first().copied().unwrap_or(0);
            match code {
                1 => self.modes.application_cursor = set,
                6 => {
                    self.modes.origin_mode = set;
                    let row = if set { self.scroll_top } else { 0 };
                    self.cursor = CursorPos { row, col: 0 };
                    self.pending_wrap = false;
                }
                7 => self.modes.auto_wrap = set,
                25 => self.cursor_visible = set,
                47 => self.switch_alt(set, false, false),
                1047 => self.switch_alt(set, false, true),
                1048 => {
                    if set {
                        self.save_cursor();
                    } else {
                        self.restore_cursor();
                    }
                }
                1049 => self.switch_alt(set, true, true),
                2004 => self.modes.bracketed_paste = set,
                9 => {
                    self.modes.mouse_mode = if set { MouseMode::X10 } else { MouseMode::Off };
                }
                1000 => {
                    self.modes.mouse_mode = if set { MouseMode::Vt200 } else { MouseMode::Off };
                }
                1002 => {
                    self.modes.mouse_mode = if set {
                        MouseMode::ButtonEvent
                    } else {
                        MouseMode::Off
                    };
                }
                1003 => {
                    self.modes.mouse_mode = if set {
                        MouseMode::AnyEvent
                    } else {
                        MouseMode::Off
                    };
                }
                1006 => {
                    if set {
                        self.modes.mouse_mode = MouseMode::Sgr;
                    } else if self.modes.mouse_mode == MouseMode::Sgr {
                        self.modes.mouse_mode = MouseMode::Off;
                    }
                }
                _ => {}
            }
        }
    }

    fn set_ansi_modes(&mut self, params: &Params, set: bool) {
        for p in params.iter() {
            let code = p.first().copied().unwrap_or(0);
            if code == 4 {
                self.modes.insert_mode = set;
            }
        }
    }

    fn full_reset(&mut self) {
        let attrs = CellAttrs::default();
        self.primary.clear_with(&attrs);
        self.alt.clear_with(&attrs);
        self.scrollback.clear();
        self.cursor = CursorPos { row: 0, col: 0 };
        self.sgr = CellAttrs::default();
        self.scroll_top = 0;
        self.scroll_bottom = self.rows - 1;
        self.modes = TerminalModes { auto_wrap: true, ..Default::default() };
        self.on_alt = false;
        self.cursor_visible = true;
        self.title = None;
        self.pending_wrap = false;
        self.saved_primary = None;
        self.saved_alt = None;
    }
}

fn cursor_to_logical(grid: &Grid, cursor: &CursorPos) -> (usize, usize) {
    let mut para_idx = 0;
    let mut offset = 0;
    let cursor_row = cursor.row.min(grid.rows.saturating_sub(1));
    for row_idx in 0..cursor_row {
        if let Some(row) = grid.lines.get(row_idx) {
            offset += row.cells.len();
            if !row.wrapped {
                para_idx += 1;
                offset = 0;
            }
        }
    }
    offset += cursor.col.min(grid.cols.saturating_sub(1));
    (para_idx, offset)
}

fn logical_to_cursor(
    rows: &[ReflowedRow],
    target_para: usize,
    target_offset: usize,
    terminal_rows: usize,
    terminal_cols: usize,
) -> CursorPos {
    let max_row = terminal_rows.saturating_sub(1);
    let max_col = terminal_cols.saturating_sub(1);
    // Track the last row of the matching paragraph so we can clamp when
    // target_offset lands past EOL — this happens because cursor_to_logical
    // sums full row widths but reflow trims trailing pad-blanks, so the
    // cursor's offset can exceed the trimmed paragraph length.
    let mut last_in_para: Option<(usize, &ReflowedRow)> = None;
    for (row_idx, row) in rows.iter().enumerate() {
        if row.para_idx != target_para {
            continue;
        }
        last_in_para = Some((row_idx, row));
        let contains = if row.start_offset == row.end_offset {
            target_offset == row.start_offset
        } else {
            target_offset >= row.start_offset && target_offset < row.end_offset
        };
        if contains {
            return CursorPos {
                row: row_idx.min(max_row),
                col: target_offset
                    .saturating_sub(row.start_offset)
                    .min(max_col),
            };
        }
    }
    if let Some((row_idx, row)) = last_in_para {
        return CursorPos {
            row: row_idx.min(max_row),
            col: target_offset
                .saturating_sub(row.start_offset)
                .min(max_col),
        };
    }
    CursorPos { row: 0, col: 0 }
}

fn simple_resize_grid(grid: &mut Grid, cols: usize, rows: usize) {
    grid.cols = cols;
    grid.rows = rows;
    grid.lines.resize_with(rows, || blank_line(cols));
    for line in &mut grid.lines {
        line.cells.resize_with(cols, Cell::blank);
    }
}

fn reflow_grid_for_resize(
    grid: &mut Grid,
    cols: usize,
    rows: usize,
    scrollback: Option<(&mut VecDeque<Row>, usize)>,
) -> Vec<ReflowedRow> {
    let reflowed = reflow_lines_with_meta(&grid.lines, cols);
    let overflow = reflowed.len().saturating_sub(rows);
    let mut kept: Vec<ReflowedRow> = Vec::with_capacity(rows);

    grid.cols = cols;
    grid.rows = rows;
    grid.lines.clear();
    if let Some((scrollback, scrollback_max)) = scrollback {
        for (idx, row) in reflowed.into_iter().enumerate() {
            if idx < overflow {
                scrollback.push_back(row.row);
            } else {
                grid.lines.push(row.row.clone());
                kept.push(row);
            }
        }
        while scrollback.len() > scrollback_max {
            scrollback.pop_front();
        }
    } else {
        for row in reflowed.into_iter().skip(overflow) {
            grid.lines.push(row.row.clone());
            kept.push(row);
        }
    }
    grid.lines.resize_with(rows, || blank_line(cols));
    kept
}

/// Reflow a slice of scrollback rows to a new column width using wrap markers.
///
/// Rows with `wrapped=true` are continuation lines from auto-wrap — they are
/// coalesced with the next row(s) into a single logical paragraph. Rows with
/// `wrapped=false` are paragraph terminators. The paragraph is then trimmed of
/// trailing padding-blank cells (ch==' ' AND default attrs) and re-split into
/// chunks of `target_cols`, with all chunks except the last marked `wrapped=true`.
///
/// The last chunk of each paragraph carries the source paragraph's own terminal
/// `wrapped` value rather than a hardcoded false. This preserves truth for the
/// case where the paragraph's last stored row bridged into the visible screen
/// (a corner case Phase 3 resolves; until then we propagate rather than lie).
///
/// Invariant: `target_cols >= 1` (caller is responsible; we clamp defensively).
fn reflow_lines(rows: &[Row], target_cols: usize) -> Vec<Row> {
    reflow_lines_with_meta(rows, target_cols)
        .into_iter()
        .map(|r| r.row)
        .collect()
}

fn reflow_lines_with_meta(rows: &[Row], target_cols: usize) -> Vec<ReflowedRow> {
    let target_cols = target_cols.max(1);
    let mut out: Vec<ReflowedRow> = Vec::new();
    let mut para: Vec<Cell> = Vec::new();
    let mut para_terminal_wrapped = false;
    let mut para_idx = 0;

    for row in rows {
        para.extend_from_slice(&row.cells);
        para_terminal_wrapped = row.wrapped;
        if !row.wrapped {
            flush_paragraph(&mut para, para_terminal_wrapped, target_cols, para_idx, &mut out);
            para_idx += 1;
        }
    }
    // Flush any trailing wrapped paragraph (broken wrap-marker sequence).
    // Force terminal_wrapped=false: by definition this IS the last paragraph
    // in this snapshot, so the consumer can rely on "last row never wrapped"
    // regardless of the input's malformedness.
    if !para.is_empty() {
        let _ = para_terminal_wrapped;
        flush_paragraph(&mut para, false, target_cols, para_idx, &mut out);
    }

    out
}

/// Drain `para`, trim trailing pad-blanks, rechunk into `target_cols`-wide rows.
/// Appends results to `out`. Always clears `para`.
fn flush_paragraph(
    para: &mut Vec<Cell>,
    terminal_wrapped: bool,
    target_cols: usize,
    para_idx: usize,
    out: &mut Vec<ReflowedRow>,
) {
    // Trim trailing pad-blank cells: ch==' ' AND default attrs.
    // A space with non-default bg/fg is real styled content and must be kept.
    while let Some(last) = para.last() {
        if last.ch == ' ' && last.attrs == CellAttrs::default() {
            para.pop();
        } else {
            break;
        }
    }

    if para.is_empty() {
        // All-blank paragraph: preserve as one blank row (meaningful vertical spacing).
        out.push(ReflowedRow {
            row: blank_line(target_cols),
            para_idx,
            start_offset: 0,
            end_offset: 0,
        });
        return;
    }

    let mut start = 0;
    while start < para.len() {
        let end = (start + target_cols).min(para.len());
        let mut chunk_cells = para[start..end].to_vec();
        chunk_cells.resize_with(target_cols, Cell::blank);
        let is_last = end >= para.len();
        out.push(ReflowedRow {
            row: Row {
                cells: chunk_cells,
                // All non-last chunks are wrapped continuations. The last chunk
                // propagates the source paragraph's terminal wrapped value —
                // nearly always false, but true if the paragraph bridged into
                // the visible screen (Phase 3 resolves this; preserve truth for now).
                wrapped: if is_last { terminal_wrapped } else { true },
            },
            para_idx,
            start_offset: start,
            end_offset: end,
        });
        start = end;
    }

    para.clear();
}

fn ansi_color(idx: u8) -> u32 {
    const PALETTE: [u32; 16] = [
        0x000000, 0x800000, 0x008000, 0x808000,
        0x000080, 0x800080, 0x008080, 0xc0c0c0,
        0x808080, 0xff0000, 0x00ff00, 0xffff00,
        0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
    ];
    PALETTE.get(idx as usize).copied().unwrap_or(0xffffff)
}

fn palette_color(idx: u8) -> u32 {
    if (idx as usize) < 16 {
        return ansi_color(idx);
    }
    if idx < 232 {
        let n = idx - 16;
        let r = (n / 36) % 6;
        let g = (n / 6) % 6;
        let b = n % 6;
        let map: [u32; 6] = [0, 95, 135, 175, 215, 255];
        return (map[r as usize] << 16) | (map[g as usize] << 8) | map[b as usize];
    }
    let lvl = 8 + 10 * (idx as u32 - 232);
    (lvl << 16) | (lvl << 8) | lvl
}

fn rgb(r: u16, g: u16, b: u16) -> u32 {
    ((r as u32 & 0xff) << 16) | ((g as u32 & 0xff) << 8) | (b as u32 & 0xff)
}

impl Perform for Inner {
    fn print(&mut self, c: char) {
        self.put_char(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            0x07 => {} // BEL
            0x08 => self.backspace(),
            0x09 => self.tab(),
            0x0A | 0x0B | 0x0C => self.linefeed(),
            0x0D => self.carriage_return(),
            _ => {}
        }
    }

    fn csi_dispatch(
        &mut self,
        params: &Params,
        intermediates: &[u8],
        _ignore: bool,
        action: char,
    ) {
        let n_min1 = |idx: usize| -> usize {
            let v = params
                .iter()
                .nth(idx)
                .and_then(|p| p.first().copied())
                .unwrap_or(1);
            if v == 0 { 1 } else { v as usize }
        };
        let n_default = |idx: usize, default: u16| -> u16 {
            params
                .iter()
                .nth(idx)
                .and_then(|p| p.first().copied())
                .unwrap_or(default)
        };
        match (intermediates, action) {
            ([], 'A') => self.cursor_up(n_min1(0)),
            ([], 'B') | ([], 'e') => self.cursor_down(n_min1(0)),
            ([], 'C') | ([], 'a') => self.cursor_forward(n_min1(0)),
            ([], 'D') => self.cursor_backward(n_min1(0)),
            ([], 'E') => {
                let n = n_min1(0);
                self.cursor_down(n);
                self.cursor.col = 0;
            }
            ([], 'F') => {
                let n = n_min1(0);
                self.cursor_up(n);
                self.cursor.col = 0;
            }
            ([], 'G') | ([], '`') => self.cursor_column(n_min1(0)),
            ([], 'H') | ([], 'f') => {
                let row = n_min1(0);
                let col = n_min1(1);
                self.cursor_position(row, col);
            }
            ([], 'J') => self.erase_in_display(n_default(0, 0)),
            ([], 'K') => self.erase_in_line(n_default(0, 0)),
            ([], 'd') => self.cursor_row(n_min1(0)),
            ([], 'm') => self.apply_sgr(params),
            ([], 'r') => {
                let top = n_default(0, 1);
                let bottom = n_default(1, self.rows as u16);
                self.set_scroll_region(top, bottom);
            }
            ([b'?'], 'h') => self.set_dec_modes(params, true),
            ([b'?'], 'l') => self.set_dec_modes(params, false),
            ([], 'h') => self.set_ansi_modes(params, true),
            ([], 'l') => self.set_ansi_modes(params, false),
            ([], 's') => self.save_cursor(),
            ([], 'u') => self.restore_cursor(),
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, byte: u8) {
        match byte {
            b'7' => self.save_cursor(),
            b'8' => self.restore_cursor(),
            b'D' => self.linefeed(),
            b'E' => self.next_line(),
            b'M' => self.reverse_index(),
            b'c' => self.full_reset(),
            _ => {}
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        if params.len() >= 2 {
            let code = params[0];
            if code == b"0" || code == b"1" || code == b"2" {
                if let Ok(s) = std::str::from_utf8(params[1]) {
                    self.title = Some(s.to_string());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line_string(t: &TerminalState, row: usize) -> String {
        let inner = &t.inner;
        let active = if inner.on_alt { &inner.alt } else { &inner.primary };
        active.lines[row].cells.iter().map(|c| c.ch).collect()
    }

    fn cursor_rc(t: &TerminalState) -> (u16, u16) {
        let cs = t.cursor();
        (cs.row, cs.col)
    }

    #[test]
    fn print_writes_chars_and_advances_cursor() {
        let mut t = TerminalState::new(10, 3);
        t.feed(b"abc");
        assert_eq!(&line_string(&t, 0)[..3], "abc");
        assert_eq!(cursor_rc(&t), (0, 3));
    }

    #[test]
    fn cr_resets_column_lf_advances_row() {
        let mut t = TerminalState::new(10, 3);
        t.feed(b"a\r\nb");
        assert_eq!(cursor_rc(&t), (1, 1));
        assert_eq!(line_string(&t, 0).chars().next(), Some('a'));
        assert_eq!(line_string(&t, 1).chars().next(), Some('b'));
    }

    #[test]
    fn lf_at_bottom_scrolls_into_scrollback() {
        let mut t = TerminalState::new(5, 3);
        t.feed(b"a\r\nb\r\nc");
        t.feed(b"\r\nd");
        assert_eq!(t.inner.scrollback.len(), 1);
        assert_eq!(t.inner.scrollback[0].cells[0].ch, 'a');
        assert_eq!(line_string(&t, 0).chars().next(), Some('b'));
        assert_eq!(line_string(&t, 1).chars().next(), Some('c'));
        assert_eq!(line_string(&t, 2).chars().next(), Some('d'));
    }

    #[test]
    fn auto_wrap_wraps_at_last_column() {
        let mut t = TerminalState::new(3, 2);
        t.feed(b"abcd");
        // 'a' (0,0) 'b' (0,1) 'c' (0,2) → pending wrap
        // 'd' triggers wrap → (1,0), prints 'd', cursor (1,1)
        assert_eq!(line_string(&t, 0).chars().take(3).collect::<String>(), "abc");
        assert_eq!(line_string(&t, 1).chars().next(), Some('d'));
        assert_eq!(cursor_rc(&t), (1, 1));
    }

    #[test]
    fn auto_wrap_disabled_overstrikes_last_column() {
        let mut t = TerminalState::new(3, 2);
        t.feed(b"\x1b[?7l"); // disable auto-wrap
        t.feed(b"abcd");
        // 'a' (0,0) 'b' (0,1) 'c' (0,2) → pending_wrap not set (auto-wrap off)
        // 'd' overwrites at (0, 2)
        assert_eq!(line_string(&t, 0).chars().take(3).collect::<String>(), "abd");
        assert_eq!(cursor_rc(&t), (0, 2));
    }

    #[test]
    fn backspace_moves_cursor_left() {
        let mut t = TerminalState::new(10, 2);
        t.feed(b"abc\x08");
        assert_eq!(cursor_rc(&t), (0, 2));
        t.feed(b"\x08\x08\x08\x08"); // can't go below 0
        assert_eq!(cursor_rc(&t), (0, 0));
    }

    #[test]
    fn tab_advances_to_next_8col_stop() {
        let mut t = TerminalState::new(20, 2);
        t.feed(b"\t");
        assert_eq!(cursor_rc(&t), (0, 8));
        t.feed(b"x\t");
        assert_eq!(cursor_rc(&t), (0, 16));
    }

    #[test]
    fn cup_moves_cursor_to_position() {
        let mut t = TerminalState::new(10, 5);
        t.feed(b"\x1b[3;5H");
        assert_eq!(cursor_rc(&t), (2, 4));
    }

    #[test]
    fn cup_default_args_go_home() {
        let mut t = TerminalState::new(10, 5);
        t.feed(b"\x1b[3;5H");
        t.feed(b"\x1b[H");
        assert_eq!(cursor_rc(&t), (0, 0));
    }

    #[test]
    fn cuu_cud_cuf_cub_basic_moves() {
        let mut t = TerminalState::new(10, 5);
        t.feed(b"\x1b[3;5H");
        t.feed(b"\x1b[2A");
        assert_eq!(cursor_rc(&t), (0, 4));
        t.feed(b"\x1b[1B");
        assert_eq!(cursor_rc(&t), (1, 4));
        t.feed(b"\x1b[2C");
        assert_eq!(cursor_rc(&t), (1, 6));
        t.feed(b"\x1b[3D");
        assert_eq!(cursor_rc(&t), (1, 3));
    }

    #[test]
    fn cuu_cud_clamp_at_edges() {
        let mut t = TerminalState::new(10, 5);
        t.feed(b"\x1b[1;1H\x1b[10A"); // up past top
        assert_eq!(cursor_rc(&t), (0, 0));
        t.feed(b"\x1b[5;5H\x1b[20B"); // down past bottom
        assert_eq!(cursor_rc(&t), (4, 4));
    }

    #[test]
    fn cha_and_vpa_set_absolute_column_and_row() {
        let mut t = TerminalState::new(10, 5);
        t.feed(b"\x1b[3;3H");
        t.feed(b"\x1b[7G"); // CHA → col = 7-1 = 6
        assert_eq!(cursor_rc(&t), (2, 6));
        t.feed(b"\x1b[4d"); // VPA → row = 4-1 = 3
        assert_eq!(cursor_rc(&t), (3, 6));
    }

    #[test]
    fn ed_modes_clear_appropriate_regions() {
        let mut t = TerminalState::new(5, 3);
        t.feed(b"abc\r\ndef\r\nghi");
        // ED 2 — entire screen
        t.feed(b"\x1b[2J");
        for r in 0..3 {
            assert!(line_string(&t, r).chars().all(|c| c == ' '));
        }

        // Refill, then ED 0 (cursor to end)
        t.feed(b"\x1b[H");
        t.feed(b"abc\r\ndef\r\nghi");
        t.feed(b"\x1b[2;2H"); // (1,1)
        t.feed(b"\x1b[0J");
        // row 0 unchanged, row 1 has "d" then blanks, row 2 cleared
        assert_eq!(line_string(&t, 0).chars().take(3).collect::<String>(), "abc");
        assert_eq!(line_string(&t, 1).chars().nth(0), Some('d'));
        assert!(line_string(&t, 1).chars().skip(1).all(|c| c == ' '));
        assert!(line_string(&t, 2).chars().all(|c| c == ' '));
    }

    #[test]
    fn ed_mode_1_clears_top_through_cursor() {
        let mut t = TerminalState::new(5, 3);
        t.feed(b"abc\r\ndef\r\nghi");
        t.feed(b"\x1b[2;2H"); // (1,1)
        t.feed(b"\x1b[1J");
        // row 0 cleared, row 1 has blanks then "f", row 2 unchanged
        assert!(line_string(&t, 0).chars().all(|c| c == ' '));
        assert_eq!(line_string(&t, 1).chars().take(2).collect::<String>(), "  ");
        assert_eq!(line_string(&t, 1).chars().nth(2), Some('f'));
        assert_eq!(line_string(&t, 2).chars().take(3).collect::<String>(), "ghi");
    }

    #[test]
    fn el_modes_clear_line_regions() {
        let mut t = TerminalState::new(5, 1);
        t.feed(b"abcde\r");
        t.feed(b"\x1b[K"); // EL 0 from col 0 — clears line
        assert!(line_string(&t, 0).chars().all(|c| c == ' '));

        let mut t = TerminalState::new(5, 1);
        t.feed(b"abcde");
        t.feed(b"\x1b[3G"); // col 3 (0-based 2)
        t.feed(b"\x1b[1K"); // EL 1 — start to cursor inclusive
        assert_eq!(line_string(&t, 0).chars().take(3).collect::<String>(), "   ");
        assert_eq!(line_string(&t, 0).chars().nth(3), Some('d'));

        let mut t = TerminalState::new(5, 1);
        t.feed(b"abcde\r\x1b[3G");
        t.feed(b"\x1b[2K"); // EL 2 — entire line
        assert!(line_string(&t, 0).chars().all(|c| c == ' '));
    }

    #[test]
    fn sgr_tracks_bold_and_color() {
        let mut t = TerminalState::new(10, 1);
        t.feed(b"\x1b[1;31mR");
        let cell = &t.inner.primary.lines[0].cells[0];
        assert!(cell.attrs.bold);
        assert_eq!(cell.attrs.fg, Some(ansi_color(1)));
    }

    #[test]
    fn sgr_reset_clears_attrs() {
        let mut t = TerminalState::new(10, 1);
        t.feed(b"\x1b[1;31mA\x1b[0mB");
        let a = &t.inner.primary.lines[0].cells[0];
        let b = &t.inner.primary.lines[0].cells[1];
        assert!(a.attrs.bold);
        assert_eq!(a.attrs.fg, Some(ansi_color(1)));
        assert!(!b.attrs.bold);
        assert_eq!(b.attrs.fg, None);
    }

    #[test]
    fn sgr_extended_256_and_truecolor() {
        let mut t = TerminalState::new(10, 1);
        t.feed(b"\x1b[38;5;160mP");
        let cell = &t.inner.primary.lines[0].cells[0];
        assert_eq!(cell.attrs.fg, Some(palette_color(160)));

        t.feed(b"\x1b[38;2;10;20;30mT");
        let cell = &t.inner.primary.lines[0].cells[1];
        assert_eq!(cell.attrs.fg, Some(rgb(10, 20, 30)));
    }

    #[test]
    fn sgr_empty_param_resets() {
        let mut t = TerminalState::new(10, 1);
        t.feed(b"\x1b[1mB");
        assert!(t.inner.sgr.bold);
        t.feed(b"\x1b[m");
        assert!(!t.inner.sgr.bold);
    }

    #[test]
    fn alt_screen_1049_isolates_and_restores() {
        let mut t = TerminalState::new(10, 3);
        t.feed(b"primary");
        let primary_cursor_before = cursor_rc(&t);

        t.feed(b"\x1b[?1049h");
        assert!(t.modes().alt_screen);
        assert_eq!(cursor_rc(&t), (0, 0));
        // alt buffer is independent and starts blank
        assert!(line_string(&t, 0).chars().all(|c| c == ' '));

        t.feed(b"alt");
        assert_eq!(line_string(&t, 0).chars().take(3).collect::<String>(), "alt");

        t.feed(b"\x1b[?1049l");
        assert!(!t.modes().alt_screen);
        // primary content is intact
        assert_eq!(line_string(&t, 0).chars().take(7).collect::<String>(), "primary");
        // cursor restored to where it was on primary before the switch
        assert_eq!(cursor_rc(&t), primary_cursor_before);
    }

    #[test]
    fn alt_screen_47_does_not_clear() {
        // ?47 switches buffer without saving cursor or clearing on enter.
        let mut t = TerminalState::new(5, 2);
        t.feed(b"\x1b[?47h"); // enter alt, buffer not cleared
        t.feed(b"X");
        t.feed(b"\x1b[?47l"); // back to primary
        // Re-enter alt — content must still be there because ?47 doesn't clear.
        t.feed(b"\x1b[?47h");
        assert!(t.on_alt_screen());
        assert_eq!(line_string(&t, 0).chars().next(), Some('X'));
    }

    #[test]
    fn scroll_region_constrains_scroll() {
        let mut t = TerminalState::new(5, 5);
        t.feed(b"a\r\nb\r\nc\r\nd\r\ne");
        t.feed(b"\x1b[2;4r"); // region rows 2..4 (0-based 1..3)
        assert_eq!(t.scroll_region(), ScrollRegion { top: 1, bottom: 3 });
        // After DECSTBM cursor goes home (origin off → 0,0)
        assert_eq!(cursor_rc(&t), (0, 0));

        t.feed(b"\x1b[4;1H"); // bottom of region
        t.feed(b"\nx");
        // Region scrolled up by 1: row 1 ('b') is dropped (NOT into scrollback
        // because top != 0), rows 1..3 become c/d/blank, then 'x' overwrites
        // (3, 0).
        assert_eq!(line_string(&t, 0).chars().next(), Some('a'));
        assert_eq!(line_string(&t, 1).chars().next(), Some('c'));
        assert_eq!(line_string(&t, 2).chars().next(), Some('d'));
        assert_eq!(line_string(&t, 3).chars().next(), Some('x'));
        assert_eq!(line_string(&t, 4).chars().next(), Some('e'));
        // Lines that left a partial region must NOT enter scrollback.
        assert!(t.inner.scrollback.is_empty());
    }

    #[test]
    fn reverse_index_at_top_scrolls_down_in_region() {
        let mut t = TerminalState::new(5, 4);
        t.feed(b"a\r\nb\r\nc\r\nd");
        t.feed(b"\x1b[2;3r"); // region rows 2..3 (0-based 1..2)
        t.feed(b"\x1b[2;1H"); // top of region
        t.feed(b"\x1bM"); // RI — should scroll region down by 1
        // After RI: line 1 is blank, line 2 was 'b' (was line 1), line 3
        // unchanged ('d' is below region, line 0 'a' unchanged).
        assert_eq!(line_string(&t, 0).chars().next(), Some('a'));
        assert!(line_string(&t, 1).chars().all(|c| c == ' '));
        assert_eq!(line_string(&t, 2).chars().next(), Some('b'));
        assert_eq!(line_string(&t, 3).chars().next(), Some('d'));
    }

    #[test]
    fn dec_private_modes_round_trip() {
        let mut t = TerminalState::new(10, 3);

        t.feed(b"\x1b[?7l");
        assert!(!t.modes().auto_wrap);
        t.feed(b"\x1b[?7h");
        assert!(t.modes().auto_wrap);

        t.feed(b"\x1b[?25l");
        assert!(!t.cursor().visible);
        t.feed(b"\x1b[?25h");
        assert!(t.cursor().visible);

        t.feed(b"\x1b[?1h");
        assert!(t.modes().application_cursor);

        t.feed(b"\x1b[?2004h");
        assert!(t.modes().bracketed_paste);
        t.feed(b"\x1b[?2004l");
        assert!(!t.modes().bracketed_paste);

        t.feed(b"\x1b[?1000h");
        assert_eq!(t.modes().mouse_mode, MouseMode::Vt200);
        t.feed(b"\x1b[?1006h");
        assert_eq!(t.modes().mouse_mode, MouseMode::Sgr);
    }

    #[test]
    fn origin_mode_constrains_cup_to_region() {
        let mut t = TerminalState::new(10, 5);
        t.feed(b"\x1b[2;4r"); // region rows 2..4 (0-based 1..3)
        t.feed(b"\x1b[?6h"); // origin mode on → cursor goes to top of region
        assert_eq!(cursor_rc(&t), (1, 0));
        // CUP 1;1 in origin mode = top of region
        t.feed(b"\x1b[1;1H");
        assert_eq!(cursor_rc(&t), (1, 0));
        // CUP 99;99 in origin mode clamps to bottom of region
        t.feed(b"\x1b[99;99H");
        assert_eq!(cursor_rc(&t).0, 3);
    }

    #[test]
    fn save_restore_cursor_via_csi_s_u() {
        let mut t = TerminalState::new(10, 3);
        t.feed(b"\x1b[2;3H");
        t.feed(b"\x1b[s");
        t.feed(b"\x1b[1;1H");
        assert_eq!(cursor_rc(&t), (0, 0));
        t.feed(b"\x1b[u");
        assert_eq!(cursor_rc(&t), (1, 2));
    }

    #[test]
    fn save_restore_cursor_via_esc_7_8_preserves_sgr() {
        let mut t = TerminalState::new(10, 3);
        t.feed(b"\x1b[1m");
        t.feed(b"\x1b[2;3H");
        t.feed(b"\x1b7");
        t.feed(b"\x1b[0m");
        t.feed(b"\x1b[1;1H");
        t.feed(b"\x1b8");
        assert_eq!(cursor_rc(&t), (1, 2));
        assert!(t.inner.sgr.bold);
    }

    #[test]
    fn osc_sets_title() {
        let mut t = TerminalState::new(10, 1);
        t.feed(b"\x1b]0;hello\x07");
        assert_eq!(t.title(), Some("hello"));
        t.feed(b"\x1b]2;there\x1b\\");
        assert_eq!(t.title(), Some("there"));
    }

    #[test]
    fn snapshot_serializes_visible_screen_and_cursor() {
        let mut t = TerminalState::new(5, 2);
        t.feed(b"hi");
        let snap = t.snapshot(Uuid::nil(), 1, 2);
        assert_eq!(snap.cols, 5);
        assert_eq!(snap.rows, 2);
        assert_eq!(snap.cursor.col, 2);
        assert_eq!(snap.cursor.row, 0);
        assert_eq!(snap.visible_screen.len(), 2);
        assert_eq!(snap.visible_screen[0].cells[0].ch, "h");
        assert_eq!(snap.visible_screen[0].cells[1].ch, "i");
    }

    #[test]
    fn resize_preserves_cursor_within_bounds() {
        let mut t = TerminalState::new(10, 5);
        t.feed(b"\x1b[3;5H");
        t.resize(4, 2);
        let (r, c) = cursor_rc(&t);
        assert!(r < 2 && c < 4);
        assert_eq!(t.cols(), 4);
        assert_eq!(t.rows(), 2);
    }

    #[test]
    fn scrollback_ring_rotates_at_capacity() {
        // 2-row terminal so each newline past the second pushes a line into
        // scrollback. Cap the ring at 3 so we can observe FIFO eviction.
        let mut t = TerminalState::new(5, 2);
        t.inner.scrollback_max = 3;

        // Push 6 lines: a, b, c, d, e (then cursor sits on row 1 with 'f' typed
        // last — visible). Lines a..d scroll off the top of primary; with cap
        // 3 only the most-recent three (b, c, d) should remain in the ring.
        t.feed(b"a\r\nb\r\nc\r\nd\r\ne\r\nf");

        assert_eq!(t.inner.scrollback.len(), 3);
        assert_eq!(t.inner.scrollback[0].cells[0].ch, 'b');
        assert_eq!(t.inner.scrollback[1].cells[0].ch, 'c');
        assert_eq!(t.inner.scrollback[2].cells[0].ch, 'd');
        // Visible screen still shows the trailing two lines.
        assert_eq!(line_string(&t, 0).chars().next(), Some('e'));
        assert_eq!(line_string(&t, 1).chars().next(), Some('f'));

        // One more newline evicts 'b' and admits 'e'.
        t.feed(b"\r\ng");
        assert_eq!(t.inner.scrollback.len(), 3);
        assert_eq!(t.inner.scrollback[0].cells[0].ch, 'c');
        assert_eq!(t.inner.scrollback[1].cells[0].ch, 'd');
        assert_eq!(t.inner.scrollback[2].cells[0].ch, 'e');
    }

    #[test]
    fn scrollback_ring_only_admits_full_height_primary_scrolls() {
        // Scrolls inside a partial scroll region must NOT enter the ring;
        // alt-screen scrolls likewise must not. Already covered partially by
        // scroll_region_constrains_scroll, but lock it in alongside the
        // ring-rotation contract.
        let mut t = TerminalState::new(5, 4);
        t.inner.scrollback_max = 8;

        // Partial region scroll — top != 0.
        t.feed(b"a\r\nb\r\nc\r\nd");
        t.feed(b"\x1b[2;4r"); // region rows 2..4
        t.feed(b"\x1b[4;1H\nx"); // force region scroll
        assert!(t.inner.scrollback.is_empty());

        // Alt-screen scroll — even with top == 0, must not push.
        let mut t = TerminalState::new(5, 2);
        t.inner.scrollback_max = 8;
        t.feed(b"\x1b[?1049h"); // enter alt
        t.feed(b"a\r\nb\r\nc\r\nd"); // forces alt to scroll
        assert!(t.inner.scrollback.is_empty());
    }

    #[test]
    fn snapshot_populates_all_protocol_fields() {
        let mut t = TerminalState::new(6, 3);
        t.inner.scrollback_max = 4;

        // Build non-trivial state:
        //  * styled cell on visible screen (bold + red fg)
        //  * one line in scrollback
        //  * scroll region narrowed
        //  * title set via OSC
        //  * bracketed-paste mode enabled
        //  * cursor placed at (1, 2)
        t.feed(b"old\r\n"); // 'old' becomes scrollback once we scroll past it
        t.feed(b"row2\r\n");
        t.feed(b"row3\r\n"); // pushes 'old' into scrollback
        t.feed(b"\x1b]2;hello\x07"); // title
        t.feed(b"\x1b[?2004h"); // bracketed paste
        t.feed(b"\x1b[2;4r"); // scroll region rows 2..4 (0-based 1..3, clamped)
        t.feed(b"\x1b[2;3H"); // cursor to (1, 2)
        t.feed(b"\x1b[1;31m"); // bold + red
        t.feed(b"X");

        let sid = Uuid::from_u128(0xdead_beef);
        let snap = t.snapshot(sid, 17, 1_700_000_000_123);

        // Passthrough fields.
        assert_eq!(snap.session_id, sid);
        assert_eq!(snap.seq, 17);
        assert_eq!(snap.captured_at_ms, 1_700_000_000_123);

        // Geometry.
        assert_eq!(snap.cols, 6);
        assert_eq!(snap.rows, 3);

        // Visible screen: shape matches grid; styled cell preserved.
        assert_eq!(snap.visible_screen.len(), 3);
        for line in &snap.visible_screen {
            assert_eq!(line.cells.len(), 6);
        }
        let styled = &snap.visible_screen[1].cells[2];
        assert_eq!(styled.ch, "X");
        assert!(styled.attrs.bold);
        assert_eq!(styled.attrs.fg, Some(ansi_color(1)));

        // Scrollback: the single evicted line, in protocol shape.
        assert_eq!(snap.scrollback.len(), 1);
        let scroll_line: String = snap.scrollback[0]
            .cells
            .iter()
            .map(|c| c.ch.as_str())
            .collect();
        assert!(scroll_line.starts_with("old"));

        // Cursor mirrors live state — printing 'X' at (1,2) advances col to 3.
        assert_eq!(snap.cursor.row, 1);
        assert_eq!(snap.cursor.col, 3);
        assert!(snap.cursor.visible);

        // Modes mirror live state.
        assert!(snap.modes.bracketed_paste);
        assert!(snap.modes.auto_wrap);

        // Scroll region matches DECSTBM (clamped to rows-1).
        assert_eq!(snap.scroll_region.top, 1);
        assert_eq!(snap.scroll_region.bottom, 2);

        // Title from OSC.
        assert_eq!(snap.title.as_deref(), Some("hello"));
    }

    #[test]
    fn snapshot_visible_screen_follows_active_buffer() {
        // On alt screen the visible_screen must reflect the alt grid, and
        // scrollback must stay empty (alt scrolls don't feed the ring).
        let mut t = TerminalState::new(4, 2);
        t.feed(b"primary");
        t.feed(b"\x1b[?1049h"); // enter alt — cleared
        t.feed(b"alt!");

        let snap = t.snapshot(Uuid::nil(), 0, 0);
        let row0: String = snap.visible_screen[0]
            .cells
            .iter()
            .map(|c| c.ch.as_str())
            .collect();
        assert_eq!(row0, "alt!");
        assert!(snap.scrollback.is_empty());
        assert!(snap.modes.alt_screen);
    }

    #[test]
    fn auto_wrap_marks_outgoing_row_as_wrapped() {
        let mut t = TerminalState::new(3, 2);
        t.feed(b"abcd"); // 'abc' fills row 0 → pending wrap; 'd' triggers it
        let snap = t.snapshot(Uuid::nil(), 0, 0);
        assert!(snap.visible_screen[0].wrapped, "auto-wrapped row must be marked");
        assert!(!snap.visible_screen[1].wrapped, "continuation row must not be marked");
    }

    #[test]
    fn explicit_lf_does_not_mark_wrapped() {
        let mut t = TerminalState::new(10, 2);
        t.feed(b"abc\r\nde");
        let snap = t.snapshot(Uuid::nil(), 0, 0);
        assert!(!snap.visible_screen[0].wrapped, "explicit CR+LF must not mark wrapped");
        assert!(!snap.visible_screen[1].wrapped);
    }

    #[test]
    fn wrapped_flag_survives_scroll_into_scrollback() {
        // 3-col terminal: 'abc' fills row 0 → wrapped; 'def' fills row 1 → wrapped;
        // on 'g' row 0 scrolls into scrollback carrying wrapped=true.
        let mut t = TerminalState::new(3, 2);
        t.feed(b"abcdefghi");
        assert!(t.inner.scrollback.len() >= 1);
        assert!(t.inner.scrollback[0].wrapped, "scrollback row from auto-wrap must carry wrapped=true");
    }

    // ── reflow_lines unit tests ──────────────────────────────────────────────

    fn make_row(text: &str, cols: usize, wrapped: bool) -> Row {
        let mut cells: Vec<Cell> = text.chars().map(|c| Cell { ch: c, attrs: CellAttrs::default() }).collect();
        cells.resize_with(cols, Cell::blank);
        Row { cells, wrapped }
    }

    fn row_text(r: &Row) -> String {
        r.cells.iter().map(|c| c.ch).collect()
    }

    #[test]
    fn reflow_empty_input_returns_empty() {
        assert!(reflow_lines(&[], 80).is_empty());
    }

    #[test]
    fn reflow_all_blank_row_preserves_one_blank_row() {
        // A row with all spaces and default attrs — trimming empties the paragraph;
        // must produce exactly one blank row (no content collapse).
        let rows = vec![make_row("     ", 5, false)];
        let out = reflow_lines(&rows, 8);
        assert_eq!(out.len(), 1, "all-blank paragraph must produce one row");
        assert_eq!(out[0].cells.len(), 8);
        assert!(out[0].cells.iter().all(|c| c.ch == ' '));
    }

    #[test]
    fn reflow_short_paragraph_unchanged_content() {
        // "hi" in a 10-col row → reflowed to 5 cols = still one row, no wrap.
        let rows = vec![make_row("hi", 10, false)];
        let out = reflow_lines(&rows, 5);
        assert_eq!(out.len(), 1);
        assert!(!out[0].wrapped, "single-row paragraph must not be marked wrapped");
        let txt = row_text(&out[0]);
        assert!(txt.starts_with("hi"), "content must be preserved");
        assert_eq!(out[0].cells.len(), 5);
    }

    #[test]
    fn reflow_paragraph_exactly_target_width_no_extra_row() {
        let rows = vec![make_row("abcde", 5, false)];
        let out = reflow_lines(&rows, 5);
        assert_eq!(out.len(), 1);
        assert!(!out[0].wrapped);
    }

    #[test]
    fn reflow_long_paragraph_fans_into_chunks() {
        // "abcdefghij" (10 chars) → target 3 → "abc"(w), "def"(w), "ghi"(w), "j  "(!)
        let rows = vec![make_row("abcdefghij", 10, false)];
        let out = reflow_lines(&rows, 3);
        assert_eq!(out.len(), 4);
        // All but the last must be wrapped=true.
        for r in &out[..3] {
            assert!(r.wrapped, "non-last chunks must be wrapped");
        }
        assert!(!out[3].wrapped, "last chunk must not be wrapped");
        // Content order preserved.
        let combined: String = out.iter().flat_map(|r| r.cells.iter().map(|c| c.ch)).collect();
        assert!(combined.starts_with("abcdefghij"));
    }

    #[test]
    fn reflow_multi_row_paragraph_coalesces_and_resplits() {
        // Two wrapped rows at 3 cols containing "abcdef" → coalesce to "abcdef",
        // reflow at 4 → "abcd"(w), "ef  "(!)
        let rows = vec![
            make_row("abc", 3, true),  // wrapped continuation
            make_row("def", 3, false), // paragraph end
        ];
        let out = reflow_lines(&rows, 4);
        assert_eq!(out.len(), 2);
        assert!(out[0].wrapped);
        assert!(!out[1].wrapped);
        let text: String = out[0].cells.iter().chain(out[1].cells.iter()).map(|c| c.ch).collect();
        assert!(text.starts_with("abcdef"));
    }

    #[test]
    fn reflow_styled_space_not_trimmed_as_padding() {
        // A space with non-default attrs (e.g. colored background) is real content;
        // the trimmer must not eat it.
        let mut colored_space = Cell { ch: ' ', attrs: CellAttrs::default() };
        colored_space.attrs.bg = Some(0xff0000); // red background
        let row = Row {
            cells: vec![Cell::blank(), colored_space.clone(), Cell::blank()],
            wrapped: false,
        };
        let out = reflow_lines(&[row], 5);
        assert_eq!(out.len(), 1);
        // The colored space must survive in the output row.
        let has_colored = out[0].cells.iter().any(|c| c.attrs.bg == Some(0xff0000));
        assert!(has_colored, "styled space must not be trimmed as padding");
    }

    #[test]
    fn reflow_preserves_multiple_paragraphs() {
        // Two independent paragraphs (hard line breaks) stay separate.
        let rows = vec![
            make_row("ab", 5, false), // paragraph 1 end
            make_row("cd", 5, false), // paragraph 2 end
        ];
        let out = reflow_lines(&rows, 3);
        assert_eq!(out.len(), 2, "two paragraphs must produce two rows");
        assert!(row_text(&out[0]).starts_with("ab"));
        assert!(row_text(&out[1]).starts_with("cd"));
    }

    #[test]
    fn reflow_via_snapshot_mixes_widths_uniformly() {
        // Session wrote text at 3 cols, then we request snapshot at 5 cols.
        // Visible screen is NOT reflowed; scrollback should be uniform at 5 cols.
        let mut t = TerminalState::new(3, 2);
        // Push lines into scrollback: feed 9 chars (3 rows), 2-row terminal forces scrollback.
        t.feed(b"abcdefghi");
        // scrollback should have at least 1 line at width 3.
        assert!(!t.inner.scrollback.is_empty());
        let snap = t.snapshot_with_reflow(Uuid::nil(), 0, 0, None, Some(5));
        for line in &snap.scrollback {
            assert_eq!(line.cells.len(), 5, "reflowed scrollback row must be 5 cols wide");
        }
        // Visible screen stays at original 3 cols (Phase 4 scope).
        for line in &snap.visible_screen {
            assert_eq!(line.cells.len(), 3);
        }
    }

    #[test]
    fn reflow_target_cols_zero_is_clamped_to_no_reflow() {
        // target_cols=0 → clamp to 1 inside reflow_lines; via snapshot_with_reflow
        // the guard `tc > 0` skips reflow entirely (pass-through).
        let rows = vec![make_row("abcde", 5, false)];
        let out_raw = reflow_lines(&rows, 5);
        let out_zero = reflow_lines(&rows, 0);
        // Both produce one row; zero clamps to 1 col → 5 chunks.
        // The important invariant: no panic.
        assert!(!out_zero.is_empty());
        assert!(!out_raw.is_empty());
    }

    // ── resize cursor remap + alt-screen tests ──────────────────────────────

    #[test]
    fn resize_narrow_cursor_at_eol_preserves_position() {
        // Cursor sitting in the trimmed pad-blank region of the last row of a
        // paragraph — cursor_to_logical computes offset against full row width
        // but reflow trims trailing blanks. Without the EOL clamp the cursor
        // would warp to (0, 0).
        let mut t = TerminalState::new(10, 3);
        t.feed(b"hello"); // cursor at (0, 5), row width 10, trailing 5 blanks
        t.resize(20, 3);
        let (r, c) = cursor_rc(&t);
        // Paragraph "hello" reflows to one row. Cursor lands on that row at the
        // end of content (col 5) rather than warping to (0, 0).
        assert_eq!((r, c), (0, 5));
    }

    #[test]
    fn resize_wide_to_narrow_with_overflow_pushes_to_scrollback() {
        // Visible screen has 3 paragraphs at width 10. Narrowing to width 3
        // splits each paragraph and overflows older content into scrollback.
        let mut t = TerminalState::new(10, 3);
        t.feed(b"aaaaaaaa\r\nbbbbbbbb\r\nccccc"); // three short paragraphs
        let prior_sb = t.inner.scrollback.len();
        t.resize(3, 3);
        assert_eq!(t.cols(), 3);
        assert_eq!(t.rows(), 3);
        assert!(
            t.inner.scrollback.len() > prior_sb,
            "narrowing must push reflowed overflow into scrollback"
        );
    }

    #[test]
    fn resize_alt_screen_does_not_reflow_or_touch_scrollback() {
        // Enter alt screen, write content, resize. Alt-mode apps redraw on
        // SIGWINCH; broker must NOT reflow alt content (would produce a
        // corrupted transient frame) and must NOT push alt rows to scrollback.
        let mut t = TerminalState::new(10, 3);
        t.feed(b"\x1b[?1049h"); // enter alt screen
        t.feed(b"alt-content");
        let pre_sb = t.inner.scrollback.len();
        t.resize(20, 5);
        assert_eq!(t.cols(), 20);
        assert_eq!(t.rows(), 5);
        assert_eq!(
            t.inner.scrollback.len(),
            pre_sb,
            "alt-screen resize must not push to scrollback"
        );
        assert!(t.on_alt_screen());
    }

    #[test]
    fn resize_widen_collapses_wrapped_continuation_into_one_row() {
        // 3-col terminal: 'abcdef' fills two rows (abc | def, first wrapped).
        // Widening to 10 cols should collapse the paragraph into a single row.
        let mut t = TerminalState::new(3, 3);
        t.feed(b"abcdef");
        t.resize(10, 3);
        // Row 0 should now contain "abcdef" (followed by blanks).
        let s = line_string(&t, 0);
        assert!(s.starts_with("abcdef"), "expected collapsed paragraph, got {:?}", s);
    }

    #[test]
    fn resize_cursor_on_wrapped_continuation_remaps() {
        // Write "abcdef" at width 3 (wraps to two rows). Cursor sits at
        // (1, 2) on the 'f' with pending_wrap set. Widening to 10 collapses
        // the paragraph onto row 0; cursor offset = 5 (position of 'f') → (0, 5).
        let mut t = TerminalState::new(3, 3);
        t.feed(b"abcdef");
        t.resize(10, 3);
        let (r, c) = cursor_rc(&t);
        assert_eq!((r, c), (0, 5));
    }

    #[test]
    fn reflow_trailing_wrapped_row_does_not_leak_wrap_to_output() {
        // Malformed input: paragraph ends on wrapped:true (no terminator row).
        // Output's last row MUST be wrapped:false so consumers' structural
        // invariant "last row in buffer is never wrapped" holds regardless
        // of input malformedness.
        let rows = vec![make_row("abc", 3, true)]; // wrapped, no closer
        let out = reflow_lines(&rows, 5);
        assert!(!out.is_empty());
        assert!(
            !out.last().unwrap().wrapped,
            "last output row must never be wrapped, even on malformed input"
        );
    }
}
