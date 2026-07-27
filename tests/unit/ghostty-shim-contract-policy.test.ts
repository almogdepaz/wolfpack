import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const shim = readFileSync(
  join(import.meta.dirname, "..", "..", "broker", "native", "ghostty_vt_shim.c"),
  "utf8",
);
const shimHeader = readFileSync(
  join(import.meta.dirname, "..", "..", "broker", "native", "ghostty_vt_shim.h"),
  "utf8",
);
const rustWrapper = readFileSync(
  join(import.meta.dirname, "..", "..", "broker", "src", "terminal_state.rs"),
  "utf8",
);

describe("Ghostty C shim contract error policy", () => {
  test("constructor treats disabled media/glyph option failures as fatal", () => {
    expect(shim).not.toContain("(void)ghostty_terminal_set");
    expect(shim).toContain("GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT");
    expect(shim).toContain("GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_FILE");
    expect(shim).toContain("GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_SHARED_MEM");
    expect(shim).toContain("GHOSTTY_TERMINAL_OPT_GLYPH_PROTOCOL");
    expect(shim).toContain("return NULL");
    expect(shim).toContain("ghostty_render_state_free(render)");
    expect(shim).toContain("ghostty_terminal_free(terminal)");
  });

  test("row extraction propagates palette, wrap, wide, and style query failures", () => {
    expect(shim).not.toContain("(void)ghostty_terminal_get(wrapper->terminal, GHOSTTY_TERMINAL_DATA_COLOR_PALETTE");
    expect(shim).not.toContain("(void)ghostty_row_get(row, GHOSTTY_ROW_DATA_WRAP");
    expect(shim).not.toContain("(void)ghostty_cell_get(cell, GHOSTTY_CELL_DATA_WIDE");
    expect(shim).not.toContain("if (ghostty_grid_ref_style(&ref, &style) == GHOSTTY_SUCCESS)");
    expect(shim).toContain("GHOSTTY_TERMINAL_DATA_COLOR_PALETTE");
    expect(shim).toContain("GHOSTTY_ROW_DATA_WRAP");
    expect(shim).toContain("GHOSTTY_CELL_DATA_WIDE");
    expect(shim).toContain("ghostty_grid_ref_style");
    expect(shim).toContain("return WP_ERR_GHOSTTY");
  });

  test("snapshot cursor-shape queries propagate render-state failures", () => {
    expect(shim).not.toContain("if (ghostty_render_state_update(wrapper->render, terminal) == GHOSTTY_SUCCESS)");
    expect(shim).not.toContain(
      "if (ghostty_render_state_get(wrapper->render, GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE, &style) == GHOSTTY_SUCCESS)",
    );
    expect(shim).toContain("GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE");
    expect(shim).toContain("return WP_ERR_GHOSTTY");
  });

  test("row source ABI uses Wolfpack-owned selectors and rejects unknown values", () => {
    expect(shimHeader).toContain("WpGhosttyRowSource");
    expect(shimHeader).toContain("WP_GHOSTTY_ROW_SOURCE_ACTIVE");
    expect(shimHeader).toContain("WP_GHOSTTY_ROW_SOURCE_HISTORY");
    expect(shim).not.toContain("point_tag == 3 ? GHOSTTY_POINT_TAG_HISTORY : GHOSTTY_POINT_TAG_ACTIVE");
    expect(shim).toContain("case WP_GHOSTTY_ROW_SOURCE_ACTIVE");
    expect(shim).toContain("case WP_GHOSTTY_ROW_SOURCE_HISTORY");
    expect(shim).toContain("default:");
    expect(shim).toContain("return WP_ERR_INVALID");
    expect(rustWrapper).toContain("enum WpGhosttyRowSource");
    expect(rustWrapper).toContain("WpGhosttyRowSource::Active");
    expect(rustWrapper).toContain("WpGhosttyRowSource::History");
    expect(rustWrapper).not.toContain("GHOSTTY_POINT_TAG_HISTORY");
  });
});
