import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const RUST = readFileSync(
  join(ROOT, "broker", "src", "terminal_state.rs"),
  "utf8",
);
const SHIM = readFileSync(
  join(ROOT, "broker", "native", "ghostty_vt_shim.c"),
  "utf8",
);

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`missing source boundary: ${start} ... ${end}`);
  }
  return source.slice(startIndex, endIndex);
}

describe("Ghostty structured extraction performance policy", () => {
  test("uses one optimistic extraction pass for ordinary rows", () => {
    const rows = between(RUST, "    fn rows(\n", "impl Drop for GhosttyTerminal");

    expect(rows.match(/wp_ghostty_terminal_extract_rows\(/g)?.length).toBe(1);
    expect(rows).not.toContain("std::ptr::null_mut()");
    expect(rows).toContain("WP_ERR_NO_SPACE");
    expect(rows).toContain("MAX_EXTRACT_TEXT_BYTES");
  });

  test("row extraction does not recompute full snapshot metadata", () => {
    const extraction = between(
      SHIM,
      "int wp_ghostty_terminal_extract_rows(\n",
      "int wp_ghostty_test_required_cps_allocation",
    );

    expect(extraction).not.toContain("wp_ghostty_terminal_snapshot_meta");
    expect(extraction).toContain("GHOSTTY_TERMINAL_DATA_COLS");
  });
});
