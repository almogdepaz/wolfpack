import { describe, test, expect } from "bun:test";
import {
  captureScrollState,
  scrollTargetAfterResize,
  serializeBufferTail,
  type TerminalBuffer,
} from "../../src/terminal-buffer";

// ── Helpers ──────────────────────────────────────────────────────────

function mockBuffer(opts: {
  viewportY: number;
  baseY: number;
  lines: string[];
}): TerminalBuffer {
  return {
    viewportY: opts.viewportY,
    baseY: opts.baseY,
    length: opts.lines.length,
    getLine(i: number) {
      if (i < 0 || i >= opts.lines.length) return null;
      return { translateToString: (_trim: boolean) => opts.lines[i] };
    },
  };
}

// ── captureScrollState ───────────────────────────────────────────────

describe("captureScrollState", () => {
  test("detects user is at bottom (viewportY == baseY)", () => {
    const buf = mockBuffer({ viewportY: 50, baseY: 50, lines: [] });
    const state = captureScrollState(buf);
    expect(state.wasAtBottom).toBe(true);
    expect(state.distanceFromBottom).toBe(0);
  });

  test("detects user is at bottom (viewportY > baseY)", () => {
    // Can happen transiently during fast output
    const buf = mockBuffer({ viewportY: 51, baseY: 50, lines: [] });
    const state = captureScrollState(buf);
    expect(state.wasAtBottom).toBe(true);
    expect(state.distanceFromBottom).toBe(0);
  });

  test("detects user scrolled up", () => {
    const buf = mockBuffer({ viewportY: 30, baseY: 50, lines: [] });
    const state = captureScrollState(buf);
    expect(state.wasAtBottom).toBe(false);
    expect(state.distanceFromBottom).toBe(20);
  });

  test("at top of scrollback", () => {
    const buf = mockBuffer({ viewportY: 0, baseY: 100, lines: [] });
    const state = captureScrollState(buf);
    expect(state.wasAtBottom).toBe(false);
    expect(state.distanceFromBottom).toBe(100);
  });

  test("empty terminal (both zero)", () => {
    const buf = mockBuffer({ viewportY: 0, baseY: 0, lines: [] });
    const state = captureScrollState(buf);
    expect(state.wasAtBottom).toBe(true);
    expect(state.distanceFromBottom).toBe(0);
  });
});

// ── scrollTargetAfterResize ──────────────────────────────────────────

describe("scrollTargetAfterResize", () => {
  test("preserves distance from bottom", () => {
    // Was 20 lines from bottom, new baseY is 60
    expect(scrollTargetAfterResize(60, 20)).toBe(40);
  });

  test("clamps to 0 when distance exceeds new baseY", () => {
    // Was 100 lines from bottom but new buffer only has 30 scrollback
    expect(scrollTargetAfterResize(30, 100)).toBe(0);
  });

  test("bottom when distance is 0", () => {
    expect(scrollTargetAfterResize(80, 0)).toBe(80);
  });

  test("zero baseY", () => {
    expect(scrollTargetAfterResize(0, 0)).toBe(0);
    expect(scrollTargetAfterResize(0, 5)).toBe(0);
  });
});

// ── serializeBufferTail ──────────────────────────────────────────────

describe("serializeBufferTail", () => {
  test("serializes all lines when maxLines >= length", () => {
    const buf = mockBuffer({
      viewportY: 0,
      baseY: 0,
      lines: ["line 1", "line 2", "line 3"],
    });
    expect(serializeBufferTail(buf, 100)).toBe("line 1\nline 2\nline 3");
  });

  test("takes only last N lines", () => {
    const buf = mockBuffer({
      viewportY: 0,
      baseY: 0,
      lines: ["old 1", "old 2", "old 3", "recent 1", "recent 2"],
    });
    expect(serializeBufferTail(buf, 2)).toBe("recent 1\nrecent 2");
  });

  test("ignores unused trailing viewport rows before taking the tail", () => {
    const buf = mockBuffer({
      viewportY: 0,
      baseY: 0,
      lines: ["current output", "", "", ""],
    });
    expect(serializeBufferTail(buf, 2)).toBe("current output");
  });

  test("handles empty buffer", () => {
    const buf = mockBuffer({ viewportY: 0, baseY: 0, lines: [] });
    expect(serializeBufferTail(buf, 10)).toBe("");
  });

  test("handles single line", () => {
    const buf = mockBuffer({ viewportY: 0, baseY: 0, lines: ["only line"] });
    expect(serializeBufferTail(buf, 10)).toBe("only line");
  });

  test("skips null lines from getLine", () => {
    const buf: TerminalBuffer = {
      viewportY: 0,
      baseY: 0,
      length: 3,
      getLine(i: number) {
        if (i === 1) return null; // sparse/missing line
        return { translateToString: () => `line ${i}` };
      },
    };
    expect(serializeBufferTail(buf, 10)).toBe("line 0\nline 2");
  });

  test("maxLines exactly equal to length", () => {
    const buf = mockBuffer({
      viewportY: 0,
      baseY: 0,
      lines: ["a", "b", "c"],
    });
    expect(serializeBufferTail(buf, 3)).toBe("a\nb\nc");
  });

  test("maxLines of 0 returns empty", () => {
    const buf = mockBuffer({
      viewportY: 0,
      baseY: 0,
      lines: ["a", "b"],
    });
    expect(serializeBufferTail(buf, 0)).toBe("");
  });
});

// ── Integration: full scroll-preserve round-trip ─────────────────────

describe("scroll-preserve round-trip", () => {
  test("user at bottom → after resize stays at bottom (no scrollToLine needed)", () => {
    const buf = mockBuffer({ viewportY: 50, baseY: 50, lines: [] });
    const state = captureScrollState(buf);
    expect(state.wasAtBottom).toBe(true);
    // When wasAtBottom, fitTerminalPreserveScroll skips scrollToLine — auto-follows
  });

  test("user scrolled up → resize preserves relative position", () => {
    const buf = mockBuffer({ viewportY: 30, baseY: 50, lines: [] });
    const state = captureScrollState(buf);
    expect(state.wasAtBottom).toBe(false);
    expect(state.distanceFromBottom).toBe(20);

    // After resize, baseY might change (e.g., more cols = fewer wrapped lines)
    const newBaseY = 40;
    const target = scrollTargetAfterResize(newBaseY, state.distanceFromBottom);
    expect(target).toBe(20); // 40 - 20 = 20
  });

  test("user scrolled up → resize shrinks buffer below saved distance", () => {
    const buf = mockBuffer({ viewportY: 10, baseY: 100, lines: [] });
    const state = captureScrollState(buf);
    expect(state.distanceFromBottom).toBe(90);

    // Massive resize shrinks scrollback
    const newBaseY = 20;
    const target = scrollTargetAfterResize(newBaseY, state.distanceFromBottom);
    expect(target).toBe(0); // clamped to top
  });
});
