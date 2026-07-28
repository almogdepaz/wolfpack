#include "ghostty_vt_shim.h"

#include <limits.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include <ghostty/vt.h>

#define WP_OK 0
#define WP_ERR_INVALID -1
#define WP_ERR_GHOSTTY -2
#define WP_ERR_NO_SPACE -3
#define WP_ERR_OOM -4
#define WP_ERR_LIMIT -5

struct WpGhosttyTerminal {
  GhosttyTerminal terminal;
  GhosttyRenderState render;
};

static uint32_t rgb_u32(GhosttyColorRgb rgb) {
  return ((uint32_t)rgb.r << 16) | ((uint32_t)rgb.g << 8) | (uint32_t)rgb.b;
}

static GhosttyResult apply_wolfpack_ansi_palette(GhosttyTerminal terminal) {
  GhosttyColorRgb palette[256];
  // Void initializer: no Ghostty status exists to check here.
  ghostty_color_palette_default(palette);
  // Keep these first 16 entries synchronized with src/terminal-theme.ts.
  // The broker snapshot renderer materializes palette-indexed SGR as RGB;
  // if this diverges from the browser terminal palette, prefilled grid cells
  // render old colors while live output uses the current theme.
  const GhosttyColorRgb ansi[16] = {
      {0x0a, 0x0a, 0x0a}, {0xcc, 0x33, 0x33}, {0x2f, 0x7d, 0x32}, {0xc9, 0xa2, 0x27},
      {0x4f, 0x8c, 0xff}, {0xb6, 0x6c, 0xff}, {0x4c, 0xc9, 0xd8}, {0xd8, 0xd8, 0xd8},
      {0x55, 0x55, 0x55}, {0xff, 0x66, 0x66}, {0x4a, 0xde, 0x80}, {0xff, 0xdd, 0x66},
      {0x93, 0xc5, 0xfd}, {0xf0, 0xab, 0xfc}, {0xa5, 0xf3, 0xfc}, {0xff, 0xff, 0xff},
  };
  memcpy(palette, ansi, sizeof(ansi));
  return ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, palette);
}

static GhosttyResult apply_wolfpack_contract_options(GhosttyTerminal terminal) {
  uint64_t disabled_storage = 0;
  bool disabled = false;
  GhosttyResult result = ghostty_terminal_set(
      terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT, &disabled_storage);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_FILE, &disabled);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_SHARED_MEM, &disabled);
  if (result != GHOSTTY_SUCCESS) return result;
  return ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_GLYPH_PROTOCOL, &disabled);
}

static int style_color_to_rgb(
    GhosttyStyleColor color,
    const GhosttyColorRgb palette[256],
    uint32_t* out_rgb,
    uint8_t* out_has) {
  *out_has = 0;
  *out_rgb = 0;
  switch (color.tag) {
    case GHOSTTY_STYLE_COLOR_NONE:
      return WP_OK;
    case GHOSTTY_STYLE_COLOR_PALETTE:
      *out_has = 1;
      *out_rgb = rgb_u32(palette[color.value.palette]);
      return WP_OK;
    case GHOSTTY_STYLE_COLOR_RGB:
      *out_has = 1;
      *out_rgb = rgb_u32(color.value.rgb);
      return WP_OK;
    default:
      return WP_ERR_GHOSTTY;
  }
}

static int encode_utf8(uint32_t cp, uint8_t out[4], size_t* out_len) {
  if (cp <= 0x7F) {
    out[0] = (uint8_t)cp;
    *out_len = 1;
    return WP_OK;
  }
  if (cp <= 0x7FF) {
    out[0] = (uint8_t)(0xC0 | (cp >> 6));
    out[1] = (uint8_t)(0x80 | (cp & 0x3F));
    *out_len = 2;
    return WP_OK;
  }
  if (cp >= 0xD800 && cp <= 0xDFFF) {
    return WP_ERR_INVALID;
  }
  if (cp <= 0xFFFF) {
    out[0] = (uint8_t)(0xE0 | (cp >> 12));
    out[1] = (uint8_t)(0x80 | ((cp >> 6) & 0x3F));
    out[2] = (uint8_t)(0x80 | (cp & 0x3F));
    *out_len = 3;
    return WP_OK;
  }
  if (cp <= 0x10FFFF) {
    out[0] = (uint8_t)(0xF0 | (cp >> 18));
    out[1] = (uint8_t)(0x80 | ((cp >> 12) & 0x3F));
    out[2] = (uint8_t)(0x80 | ((cp >> 6) & 0x3F));
    out[3] = (uint8_t)(0x80 | (cp & 0x3F));
    *out_len = 4;
    return WP_OK;
  }
  return WP_ERR_INVALID;
}

