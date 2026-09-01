#ifndef WOLFPACK_GHOSTTY_VT_SHIM_H
#define WOLFPACK_GHOSTTY_VT_SHIM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct WpGhosttyTerminal WpGhosttyTerminal;

// Wolfpack-owned row selectors. These values are not GhosttyPointTag values.
typedef enum {
  WP_GHOSTTY_ROW_SOURCE_ACTIVE = 1,
  WP_GHOSTTY_ROW_SOURCE_HISTORY = 2,
} WpGhosttyRowSource;

typedef struct {
  uint16_t cols;
  uint16_t rows;
  uint16_t cursor_col;
  uint16_t cursor_row;
  uint8_t cursor_visible;
  uint8_t cursor_shape;
  uint8_t on_alt_screen;
  uint8_t application_cursor;
  uint8_t application_keypad;
  uint8_t bracketed_paste;
  uint8_t mouse_mode;
  uint8_t origin_mode;
  uint8_t auto_wrap;
  uint8_t insert_mode;
  uint8_t vt_processing_error;
  uint16_t scroll_region_top;
  uint16_t scroll_region_bottom;
  size_t scrollback_rows;
  size_t title_len;
} WpGhosttySnapshotMeta;

typedef struct {
  uint8_t wrapped;
} WpGhosttyRow;

typedef struct {
  uint32_t text_offset;
  uint32_t text_len;
  uint32_t fg_rgb;
  uint32_t bg_rgb;
  uint8_t has_fg;
  uint8_t has_bg;
  uint8_t bold;
  uint8_t italic;
  uint8_t underline;
  uint8_t reverse;
  uint8_t blink;
  uint8_t strike;
  uint8_t dim;
  uint8_t hidden;
  uint8_t continuation;
} WpGhosttyCell;

#define WP_GHOSTTY_MAX_CELL_TEXT_BYTES ((size_t)4096)
#define WP_GHOSTTY_MAX_CELL_CODEPOINTS ((size_t)1024)
#define WP_GHOSTTY_MAX_EXTRACT_TEXT_BYTES ((size_t)8 * 1024 * 1024)
#define WP_GHOSTTY_MAX_TITLE_BYTES ((size_t)1024 * 1024)

WpGhosttyTerminal* wp_ghostty_terminal_new(uint16_t cols, uint16_t rows, size_t scrollback_limit);
void wp_ghostty_terminal_free(WpGhosttyTerminal* terminal);
int wp_ghostty_terminal_feed(WpGhosttyTerminal* terminal, const uint8_t* data, size_t len);
int wp_ghostty_terminal_resize(WpGhosttyTerminal* terminal, uint16_t cols, uint16_t rows);
int wp_ghostty_terminal_snapshot_meta(WpGhosttyTerminal* terminal, WpGhosttySnapshotMeta* out);
int wp_ghostty_terminal_copy_title(WpGhosttyTerminal* terminal, uint8_t* buf, size_t cap, size_t* out_len);
int wp_ghostty_terminal_extract_rows(
    WpGhosttyTerminal* terminal,
    WpGhosttyRowSource row_source,
    size_t start_y,
    uint16_t row_count,
    WpGhosttyRow* rows,
    WpGhosttyCell* cells,
    uint8_t* text,
    size_t text_cap,
    size_t* out_text_len);

#ifdef __cplusplus
}
#endif

#endif
