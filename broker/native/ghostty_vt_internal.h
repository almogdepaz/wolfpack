#ifndef WOLFPACK_GHOSTTY_VT_INTERNAL_H
#define WOLFPACK_GHOSTTY_VT_INTERNAL_H

#include "ghostty_vt_shim.h"

#include <limits.h>
#include <stddef.h>
#include <stdint.h>

#include <ghostty/vt.h>

#define WP_OK 0
#define WP_ERR_INVALID -1
#define WP_ERR_GHOSTTY -2
#define WP_ERR_NO_SPACE -3
#define WP_ERR_OOM -4
#define WP_ERR_LIMIT -5

static int wp_checked_add_size(size_t a, size_t b, size_t* out) {
  if (a > SIZE_MAX - b) return WP_ERR_LIMIT;
  *out = a + b;
  return WP_OK;
}

static int wp_checked_u32_from_size(size_t value, uint32_t* out) {
  if (value > UINT32_MAX) return WP_ERR_LIMIT;
  *out = (uint32_t)value;
  return WP_OK;
}

static int wp_checked_cell_index(size_t row_idx, uint16_t cols, uint16_t col, size_t* out) {
  size_t base = 0;
  if (cols != 0 && row_idx > SIZE_MAX / (size_t)cols) return WP_ERR_LIMIT;
  base = row_idx * (size_t)cols;
  return wp_checked_add_size(base, (size_t)col, out);
}

static int wp_checked_point_y(size_t start_y, uint16_t row_idx, uint32_t* out_y) {
  size_t y = 0;
  int rc = wp_checked_add_size(start_y, (size_t)row_idx, &y);
  if (rc != WP_OK) return rc;
  return wp_checked_u32_from_size(y, out_y);
}

static int wp_validate_required_cps_allocation(size_t required_cps) {
  if (required_cps > WP_GHOSTTY_MAX_CELL_CODEPOINTS) return WP_ERR_LIMIT;
  if (required_cps > SIZE_MAX / sizeof(uint32_t)) return WP_ERR_LIMIT;
  return WP_OK;
}

static int wp_accumulate_text_sizes(
    size_t used,
    size_t encoded_len,
    size_t cell_used,
    size_t* out_used,
    size_t* out_cell_used) {
  int rc = wp_checked_add_size(cell_used, encoded_len, out_cell_used);
  if (rc != WP_OK) return rc;
  if (*out_cell_used > WP_GHOSTTY_MAX_CELL_TEXT_BYTES) return WP_ERR_LIMIT;
  rc = wp_checked_add_size(used, encoded_len, out_used);
  if (rc != WP_OK) return rc;
  if (*out_used > WP_GHOSTTY_MAX_EXTRACT_TEXT_BYTES) return WP_ERR_LIMIT;
  return WP_OK;
}

static int wp_row_source_to_point_tag(WpGhosttyRowSource row_source, GhosttyPointTag* out_tag) {
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

#endif