static int checked_add_size(size_t a, size_t b, size_t* out) {
  if (a > SIZE_MAX - b) return WP_ERR_LIMIT;
  *out = a + b;
  return WP_OK;
}

static int checked_u32_from_size(size_t value, uint32_t* out) {
  if (value > UINT32_MAX) return WP_ERR_LIMIT;
  *out = (uint32_t)value;
  return WP_OK;
}

static int checked_cell_index(size_t row_idx, uint16_t cols, uint16_t col, size_t* out) {
  size_t base = 0;
  if (cols != 0 && row_idx > SIZE_MAX / (size_t)cols) return WP_ERR_LIMIT;
  base = row_idx * (size_t)cols;
  return checked_add_size(base, (size_t)col, out);
}

static int checked_point_y(size_t start_y, uint16_t row_idx, uint32_t* out_y) {
  size_t y = 0;
  int rc = checked_add_size(start_y, (size_t)row_idx, &y);
  if (rc != WP_OK) return rc;
  return checked_u32_from_size(y, out_y);
}

static int terminal_bool_mode(GhosttyTerminal terminal, GhosttyMode mode, uint8_t* out) {
  bool value = false;
  GhosttyResult result = ghostty_terminal_mode_get(terminal, mode, &value);
  if (result != GHOSTTY_SUCCESS) return WP_ERR_GHOSTTY;
  *out = value ? 1 : 0;
  return WP_OK;
}

static int row_source_to_point_tag(WpGhosttyRowSource row_source, GhosttyPointTag* out_tag) {
  if (out_tag == NULL) return WP_ERR_INVALID;
  switch (row_source) {
    case WP_GHOSTTY_ROW_SOURCE_ACTIVE:
      *out_tag = GHOSTTY_POINT_TAG_ACTIVE;
      return WP_OK;
    case WP_GHOSTTY_ROW_SOURCE_HISTORY:
      *out_tag = GHOSTTY_POINT_TAG_HISTORY;
      return WP_OK;
    default:
      return WP_ERR_INVALID;
  }
}

WpGhosttyTerminal* wp_ghostty_terminal_new(uint16_t cols, uint16_t rows, size_t scrollback_limit) {
  if (cols == 0 || rows == 0) return NULL;

  GhosttyTerminal terminal = NULL;
  GhosttyTerminalOptions options = {
      .cols = cols,
      .rows = rows,
      .max_scrollback = scrollback_limit,
  };
  if (ghostty_terminal_new(NULL, &terminal, options) != GHOSTTY_SUCCESS) return NULL;
  if (apply_wolfpack_ansi_palette(terminal) != GHOSTTY_SUCCESS) {
    ghostty_terminal_free(terminal);
    return NULL;
  }

  GhosttyRenderState render = NULL;
  if (ghostty_render_state_new(NULL, &render) != GHOSTTY_SUCCESS) {
    ghostty_terminal_free(terminal);
    return NULL;
  }

  if (apply_wolfpack_contract_options(terminal) != GHOSTTY_SUCCESS) {
    ghostty_render_state_free(render);
    ghostty_terminal_free(terminal);
    return NULL;
  }

  WpGhosttyTerminal* out = (WpGhosttyTerminal*)calloc(1, sizeof(WpGhosttyTerminal));
  if (out == NULL) {
    ghostty_render_state_free(render);
    ghostty_terminal_free(terminal);
    return NULL;
  }
  out->terminal = terminal;
  out->render = render;
  return out;
}

void wp_ghostty_terminal_free(WpGhosttyTerminal* terminal) {
  if (terminal == NULL) return;
  ghostty_render_state_free(terminal->render);
  ghostty_terminal_free(terminal->terminal);
  free(terminal);
}

