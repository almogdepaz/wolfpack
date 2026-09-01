const WP_OK: i32 = 0;
const WP_ERR_INVALID: i32 = -1;
const WP_ERR_LIMIT: i32 = -5;
const MAX_EXTRACT_TEXT_BYTES: usize = 8 * 1024 * 1024;
const WP_GHOSTTY_ROW_SOURCE_ACTIVE: i32 = 1;
const WP_GHOSTTY_ROW_SOURCE_HISTORY: i32 = 2;

#[link(name = "wolfpack_ghostty_vt_test_harness", kind = "static")]
unsafe extern "C" {
    fn wp_ghostty_test_required_cps_allocation(required_cps: usize) -> i32;
    fn wp_ghostty_test_accumulate_text(used: usize, encoded_len: usize, cell_used: usize) -> i32;
    fn wp_ghostty_test_cell_index(
        row_idx: usize,
        cols: u16,
        col: u16,
        out_index: *mut usize,
    ) -> i32;
    fn wp_ghostty_test_point_y(start_y: usize, row_idx: u16, out_y: *mut u32) -> i32;
    fn wp_ghostty_test_row_source_mapping(row_source: i32, out_is_history: *mut u8) -> i32;
}

#[test]
fn native_helpers_reject_unbounded_grapheme_allocation() {
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
fn native_helpers_reject_oversized_utf8_accumulation() {
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
fn native_helpers_map_only_wolfpack_owned_row_selectors() {
    let mut is_history = 9u8;
    assert_eq!(
        unsafe {
            wp_ghostty_test_row_source_mapping(WP_GHOSTTY_ROW_SOURCE_ACTIVE, &mut is_history)
        },
        WP_OK
    );
    assert_eq!(is_history, 0);
    assert_eq!(
        unsafe {
            wp_ghostty_test_row_source_mapping(WP_GHOSTTY_ROW_SOURCE_HISTORY, &mut is_history)
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
fn native_helpers_reject_cell_index_and_coordinate_overflow() {
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
