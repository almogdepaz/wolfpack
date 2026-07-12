import { describe, expect, test } from "bun:test";
import {
  resizeRehydrateScrollTarget,
  shouldForceRepaintAfterFit,
  shouldSendResizeAfterGridFit,
  shouldResizeRehydrate,
} from "../../src/terminal-buffer";

describe("resize rehydrate scroll restore", () => {
  test("returns null when user was at bottom", () => {
    expect(resizeRehydrateScrollTarget({ oldScrollbackLength: 100, oldViewportY: 0, newScrollbackLength: 150 })).toBeNull();
  });

  test("preserves distance from scrollback bottom when user was scrolled up", () => {
    expect(resizeRehydrateScrollTarget({ oldScrollbackLength: 100, oldViewportY: 25, newScrollbackLength: 160 })).toBe(85);
  });

  test("clamps to top when new scrollback is shorter than saved distance", () => {
    expect(resizeRehydrateScrollTarget({ oldScrollbackLength: 100, oldViewportY: 80, newScrollbackLength: 10 })).toBe(0);
  });
});

describe("resize rehydrate scheduling", () => {
  test("skips rehydrate while viewport is at bottom", () => {
    expect(shouldResizeRehydrate(0, true)).toBe(false);
  });

  test("skips rehydrate when resize leaves viewport transiently above bottom without user scroll", () => {
    expect(shouldResizeRehydrate(1, false)).toBe(false);
  });

  test("rehydrates while user is scrolled up", () => {
    expect(shouldResizeRehydrate(1, true)).toBe(true);
  });
});

describe("resize repaint scheduling", () => {
  test("skips forced repaint after fit changed terminal dimensions", () => {
    expect(shouldForceRepaintAfterFit({ cols: 120, rows: 40 }, { cols: 100, rows: 40 }, true)).toBe(false);
  });

  test("keeps forced repaint when fit did not change terminal dimensions", () => {
    expect(shouldForceRepaintAfterFit({ cols: 120, rows: 40 }, { cols: 120, rows: 40 }, true)).toBe(true);
  });

  test("does not repaint when caller did not request repaint", () => {
    expect(shouldForceRepaintAfterFit({ cols: 120, rows: 40 }, { cols: 120, rows: 40 }, false)).toBe(false);
  });
});

describe("resize backend scheduling", () => {
  test("skips backend resize when fit preserves terminal grid dimensions", () => {
    expect(shouldSendResizeAfterGridFit({ cols: 120, rows: 40 }, { cols: 120, rows: 40 })).toBe(false);
  });

  test("sends backend resize when fit changes terminal grid dimensions", () => {
    expect(shouldSendResizeAfterGridFit({ cols: 120, rows: 40 }, { cols: 100, rows: 40 })).toBe(true);
  });
});
