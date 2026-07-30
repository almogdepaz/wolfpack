import { describe, expect, test } from "bun:test";
import { shouldUseColor } from "../../src/cli/formatting.ts";

const TTY_STREAM = { isTTY: true } as const;
const PIPE_STREAM = { isTTY: false } as const;

describe("cli color policy", () => {
  test("uses color only for an interactive terminal by default", () => {
    expect(shouldUseColor(TTY_STREAM, { TERM: "xterm-256color" })).toBe(true);
    expect(shouldUseColor(PIPE_STREAM, { TERM: "xterm-256color" })).toBe(false);
  });

  test("honors NO_COLOR and TERM=dumb", () => {
    expect(shouldUseColor(TTY_STREAM, { NO_COLOR: "", TERM: "xterm-256color" })).toBe(false);
    expect(shouldUseColor(TTY_STREAM, { TERM: "dumb" })).toBe(false);
  });

  test("allows explicit color only when NO_COLOR is absent", () => {
    expect(shouldUseColor(PIPE_STREAM, { FORCE_COLOR: "1" })).toBe(true);
    expect(shouldUseColor(PIPE_STREAM, { FORCE_COLOR: "1", NO_COLOR: "1" })).toBe(false);
    expect(shouldUseColor(TTY_STREAM, { FORCE_COLOR: "0" })).toBe(false);
  });
});
