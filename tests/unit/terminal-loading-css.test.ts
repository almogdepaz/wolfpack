import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const styles = readFileSync(join(import.meta.dirname, "../../public/styles.css"), "utf8");

describe("terminal loading css polish", () => {
  test("subdues focused grid chrome while a cell is loading", () => {
    expect(styles).toContain(".grid-cell.grid-focused.grid-loading");
    expect(styles).toContain(".grid-cell.grid-focused.terminal-load-state-prefill-loading");
    expect(styles).toContain(".grid-cell.grid-focused.terminal-load-state-hydrating");
    expect(styles).toContain("--grid-loading-focus-border");
  });
});