int wp_ghostty_terminal_feed(WpGhosttyTerminal* terminal, const uint8_t* data, size_t len) {
  if (terminal == NULL || (data == NULL && len != 0)) return WP_ERR_INVALID;
  // Void API: VT processing errors are exposed via GHOSTTY_TERMINAL_DATA_VT_PROCESSING_ERROR
  // and rejected during snapshot/materialization.
  ghostty_terminal_vt_write(terminal->terminal, data, len);
  return WP_OK;
}

int wp_ghostty_terminal_resize(WpGhosttyTerminal* terminal, uint16_t cols, uint16_t rows) {
  if (terminal == NULL || cols == 0 || rows == 0) return WP_ERR_INVALID;
  GhosttyResult result = ghostty_terminal_resize(terminal->terminal, cols, rows, 0, 0);
  return result == GHOSTTY_SUCCESS ? WP_OK : WP_ERR_GHOSTTY;
}

int wp_ghostty_terminal_snapshot_meta(WpGhosttyTerminal* wrapper, WpGhosttySnapshotMeta* out) {
  if (wrapper == NULL || out == NULL) return WP_ERR_INVALID;
  memset(out, 0, sizeof(*out));
  GhosttyTerminal terminal = wrapper->terminal;

  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  bool visible = true;
  bool vt_error = false;
  GhosttyString title = {0};
  GhosttyTerminalScrollRegion scroll_region = {0};
  size_t scrollback_rows = 0;

  const GhosttyTerminalData keys[] = {
      GHOSTTY_TERMINAL_DATA_COLS,
      GHOSTTY_TERMINAL_DATA_ROWS,
      GHOSTTY_TERMINAL_DATA_CURSOR_X,
      GHOSTTY_TERMINAL_DATA_CURSOR_Y,
      GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN,
      GHOSTTY_TERMINAL_DATA_CURSOR_VISIBLE,
      GHOSTTY_TERMINAL_DATA_TITLE,
      GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS,
      GHOSTTY_TERMINAL_DATA_VT_PROCESSING_ERROR,
      GHOSTTY_TERMINAL_DATA_SCROLL_REGION,
  };
  void* values[] = {
      &out->cols,
      &out->rows,
      &out->cursor_col,
      &out->cursor_row,
      &screen,
      &visible,
      &title,
      &scrollback_rows,
      &vt_error,
      &scroll_region,
  };
  if (ghostty_terminal_get_multi(terminal, sizeof(keys) / sizeof(keys[0]), keys, values, NULL) != GHOSTTY_SUCCESS) {
    return WP_ERR_GHOSTTY;
  }

  out->on_alt_screen = screen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE ? 1 : 0;
  out->cursor_visible = visible ? 1 : 0;
  out->scrollback_rows = scrollback_rows;
  out->scroll_region_top = scroll_region.top;
  out->scroll_region_bottom = scroll_region.bottom;
  out->title_len = title.len;
  out->vt_processing_error = vt_error ? 1 : 0;

  int rc = WP_OK;
  if ((rc = terminal_bool_mode(terminal, GHOSTTY_MODE_DECCKM, &out->application_cursor)) != WP_OK) return rc;
  if ((rc = terminal_bool_mode(terminal, GHOSTTY_MODE_KEYPAD_KEYS, &out->application_keypad)) != WP_OK) return rc;
  if ((rc = terminal_bool_mode(terminal, GHOSTTY_MODE_BRACKETED_PASTE, &out->bracketed_paste)) != WP_OK) return rc;
  if ((rc = terminal_bool_mode(terminal, GHOSTTY_MODE_ORIGIN, &out->origin_mode)) != WP_OK) return rc;
  if ((rc = terminal_bool_mode(terminal, GHOSTTY_MODE_WRAPAROUND, &out->auto_wrap)) != WP_OK) return rc;
  if ((rc = terminal_bool_mode(terminal, GHOSTTY_MODE_INSERT, &out->insert_mode)) != WP_OK) return rc;

  uint8_t sgr_mouse = 0;
  uint8_t any_mouse = 0;
  uint8_t button_mouse = 0;
  uint8_t normal_mouse = 0;
  uint8_t x10_mouse = 0;
  if ((rc = terminal_bool_mode(terminal, GHOSTTY_MODE_SGR_MOUSE, &sgr_mouse)) != WP_OK) return rc;
  if ((rc = terminal_bool_mode(terminal, GHOSTTY_MODE_ANY_MOUSE, &any_mouse)) != WP_OK) return rc;
  if ((rc = terminal_bool_mode(terminal, GHOSTTY_MODE_BUTTON_MOUSE, &button_mouse)) != WP_OK) return rc;
  if ((rc = terminal_bool_mode(terminal, GHOSTTY_MODE_NORMAL_MOUSE, &normal_mouse)) != WP_OK) return rc;
  if ((rc = terminal_bool_mode(terminal, GHOSTTY_MODE_X10_MOUSE, &x10_mouse)) != WP_OK) return rc;
  out->mouse_mode = sgr_mouse ? 5 : any_mouse ? 4 : button_mouse ? 3 : normal_mouse ? 2 : x10_mouse ? 1 : 0;

  if (ghostty_render_state_update(wrapper->render, terminal) != GHOSTTY_SUCCESS) return WP_ERR_GHOSTTY;
  GhosttyRenderStateCursorVisualStyle style = GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
  if (ghostty_render_state_get(wrapper->render, GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE, &style) != GHOSTTY_SUCCESS) {
    return WP_ERR_GHOSTTY;
  }
  out->cursor_shape = style == GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BAR
      ? 2
      : style == GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_UNDERLINE ? 1 : 0;

  return WP_OK;
}

