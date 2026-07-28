import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { WOLFPACK_TERMINAL_THEME } from "../../src/terminal-theme";

const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

function cRgbLiteral(hex: string): string {
  const normalized = hex.replace("#", "");
  return `{0x${normalized.slice(0, 2)}, 0x${normalized.slice(2, 4)}, 0x${normalized.slice(4, 6)}}`;
}

describe("Wolfpack terminal ANSI palette", () => {
  test("browser terminal theme defines every ANSI color instead of falling back per path", () => {
    for (const key of ANSI_KEYS) {
      expect(WOLFPACK_TERMINAL_THEME[key]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("broker snapshot palette matches the browser terminal ANSI palette", () => {
    const shim = readFileSync(
      join(import.meta.dirname, "..", "..", "broker", "native", "ghostty_vt_shim.c"),
      "utf8",
    );

    for (const key of ANSI_KEYS) {
      expect(shim).toContain(cRgbLiteral(WOLFPACK_TERMINAL_THEME[key]));
    }
    expect(shim).not.toContain("{0x00, 0xff, 0x00}");
  });
});
