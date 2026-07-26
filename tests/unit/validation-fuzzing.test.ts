/**
 * Validation fuzzing — edge cases that live outside happy-path coverage.
 *
 * Covers: null bytes, control chars, unicode, boundary lengths,
 * path traversal variants, branch injection sequences.
 */
import { describe, expect, test } from "bun:test";
import {
  isValidSessionName,
  isValidProjectName,
  shellEscape,
} from "../../src/validation.ts";

// ── shellEscape: null bytes, control chars, unicode ──

describe("shellEscape — hostile input", () => {
  test("null byte is stripped before quoting (ISS-06)", () => {
    const result = shellEscape("a\0b");
    // NUL bytes are stripped to prevent shell-dependent truncation behavior
    expect(result).toBe("'ab'");
    expect(result.startsWith("'")).toBe(true);
    expect(result.endsWith("'")).toBe(true);
  });

  test("control chars (BEL, ESC, BS, DEL) are preserved inside quotes", () => {
    const input = "\x07\x1b\x08\x7f";
    const result = shellEscape(input);
    expect(result).toBe(`'${input}'`);
  });

  test("carriage return is preserved inside quotes", () => {
    const result = shellEscape("line1\rline2");
    expect(result).toBe("'line1\rline2'");
  });

  test("tab characters are preserved", () => {
    expect(shellEscape("a\tb")).toBe("'a\tb'");
  });

  test("mixed control chars + single quotes", () => {
    const result = shellEscape("it's\x00evil\x1b[31m");
    // Single quotes get escaped, everything else stays literal
    expect(result).toContain("'\\''");
    expect(result.startsWith("'")).toBe(true);
    expect(result.endsWith("'")).toBe(true);
  });

  test("unicode emoji", () => {
    expect(shellEscape("🐺")).toBe("'🐺'");
  });

  test("unicode CJK characters", () => {
    expect(shellEscape("日本語")).toBe("'日本語'");
  });

  test("unicode RTL override (U+202E)", () => {
    const rtl = "\u202E";
    expect(shellEscape(`${rtl}evil`)).toBe(`'${rtl}evil'`);
  });

  test("zero-width joiner / zero-width space", () => {
    const zwj = "\u200D";
    const zws = "\u200B";
    expect(shellEscape(`a${zwj}b${zws}c`)).toBe(`'a${zwj}b${zws}c'`);
  });

  test("very long string (100KB) doesn't throw", () => {
    const long = "x".repeat(100_000);
    const result = shellEscape(long);
    expect(result.length).toBe(100_002); // 'x...x'
  });
});

// ── isValidSessionName: boundary and hostile input ──

describe("isValidSessionName — boundary + fuzzing", () => {
  test("exactly 100 chars → valid", () => {
    expect(isValidSessionName("a".repeat(100))).toBe(true);
  });

  test("exactly 101 chars → invalid", () => {
    expect(isValidSessionName("a".repeat(101))).toBe(false);
  });

  test("empty string → invalid", () => {
    expect(isValidSessionName("")).toBe(false);
  });

  test("single char → valid", () => {
    expect(isValidSessionName("x")).toBe(true);
  });

  test("null byte mid-string", () => {
    expect(isValidSessionName("foo\0bar")).toBe(false);
  });

  test("null byte at start", () => {
    expect(isValidSessionName("\0session")).toBe(false);
  });

  test("control chars (BEL, ESC, BS)", () => {
    expect(isValidSessionName("foo\x07bar")).toBe(false);
    expect(isValidSessionName("foo\x1bbar")).toBe(false);
    expect(isValidSessionName("foo\x08bar")).toBe(false);
  });

  test("ANSI escape sequence", () => {
    expect(isValidSessionName("\x1b[31mred\x1b[0m")).toBe(false);
  });

  test("unicode emoji rejected", () => {
    expect(isValidSessionName("wolf🐺pack")).toBe(false);
  });

  test("unicode CJK rejected", () => {
    expect(isValidSessionName("テスト")).toBe(false);
  });

  test("unicode RTL override rejected", () => {
    expect(isValidSessionName("\u202Eevil")).toBe(false);
  });

  test("newline injection", () => {
    expect(isValidSessionName("foo\nbar")).toBe(false);
  });

  test("carriage return injection", () => {
    expect(isValidSessionName("foo\rbar")).toBe(false);
  });

  test("tab character", () => {
    expect(isValidSessionName("foo\tbar")).toBe(false);
  });

  test("space-padded name", () => {
    expect(isValidSessionName(" session ")).toBe(false);
  });

  test("dot (tmux restriction)", () => {
    expect(isValidSessionName("foo.bar")).toBe(false);
  });

  test("colon (tmux restriction)", () => {
    expect(isValidSessionName("foo:bar")).toBe(false);
  });
});

// ── isValidProjectName: edge cases ──

describe("isValidProjectName — fuzzing", () => {
  test("null byte", () => {
    expect(isValidProjectName("foo\0bar")).toBe(false);
  });

  test("control chars", () => {
    expect(isValidProjectName("foo\x07bar")).toBe(false);
    expect(isValidProjectName("foo\x1bbar")).toBe(false);
  });

  test("unicode emoji", () => {
    expect(isValidProjectName("wolf🐺pack")).toBe(false);
  });

  test("unicode CJK", () => {
    expect(isValidProjectName("プロジェクト")).toBe(false);
  });

  test("newline injection", () => {
    expect(isValidProjectName("project\nrm -rf /")).toBe(false);
  });

  test("carriage return injection", () => {
    expect(isValidProjectName("project\revil")).toBe(false);
  });

  test("space-padded", () => {
    expect(isValidProjectName(" project ")).toBe(false);
  });

  test("slash (path traversal)", () => {
    expect(isValidProjectName("../etc")).toBe(false);
    expect(isValidProjectName("foo/bar")).toBe(false);
  });

  test("backslash (Windows traversal)", () => {
    expect(isValidProjectName("foo\\bar")).toBe(false);
  });

  test("URL-encoded traversal", () => {
    expect(isValidProjectName("..%2F..%2Fetc")).toBe(false);
  });
});