int wp_ghostty_terminal_copy_title(WpGhosttyTerminal* wrapper, uint8_t* buf, size_t cap, size_t* out_len) {
  if (wrapper == NULL || out_len == NULL) return WP_ERR_INVALID;
  GhosttyString title = {0};
  if (ghostty_terminal_get(wrapper->terminal, GHOSTTY_TERMINAL_DATA_TITLE, &title) != GHOSTTY_SUCCESS) return WP_ERR_GHOSTTY;
  if (title.len > WP_GHOSTTY_MAX_TITLE_BYTES) return WP_ERR_LIMIT;
  *out_len = title.len;
  if (title.len > cap) return WP_ERR_NO_SPACE;
  if (title.len > 0 && buf == NULL) return WP_ERR_INVALID;
  if (title.len > 0) memcpy(buf, title.ptr, title.len);
  return WP_OK;
}

static int write_cell_text(
    const GhosttyGridRef* ref,
    WpGhosttyCell* out,
    uint8_t* text,
    size_t text_cap,
    size_t* used) {
  size_t required_cps = 0;
  GhosttyResult query = ghostty_grid_ref_graphemes(ref, NULL, 0, &required_cps);
  if (query == GHOSTTY_SUCCESS && required_cps == 0) {
    return WP_OK;
  }
  if (query != GHOSTTY_OUT_OF_SPACE && query != GHOSTTY_SUCCESS) {
    return WP_ERR_GHOSTTY;
  }
  if (required_cps == 0) return WP_OK;

  if (required_cps > WP_GHOSTTY_MAX_CELL_CODEPOINTS) return WP_ERR_LIMIT;
  if (required_cps > SIZE_MAX / sizeof(uint32_t)) return WP_ERR_LIMIT;

  uint32_t stack_cps[16];
  uint32_t* cps = stack_cps;
  if (required_cps > sizeof(stack_cps) / sizeof(stack_cps[0])) {
    cps = (uint32_t*)malloc(required_cps * sizeof(uint32_t));
    if (cps == NULL) return WP_ERR_OOM;
  }

  size_t written_cps = 0;
  GhosttyResult result = ghostty_grid_ref_graphemes(ref, cps, required_cps, &written_cps);
  if (result != GHOSTTY_SUCCESS) {
    if (cps != stack_cps) free(cps);
    return WP_ERR_GHOSTTY;
  }

  if (written_cps > required_cps) {
    if (cps != stack_cps) free(cps);
    return WP_ERR_GHOSTTY;
  }

  size_t start = *used;
  size_t cell_used = 0;
  for (size_t i = 0; i < written_cps; i++) {
    uint8_t encoded[4];
    size_t encoded_len = 0;
    int rc = encode_utf8(cps[i], encoded, &encoded_len);
    if (rc != WP_OK) {
      if (cps != stack_cps) free(cps);
      return rc;
    }
    size_t next_cell_used = 0;
    rc = checked_add_size(cell_used, encoded_len, &next_cell_used);
    if (rc != WP_OK) {
      if (cps != stack_cps) free(cps);
      return rc;
    }
    if (next_cell_used > WP_GHOSTTY_MAX_CELL_TEXT_BYTES) {
      if (cps != stack_cps) free(cps);
      return WP_ERR_LIMIT;
    }

    size_t next_used = 0;
    rc = checked_add_size(*used, encoded_len, &next_used);
    if (rc != WP_OK) {
      if (cps != stack_cps) free(cps);
      return rc;
    }
    if (next_used > WP_GHOSTTY_MAX_EXTRACT_TEXT_BYTES) {
      if (cps != stack_cps) free(cps);
      return WP_ERR_LIMIT;
    }
    if (text != NULL) {
      if (next_used > text_cap) {
        if (cps != stack_cps) free(cps);
        return WP_ERR_NO_SPACE;
      }
      memcpy(text + *used, encoded, encoded_len);
    }
    *used = next_used;
    cell_used = next_cell_used;
  }
  if (cps != stack_cps) free(cps);

  uint32_t offset = 0;
  uint32_t len = 0;
  int offset_rc = checked_u32_from_size(start, &offset);
  int len_rc = checked_u32_from_size(*used - start, &len);
  if (offset_rc != WP_OK) return offset_rc;
  if (len_rc != WP_OK) return len_rc;
  out->text_offset = offset;
  out->text_len = len;
  return WP_OK;
}

