import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

function source(...parts: readonly string[]): string {
  return readFileSync(join(ROOT, ...parts), "utf8");
}

describe("unconditional authoritative Ghostty broker policy", () => {
  test("Cargo always builds Ghostty without legacy emulator dependencies", () => {
    const cargo = source("broker", "Cargo.toml");
    const build = source("broker", "build.rs");

    expect(cargo).not.toContain("[features]");
    expect(cargo).not.toMatch(/^vte\s*=/m);
    expect(cargo).not.toMatch(/^unicode-width\s*=/m);
    expect(cargo).not.toMatch(/^unicode-segmentation\s*=/m);
    expect(build).not.toContain("CARGO_FEATURE_GHOSTTY_VT");
  });

  test("the terminal state has no legacy or shadow implementation", () => {
    const terminal = source("broker", "src", "terminal_state.rs");

    expect(terminal).toContain("wp_ghostty_terminal_new");
    expect(terminal).not.toContain("cfg(feature");
    expect(existsSync(join(ROOT, "broker", "src", "terminal_state_legacy.rs"))).toBeFalse();
    expect(existsSync(join(ROOT, "broker", "src", "terminal_state", "ghostty.rs"))).toBeFalse();
    expect(existsSync(join(ROOT, "broker", "src", "terminal_state", "shadow.rs"))).toBeFalse();
    expect(existsSync(join(ROOT, "broker", "tests", "terminal_shadow.rs"))).toBeFalse();
  });

  test("does not retain shadow-only metadata getter APIs", () => {
    const terminal = source("broker", "src", "terminal_state.rs");
    for (const getter of [
      "cols",
      "rows",
      "modes",
      "on_alt_screen",
      "cursor",
      "title",
      "scroll_region",
    ]) {
      expect(terminal).not.toContain(`pub fn ${getter}(`);
    }
  });

  test("CI and release builds use the unconditional broker", () => {
    const workflows = [
      source(".github", "workflows", "test.yml"),
      source(".github", "workflows", "release.yml"),
    ].join("\n");

    expect(workflows).not.toContain("--features ghostty-vt");
    expect(workflows).not.toContain("ghostty-vt-shadow");
    expect(workflows).toContain("cargo test --locked --manifest-path broker/Cargo.toml --all");
  });
});
