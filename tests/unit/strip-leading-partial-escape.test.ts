import { describe, test, expect } from "bun:test";
import { stripLeadingPartialEscape } from "../../src/server/strip-ansi";

describe("stripLeadingPartialEscape", () => {
  test("returns empty buffer unchanged", () => {
    const buf = Buffer.alloc(0);
    expect(stripLeadingPartialEscape(buf).length).toBe(0);
  });

  test("returns clean buffer unchanged", () => {
    const buf = Buffer.from("hello world");
    expect(stripLeadingPartialEscape(buf).toString()).toBe("hello world");
  });

  test("preserves buffer starting with intact ESC sequence", () => {
    const buf = Buffer.from("\x1b[31mred text\x1b[0m");
    expect(stripLeadingPartialEscape(buf).toString()).toBe("\x1b[31mred text\x1b[0m");
  });

  test("strips orphaned CSI parameter + final bytes (mid-sequence start)", () => {
    const buf = Buffer.from("31mhello\x1b[0m");
    const result = stripLeadingPartialEscape(buf);
    expect(result.toString()).toBe("hello\x1b[0m");
  });

  test("strips orphaned CSI with semicolons", () => {
    const buf = Buffer.from("1;33mcolored text");
    const result = stripLeadingPartialEscape(buf);
    expect(result.toString()).toBe("colored text");
  });

  test("lone final byte without param bytes is ambiguous — left as-is", () => {
    const buf = Buffer.from("m normal text");
    const result = stripLeadingPartialEscape(buf);
    expect(result.toString()).toBe("m normal text");
  });

  test("strips fragment bytes before first ESC", () => {
    const buf = Buffer.from("33m\x1b[1mBold\x1b[0m");
    const result = stripLeadingPartialEscape(buf);
    expect(result.toString()).toBe("\x1b[1mBold\x1b[0m");
  });

  test("does not strip normal text before ESC when newline present", () => {
    const buf = Buffer.from("hello\n\x1b[31mred\x1b[0m");
    expect(stripLeadingPartialEscape(buf).toString()).toBe("hello\n\x1b[31mred\x1b[0m");
  });

  test("strips orphaned CSI cursor movement fragment", () => {
    const buf = Buffer.from("5;10Hcontent here");
    const result = stripLeadingPartialEscape(buf);
    expect(result.toString()).toBe("content here");
  });

  test("handles buffer starting with ESC (intact sequence)", () => {
    const buf = Buffer.from("\x1b[2J\x1b[H$ prompt");
    expect(stripLeadingPartialEscape(buf).toString()).toBe("\x1b[2J\x1b[H$ prompt");
  });
});
