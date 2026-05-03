# Phase 4 — Visible-Grid Reflow on Resize

Followup to `SCROLLBACK-REFLOW-PLAN.md`. Phases 1-3 fixed scrollback reflow at snapshot time. This phase fixes the visible grid: when the terminal resizes (rotation, keyboard up/down, grid↔single switch), the broker's active grid currently just `resize_with(cols, blank)` — pad/truncate per row, no awareness of paragraphs spanning rows.

## Trigger

Open this when a user reports: "after resizing my terminal, the visible screen content looks wrong — text spilling, cursor in wrong place, prompt half-visible". Phases 1-3 don't address this; the visible grid remains naive.

## Symptom example

```
before resize (cols=120):
  $ very long command that wraps onto next row at col 121 |  ← cursor here
  continuation

after resize to cols=60 (today):
  $ very long command that wraps onto next row at col 121
  | ← cursor lost; line stuck mid-content; no rewrap
```

After fix:
```
  $ very long command that wraps
  onto next row at col 121
  continuation
                      | ← cursor on its content
```

## Architecture

Reuse the same wrap-marker primitive Phase 1 introduced. Visible grid rows already carry `Row.wrapped` (set in `put_char` auto-wrap path). On resize:

1. Coalesce active grid rows into paragraphs using `wrapped` flags
2. Track cursor's current paragraph + cell offset within it (BEFORE rewrap)
3. Rewrap each paragraph at new `cols` using the same `flush_paragraph` logic
4. If rewrap produces > new `rows`: spill the oldest paragraphs into scrollback (primary only — alt is throwaway)
5. If rewrap produces < new `rows`: pad with blank rows at the bottom (or pull from scrollback tail — see "open question")
6. Reposition cursor: find which output row contains the saved cell offset, set (row, col) accordingly

## Files

| File | Change |
| --- | --- |
| `broker/src/terminal_state.rs` | rewrite `Inner::resize` to use paragraph reflow |
| `broker/src/terminal_state.rs` | factor `reflow_lines` / `flush_paragraph` to reuse |
| `broker/src/terminal_state.rs` | new tests for visible-grid resize |

No protocol changes — this is purely server-side. No client changes either; the snapshot already carries reflowed visible rows, and `SessionResized` event semantics are unchanged.

## Tasks

## 1. Cursor offset tracking

Before rewrap, compute `(paragraph_index, cell_offset_in_paragraph)` from current `(cursor.row, cursor.col)`:

```rust
fn cursor_to_logical(grid: &Grid, cursor: &CursorPos) -> (usize, usize) {
    let mut para_idx = 0;
    let mut offset = 0;
    let mut row = 0;
    while row < cursor.row {
        offset += grid.lines[row].cells.len();
        if !grid.lines[row].wrapped {
            para_idx += 1;
            offset = 0;
        }
        row += 1;
    }
    offset += cursor.col;
    (para_idx, offset)
}
```

After rewrap, walk the new rows to find which one contains paragraph `para_idx` at cell `offset`:

```rust
fn logical_to_cursor(rows: &[Row], target_para: usize, target_offset: usize) -> CursorPos {
    let mut para_idx = 0;
    let mut offset = 0;
    for (r, row) in rows.iter().enumerate() {
        if para_idx == target_para && offset + row.cells.len() > target_offset {
            return CursorPos { row: r, col: target_offset - offset };
        }
        offset += row.cells.len();
        if !row.wrapped {
            para_idx += 1;
            offset = 0;
        }
    }
    CursorPos { row: rows.len().saturating_sub(1), col: 0 }
}
```

## 2. Rewrap on resize (primary buffer)

In `Inner::resize` (`terminal_state.rs:279`), before the existing `primary.resize` call:

