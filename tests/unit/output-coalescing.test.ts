import { describe, expect, test } from "bun:test";
import { shouldFlushCoalescedOutput } from "../../src/output-coalescing";

describe("output coalescing flush decision", () => {
  test("does not flush while under byte and time limits", () => {
    expect(shouldFlushCoalescedOutput({ queuedBytes: 10, nextBytes: 5, maxBytes: 100, heldMs: 20, hardMs: 150 })).toBe(false);
  });

  test("flushes when adding the next chunk reaches the byte cap", () => {
    expect(shouldFlushCoalescedOutput({ queuedBytes: 90, nextBytes: 10, maxBytes: 100, heldMs: 20, hardMs: 150 })).toBe(true);
  });

  test("flushes when the hard time cap is reached", () => {
    expect(shouldFlushCoalescedOutput({ queuedBytes: 10, nextBytes: 5, maxBytes: 100, heldMs: 150, hardMs: 150 })).toBe(true);
  });
});
