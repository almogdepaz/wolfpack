import { describe, expect, test } from "bun:test";
import { shellEscape } from "../../src/validation";

describe("shellEscape", () => {
  test("passes through clean string", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  test("escapes single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  test("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  test("handles backslashes", () => {
    expect(shellEscape("a\\b")).toBe("'a\\b'");
  });

  test("handles newlines", () => {
    expect(shellEscape("line1\nline2")).toBe("'line1\nline2'");
  });

  test("handles combined special chars", () => {
    expect(shellEscape("it's a \"test\" with \\n")).toBe(
      "'it'\\''s a \"test\" with \\n'"
    );
  });

  test("handles multiple consecutive single quotes", () => {
    expect(shellEscape("''")).toBe("''\\'''\\'''");
  });

  test("handles spaces and semicolons", () => {
    expect(shellEscape("rm -rf /; echo pwned")).toBe("'rm -rf /; echo pwned'");
  });

  test("handles dollar signs and backticks", () => {
    expect(shellEscape("$HOME `whoami`")).toBe("'$HOME `whoami`'");
  });
});
