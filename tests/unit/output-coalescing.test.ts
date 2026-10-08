import { describe, expect, test } from "bun:test";
import { decideOutputCoalescing } from "../../src/output-coalescing";

const DEFAULT_INPUT = {
  queuedBytes: 0,
  nextBytes: 5,
  sinceLastSendMs: 16,
  maxBytes: 128 * 1024,
  smallChunkBytes: 1024,
  idleMs: 16,
};

describe("output coalescing decision", () => {
  test("holds output without a timer when the ack window is exhausted", () => {
    expect(decideOutputCoalescing({ ...DEFAULT_INPUT, availableBytes: 0 })).toBe("buffer_until_ack");
    expect(decideOutputCoalescing({ ...DEFAULT_INPUT, availableBytes: 0, nextBytes: 128 * 1024 })).toBe("buffer_until_ack");
  });

  test("flushes in order when output exceeds the remaining ack credit", () => {
    expect(decideOutputCoalescing({ ...DEFAULT_INPUT, availableBytes: 4 })).toBe("flush_then_send");
    expect(decideOutputCoalescing({ ...DEFAULT_INPUT, availableBytes: 100, queuedBytes: 96 })).toBe("flush_then_send");
  });

  test("preserves leading edge and coalescing decisions inside the ack window", () => {
    expect(decideOutputCoalescing({ ...DEFAULT_INPUT, availableBytes: 512 * 1024 })).toBe("send_now");
    expect(decideOutputCoalescing({ ...DEFAULT_INPUT, availableBytes: 512 * 1024, nextBytes: 1025 })).toBe("buffer");
    expect(decideOutputCoalescing({ ...DEFAULT_INPUT, availableBytes: 5 })).toBe("send_now");
    expect(decideOutputCoalescing({ ...DEFAULT_INPUT, availableBytes: 5, sinceLastSendMs: 15 })).toBe("buffer");
  });

  test("sends isolated small output immediately at the idle boundary", () => {
    expect(decideOutputCoalescing(DEFAULT_INPUT)).toBe("send_now");
    expect(decideOutputCoalescing({ ...DEFAULT_INPUT, nextBytes: 1024 })).toBe("send_now");
  });

  test("buffers large redraw output even after idle", () => {
    expect(decideOutputCoalescing({ ...DEFAULT_INPUT, nextBytes: 1025 })).toBe("buffer");
  });

  test("buffers small output before the idle boundary", () => {
    expect(decideOutputCoalescing({ ...DEFAULT_INPUT, sinceLastSendMs: 15 })).toBe("buffer");
  });

  test("never sends small output ahead of buffered bytes", () => {
    expect(decideOutputCoalescing({ ...DEFAULT_INPUT, queuedBytes: 64 })).toBe("buffer");
  });

  test("flushes before buffering when the combined size reaches or exceeds the cap", () => {
    for (const nextBytes of [1024, 1025]) {
      expect(decideOutputCoalescing({ ...DEFAULT_INPUT, queuedBytes: 127 * 1024, nextBytes })).toBe("flush_then_buffer");
    }
  });

  test("flushes before sending a chunk that alone reaches or exceeds the cap", () => {
    for (const queuedBytes of [0, 64]) {
      for (const nextBytes of [128 * 1024, 128 * 1024 + 1]) {
        expect(decideOutputCoalescing({ ...DEFAULT_INPUT, queuedBytes, nextBytes })).toBe("flush_then_send");
      }
    }
  });
});
