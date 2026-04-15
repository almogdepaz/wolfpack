import { describe, test, expect } from "bun:test";
import { stripAnsi } from "../../src/server/pty-backend";

describe("stripAnsi", () => {
  test("strips basic ANSI color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  test("normalizes CRLF to LF", () => {
    expect(stripAnsi("line1\r\nline2\r\n")).toBe("line1\nline2\n");
  });

  test("strips cursor positioning and erase escapes", () => {
    expect(stripAnsi("\x1b[1;1HHeader\x1b[2;1HLine2\x1b[K")).toBe("HeaderLine2");
  });

  test("strips private-mark CSI with < > = markers", () => {
    // \x1b[>0q — terminal version query emitted by modern TUIs (xterm, ink)
    // Must not leak into visible output.
    expect(stripAnsi("\x1b[>0qtext\x1b[=3hmore\x1b[<1ldone")).toBe("textmoredone");
  });

  test("strips bracketed-paste private modes", () => {
    expect(stripAnsi("\x1b[?2004hX\x1b[?2004lY")).toBe("XY");
  });

  test("bare CR becomes LF (safe fallback, not semantic rewind)", () => {
    // Without a full VT emulator, we can't distinguish progress-bar CR from
    // TUI-frame CR. Converting to LF keeps TUI content visible at the cost of
    // producing extra lines for progress bars.
    expect(stripAnsi("Progress: 50%\rProgress: 100%")).toBe("Progress: 50%\nProgress: 100%");
  });

  test("preserves normal multi-line output", () => {
    expect(stripAnsi("line1\nline2\nline3")).toBe("line1\nline2\nline3");
  });

  test("empty string passes through", () => {
    expect(stripAnsi("")).toBe("");
  });
});
