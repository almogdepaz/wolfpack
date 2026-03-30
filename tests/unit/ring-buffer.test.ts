import { describe, test, expect } from "bun:test";
import { RingBuffer } from "../../src/server/ring-buffer";

describe("RingBuffer", () => {
  test("empty buffer reads as empty string", () => {
    const rb = new RingBuffer(64);
    expect(rb.read()).toBe("");
    expect(rb.size).toBe(0);
  });

  test("write and read back small data", () => {
    const rb = new RingBuffer(64);
    rb.write(Buffer.from("hello"));
    expect(rb.read()).toBe("hello");
    expect(rb.size).toBe(5);
  });

  test("multiple writes accumulate", () => {
    const rb = new RingBuffer(64);
    rb.write(Buffer.from("hello "));
    rb.write(Buffer.from("world"));
    expect(rb.read()).toBe("hello world");
    expect(rb.size).toBe(11);
  });

  test("wraps around when capacity exceeded", () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from("abcdefgh")); // fills exactly
    expect(rb.read()).toBe("abcdefgh");
    rb.write(Buffer.from("ij")); // overwrites "ab"
    expect(rb.read()).toBe("cdefghij");
    expect(rb.size).toBe(8);
  });

  test("single write larger than capacity keeps tail", () => {
    const rb = new RingBuffer(4);
    rb.write(Buffer.from("abcdefgh"));
    expect(rb.read()).toBe("efgh");
    expect(rb.size).toBe(4);
  });

  test("write exactly capacity", () => {
    const rb = new RingBuffer(5);
    rb.write(Buffer.from("abcde"));
    expect(rb.read()).toBe("abcde");
    expect(rb.size).toBe(5);
  });

  test("wrap with split write", () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from("123456")); // 6 bytes, head at 6
    rb.write(Buffer.from("abcd"));   // wraps: "ab" at 6-7, "cd" at 0-1
    expect(rb.read()).toBe("3456abcd");
  });

  test("clear resets state", () => {
    const rb = new RingBuffer(16);
    rb.write(Buffer.from("data"));
    rb.clear();
    expect(rb.read()).toBe("");
    expect(rb.size).toBe(0);
  });

  test("write after clear works correctly", () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from("old"));
    rb.clear();
    rb.write(Buffer.from("new"));
    expect(rb.read()).toBe("new");
  });

  test("readBuffer returns correct Buffer", () => {
    const rb = new RingBuffer(64);
    rb.write(Buffer.from("hello"));
    const buf = rb.readBuffer();
    expect(buf.toString()).toBe("hello");
  });

  test("readBuffer after wrap", () => {
    const rb = new RingBuffer(4);
    rb.write(Buffer.from("abcd"));
    rb.write(Buffer.from("ef"));
    expect(rb.readBuffer().toString()).toBe("cdef");
  });

  test("empty write is no-op", () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from("abc"));
    rb.write(Buffer.alloc(0));
    expect(rb.read()).toBe("abc");
    expect(rb.size).toBe(3);
  });

  test("many small writes wrapping multiple times", () => {
    const rb = new RingBuffer(4);
    for (let i = 0; i < 10; i++) {
      rb.write(Buffer.from(String(i)));
    }
    // Buffer holds last 4 chars: "6789"
    expect(rb.read()).toBe("6789");
  });

  // ── ANSI / terminal escape handling ──

  test("preserves ANSI color codes", () => {
    const rb = new RingBuffer(256);
    const colored = "\x1b[31mred\x1b[0m normal \x1b[32mgreen\x1b[0m";
    rb.write(Buffer.from(colored));
    expect(rb.read()).toBe(colored);
  });

  test("ANSI sequences survive wrap boundary", () => {
    // Buffer capacity 16, fill 14 bytes then write ANSI that straddles wrap
    const rb = new RingBuffer(16);
    rb.write(Buffer.from("A".repeat(14)));   // 14 bytes, head at 14
    const ansi = "\x1b[1;33mHI\x1b[0m";     // 13 bytes — wraps around
    rb.write(Buffer.from(ansi));
    const result = rb.read();
    // Should contain the full ANSI sequence (last 16 bytes of total 27)
    expect(result).toContain("HI");
    expect(result).toContain("\x1b[0m");
    expect(rb.size).toBe(16);
  });

  test("handles multi-byte UTF-8 with ANSI", () => {
    const rb = new RingBuffer(128);
    const mixed = "\x1b[36m日本語\x1b[0m";
    rb.write(Buffer.from(mixed));
    expect(rb.read()).toBe(mixed);
  });

  test("cursor movement sequences preserved", () => {
    const rb = new RingBuffer(64);
    const cursor = "\x1b[2J\x1b[H$ prompt\r\n\x1b[K";
    rb.write(Buffer.from(cursor));
    expect(rb.read()).toBe(cursor);
  });

  // ── Line extraction from buffer ──

  test("line extraction: split on newlines", () => {
    const rb = new RingBuffer(128);
    rb.write(Buffer.from("line1\nline2\nline3\n"));
    const lines = rb.read().split("\n");
    expect(lines).toEqual(["line1", "line2", "line3", ""]);
  });

  test("line extraction after overflow preserves line integrity", () => {
    const rb = new RingBuffer(20);
    rb.write(Buffer.from("first line\nsecond line\nthird line\n"));
    const content = rb.read();
    // Last 20 bytes of "first line\nsecond line\nthird line\n" = "ond line\nthird line\n"
    expect(content).toContain("third line");
    expect(content).toContain("\n");
  });

  test("handles \\r\\n line endings", () => {
    const rb = new RingBuffer(64);
    rb.write(Buffer.from("line1\r\nline2\r\nline3\r\n"));
    expect(rb.read()).toBe("line1\r\nline2\r\nline3\r\n");
  });
});
