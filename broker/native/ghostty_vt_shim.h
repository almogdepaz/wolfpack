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

// Wolfpack-owned program status values (OSC 7501). These are not
// GhosttyProgramStatusState/Kind values; the shim maps them explicitly and
// drops reports whose state this shim does not know.
typedef enum {
  WP_PROGRAM_STATUS_IDLE = 0,
  WP_PROGRAM_STATUS_WORKING = 1,
  WP_PROGRAM_STATUS_DONE = 2,
  WP_PROGRAM_STATUS_BLOCKED = 3,
  WP_PROGRAM_STATUS_ERROR = 4,
  WP_PROGRAM_STATUS_CLEAR = 5,
} WpProgramStatusState;

typedef enum {
  WP_PROGRAM_STATUS_KIND_NONE = 0,
  WP_PROGRAM_STATUS_KIND_PERMISSION = 1,
  WP_PROGRAM_STATUS_KIND_QUESTION = 2,
  WP_PROGRAM_STATUS_KIND_AUTH = 3,
} WpProgramStatusKind;

// A validated program status report. Strings are borrowed for the callback.
typedef struct {
  uint8_t state;
  uint8_t kind;
  int8_t progress;
  const uint8_t* id;
  size_t id_len;
  const uint8_t* app;
  size_t app_len;
  const uint8_t* title;
  size_t title_len;
  const uint8_t* message;
  size_t message_len;
} WpProgramStatusReport;

// Effects observed while one feed call runs. Every callback is optional and
// only invoked synchronously inside wp_ghostty_terminal_feed.
typedef struct {
  void* ctx;
  // Every byte string libghostty would write back to the PTY (query replies).
  void (*pty_write)(void* ctx, const uint8_t* data, size_t len);
  void (*program_status)(void* ctx, const WpProgramStatusReport* report);
  // OSC 133 primary prompt start.
  void (*prompt_start)(void* ctx);
} WpFeedSink;

#define WP_GHOSTTY_MAX_CELL_TEXT_BYTES ((size_t)4096)
#define WP_GHOSTTY_MAX_CELL_CODEPOINTS ((size_t)1024)
#define WP_GHOSTTY_MAX_EXTRACT_TEXT_BYTES ((size_t)8 * 1024 * 1024)
#define WP_GHOSTTY_MAX_TITLE_BYTES ((size_t)1024 * 1024)

WpGhosttyTerminal* wp_ghostty_terminal_new(uint16_t cols, uint16_t rows, size_t scrollback_limit);
void wp_ghostty_terminal_free(WpGhosttyTerminal* terminal);
// `sink` may be NULL: query replies and reports are then discarded.
int wp_ghostty_terminal_feed(
    WpGhosttyTerminal* terminal, const uint8_t* data, size_t len, const WpFeedSink* sink);
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