int wp_ghostty_terminal_extract_rows(
    WpGhosttyTerminal* wrapper,
    WpGhosttyRowSource row_source,
    size_t start_y,
    uint16_t row_count,
    WpGhosttyRow* rows,
    WpGhosttyCell* cells,
    uint8_t* text,
    size_t text_cap,
    size_t* out_text_len) {
  if (wrapper == NULL || rows == NULL || cells == NULL || out_text_len == NULL) return WP_ERR_INVALID;
  GhosttyPointTag point_tag = GHOSTTY_POINT_TAG_ACTIVE;
  int row_source_rc = row_source_to_point_tag(row_source, &point_tag);
  if (row_source_rc != WP_OK) return row_source_rc;

  uint16_t cols = 0;
  if (ghostty_terminal_get(wrapper->terminal, GHOSTTY_TERMINAL_DATA_COLS, &cols) != GHOSTTY_SUCCESS) {
    return WP_ERR_GHOSTTY;
  }
  size_t total_cells = 0;
  if (row_count != 0 && cols != 0 && (size_t)row_count > SIZE_MAX / (size_t)cols) return WP_ERR_LIMIT;
  total_cells = (size_t)row_count * (size_t)cols;
  if (total_cells > SIZE_MAX / sizeof(WpGhosttyCell)) return WP_ERR_LIMIT;

  GhosttyColorRgb palette[256];
  if (ghostty_terminal_get(wrapper->terminal, GHOSTTY_TERMINAL_DATA_COLOR_PALETTE, palette) != GHOSTTY_SUCCESS) {
    return WP_ERR_GHOSTTY;
  }

  size_t used = 0;
  for (uint16_t row_idx = 0; row_idx < row_count; row_idx++) {
    GhosttyPoint point;
    memset(&point, 0, sizeof(point));
    point.tag = point_tag;
    point.value.coordinate.x = 0;
    uint32_t row_y = 0;
    int point_rc = checked_point_y(start_y, row_idx, &row_y);
    if (point_rc != WP_OK) return point_rc;
    point.value.coordinate.y = row_y;

    GhosttyGridRef row_ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
    if (ghostty_terminal_grid_ref(wrapper->terminal, point, &row_ref) != GHOSTTY_SUCCESS) return WP_ERR_GHOSTTY;

    GhosttyRow row = 0;
    bool wrapped = false;
    if (ghostty_grid_ref_row(&row_ref, &row) != GHOSTTY_SUCCESS) return WP_ERR_GHOSTTY;
    if (ghostty_row_get(row, GHOSTTY_ROW_DATA_WRAP, &wrapped) != GHOSTTY_SUCCESS) return WP_ERR_GHOSTTY;
    rows[row_idx].wrapped = wrapped ? 1 : 0;

    for (uint16_t col = 0; col < cols; col++) {
      size_t cell_index = 0;
      int index_rc = checked_cell_index((size_t)row_idx, cols, col, &cell_index);
      if (index_rc != WP_OK) return index_rc;
      WpGhosttyCell* out = &cells[cell_index];
      memset(out, 0, sizeof(*out));

      GhosttyPoint cell_point;
      memset(&cell_point, 0, sizeof(cell_point));
      cell_point.tag = point.tag;
      cell_point.value.coordinate.x = col;
      cell_point.value.coordinate.y = row_y;

      GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
      if (ghostty_terminal_grid_ref(wrapper->terminal, cell_point, &ref) != GHOSTTY_SUCCESS) return WP_ERR_GHOSTTY;

      GhosttyCell cell = 0;
      if (ghostty_grid_ref_cell(&ref, &cell) != GHOSTTY_SUCCESS) return WP_ERR_GHOSTTY;
      GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
      if (ghostty_cell_get(cell, GHOSTTY_CELL_DATA_WIDE, &wide) != GHOSTTY_SUCCESS) return WP_ERR_GHOSTTY;
      if (wide == GHOSTTY_CELL_WIDE_SPACER_TAIL || wide == GHOSTTY_CELL_WIDE_SPACER_HEAD) {
        out->continuation = 1;
      } else {
        int text_rc = write_cell_text(&ref, out, text, text_cap, &used);
        if (text_rc != WP_OK) return text_rc;
      }

      GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
      // Void initializer: structured attributes below come only from the checked style query.
      ghostty_style_default(&style);
      if (ghostty_grid_ref_style(&ref, &style) != GHOSTTY_SUCCESS) return WP_ERR_GHOSTTY;
      int fg_rc = style_color_to_rgb(style.fg_color, palette, &out->fg_rgb, &out->has_fg);
      if (fg_rc != WP_OK) return fg_rc;
      int bg_rc = style_color_to_rgb(style.bg_color, palette, &out->bg_rgb, &out->has_bg);
      if (bg_rc != WP_OK) return bg_rc;
      out->bold = style.bold ? 1 : 0;
      out->italic = style.italic ? 1 : 0;
      out->underline = style.underline != 0 ? 1 : 0;
      out->reverse = style.inverse ? 1 : 0;
      out->blink = style.blink ? 1 : 0;
      out->strike = style.strikethrough ? 1 : 0;
      out->dim = style.faint ? 1 : 0;
      out->hidden = style.invisible ? 1 : 0;
    }
  }

  *out_text_len = used;
  return WP_OK;
}