```rust
let (cur_para, cur_offset) = cursor_to_logical(&self.primary, &self.cursor);
let reflowed = reflow_lines(&self.primary.lines, cols);
// Spill overflow into scrollback (oldest first).
let overflow = reflowed.len().saturating_sub(rows);
for row in reflowed.iter().take(overflow) {
    self.scrollback.push_back(row.clone());
}
while self.scrollback.len() > self.scrollback_max {
    self.scrollback.pop_front();
}
let kept: Vec<Row> = reflowed.into_iter().skip(overflow).collect();
self.primary.lines = kept;
self.primary.lines.resize_with(rows, || blank_line(cols));
self.primary.cols = cols;
self.primary.rows = rows;
self.cursor = logical_to_cursor(&self.primary.lines, cur_para.saturating_sub(overflow), cur_offset);
```

## 3. Alt-screen rewrap (truncate, no scrollback)

For `self.alt`, same rewrap but if it overflows new `rows`, truncate from the TOP (alt screen has no scrollback). TUI apps will issue full redraw on SIGWINCH so any lost content gets repainted by the app itself.

## 4. Tests

```rust
#[test]
fn resize_shrink_rewraps_visible_grid() {
    let mut t = TerminalState::new(10, 3);
    t.feed(b"hello world!"); // wraps in 10 cols
    // Now resize to 5 cols — "hello world!" should re-wrap to 3 rows.
    t.resize(5, 5);
    // verify visible content equivalent paragraph at width 5
}

#[test]
fn resize_grow_unwraps_continuation() {
    let mut t = TerminalState::new(5, 3);
    t.feed(b"helloworld");
    t.resize(20, 3);
    // "helloworld" now fits on one row
}

#[test]
fn resize_overflow_spills_to_scrollback() {
    let mut t = TerminalState::new(20, 3);
    t.feed(b"line1\nline2\nline3");
    t.resize(5, 2); // shrink — first paragraph overflow
    assert!(!t.inner.scrollback.is_empty());
}

#[test]
fn resize_preserves_cursor_relative_position() {
    let mut t = TerminalState::new(10, 3);
    t.feed(b"hello "); // cursor at (0, 6)
    t.resize(3, 5);
    // cursor should still point at the cell after the space — now at (2, 0)
}

#[test]
fn resize_alt_screen_truncates_top() {
    // enter alt, fill with content, shrink, verify top truncated, no scrollback
}

#[test]
fn resize_no_op_when_dims_unchanged() {
    // sanity: resize to same dims must be idempotent
}
```

## Open questions

1. **Pull from scrollback when growing?** tmux does this. Simpler: don't — let the next live PTY redraw fill the new space. Recommendation: defer pulling; ship without and see if anyone cares.
2. **Cursor on a wrapped boundary?** If cursor is exactly at end of a wrapped row (`pending_wrap=true`), is it "on" that row or the next? Decision: treat `pending_wrap` as "cursor is logically at offset = end of this row's cells". Existing emulator semantics already handle this; preserve them.
3. **What about the scroll region?** `scroll_top` / `scroll_bottom` currently get reset in `Inner::resize` (line 284-285). Keep that — TUI apps re-issue DECSTBM on SIGWINCH if they care.
4. **Performance?** Reflow runs on every resize, which is debounced at 80ms server-side. For typical 24-row visible grid, this is microseconds. No concern.

## Estimated effort

~6h focused. Cursor handling is the highest-risk piece — that's where tmux/alacritty have historically had the most reflow bugs. Plan extra test time on cursor invariants.

## When NOT to do this

Skip / defer if:
- Phases 1-3 fully resolve user reports (most likely outcome — the bulk of "weird history" is scrollback)
- We decide to migrate the broker emulator to a vetted crate (vte's `Term`, ghostty's terminal core) — they already implement reflow correctly and we'd inherit it for free

## Related

- `SCROLLBACK-REFLOW-PLAN.md` — Phases 1-3 (shipped)
- tmux `aggressive-resize` — reference behavior
- ghostty's `Terminal.reflow` — reference implementation
