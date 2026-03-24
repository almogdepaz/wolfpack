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
});