int wp_ghostty_test_required_cps_allocation(size_t required_cps) {
  if (required_cps > WP_GHOSTTY_MAX_CELL_CODEPOINTS) return WP_ERR_LIMIT;
  if (required_cps > SIZE_MAX / sizeof(uint32_t)) return WP_ERR_LIMIT;
  return WP_OK;
}

int wp_ghostty_test_accumulate_text(size_t used, size_t encoded_len, size_t cell_used) {
  size_t next_cell_used = 0;
  int rc = checked_add_size(cell_used, encoded_len, &next_cell_used);
  if (rc != WP_OK) return rc;
  if (next_cell_used > WP_GHOSTTY_MAX_CELL_TEXT_BYTES) return WP_ERR_LIMIT;
  size_t next_used = 0;
  rc = checked_add_size(used, encoded_len, &next_used);
  if (rc != WP_OK) return rc;
  if (next_used > WP_GHOSTTY_MAX_EXTRACT_TEXT_BYTES) return WP_ERR_LIMIT;
  return WP_OK;
}

int wp_ghostty_test_cell_index(size_t row_idx, uint16_t cols, uint16_t col, size_t* out_index) {
  if (out_index == NULL) return WP_ERR_INVALID;
  return checked_cell_index(row_idx, cols, col, out_index);
}

int wp_ghostty_test_point_y(size_t start_y, uint16_t row_idx, uint32_t* out_y) {
  if (out_y == NULL) return WP_ERR_INVALID;
  return checked_point_y(start_y, row_idx, out_y);
}

int wp_ghostty_test_row_source_mapping(int row_source, uint8_t* out_is_history) {
  if (out_is_history == NULL) return WP_ERR_INVALID;
  GhosttyPointTag point_tag = GHOSTTY_POINT_TAG_ACTIVE;
  int rc = row_source_to_point_tag((WpGhosttyRowSource)row_source, &point_tag);
  if (rc != WP_OK) return rc;
  *out_is_history = point_tag == GHOSTTY_POINT_TAG_HISTORY ? 1 : 0;
  return WP_OK;
}
