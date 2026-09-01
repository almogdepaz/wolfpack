#include "ghostty_vt_internal.h"

int wp_ghostty_test_required_cps_allocation(size_t required_cps) {
  return wp_validate_required_cps_allocation(required_cps);
}

int wp_ghostty_test_accumulate_text(size_t used, size_t encoded_len, size_t cell_used) {
  size_t next_used = 0;
  size_t next_cell_used = 0;
  return wp_accumulate_text_sizes(used, encoded_len, cell_used, &next_used, &next_cell_used);
}

int wp_ghostty_test_cell_index(size_t row_idx, uint16_t cols, uint16_t col, size_t* out_index) {
  if (out_index == NULL) return WP_ERR_INVALID;
  return wp_checked_cell_index(row_idx, cols, col, out_index);
}

int wp_ghostty_test_point_y(size_t start_y, uint16_t row_idx, uint32_t* out_y) {
  if (out_y == NULL) return WP_ERR_INVALID;
  return wp_checked_point_y(start_y, row_idx, out_y);
}

int wp_ghostty_test_row_source_mapping(int row_source, uint8_t* out_is_history) {
  if (out_is_history == NULL) return WP_ERR_INVALID;
  GhosttyPointTag point_tag = GHOSTTY_POINT_TAG_ACTIVE;
  int rc = wp_row_source_to_point_tag((WpGhosttyRowSource)row_source, &point_tag);
  if (rc != WP_OK) return rc;
  *out_is_history = point_tag == GHOSTTY_POINT_TAG_HISTORY ? 1 : 0;
  return WP_OK;
}
