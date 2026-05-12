/**
 * Regression coverage for issue #130: defensive feature-detection around the
 * ghostty-web private repaint hook so a future bundle update that renames or
 * restructures `renderer` / `wasmTerm` / `viewportY` triggers a loud warning
 * instead of a silent no-op.
 */
import { describe, expect, test } from "bun:test";
import { hasGhosttyRepaintHook } from "../../public/terminal-repaint.ts";

describe("hasGhosttyRepaintHook — ghostty-web internals probe", () => {
  test("returns true for a terminal exposing the expected shape", () => {
    const term = {
      renderer: { render: () => {} },
      wasmTerm: { _: "opaque" },
      viewportY: 0,
    };
    expect(hasGhosttyRepaintHook(term)).toBe(true);
  });

  test("accepts viewportY === 0 (falsy but present)", () => {
    const term = { renderer: { render: () => {} }, wasmTerm: {}, viewportY: 0 };
    expect(hasGhosttyRepaintHook(term)).toBe(true);
  });

  test("rejects when renderer is missing", () => {
    expect(hasGhosttyRepaintHook({ wasmTerm: {}, viewportY: 0 })).toBe(false);
  });

  test("rejects when renderer.render is not a function", () => {
    expect(
      hasGhosttyRepaintHook({ renderer: { render: 123 }, wasmTerm: {}, viewportY: 0 }),
    ).toBe(false);
  });

  test("rejects when wasmTerm is undefined", () => {
    expect(
      hasGhosttyRepaintHook({ renderer: { render: () => {} }, viewportY: 0 }),
    ).toBe(false);
  });

  test("rejects when viewportY is absent", () => {
    expect(
      hasGhosttyRepaintHook({ renderer: { render: () => {} }, wasmTerm: {} }),
    ).toBe(false);
  });

  test("rejects null / undefined / non-object", () => {
    expect(hasGhosttyRepaintHook(null)).toBe(false);
    expect(hasGhosttyRepaintHook(undefined)).toBe(false);
    expect(hasGhosttyRepaintHook("term")).toBe(false);
    expect(hasGhosttyRepaintHook(42)).toBe(false);
  });

  test("rejects a renamed renderer field (simulates upstream drift)", () => {
    const term = {
      // ghostty-web hypothetically renames this in a future release
      renderEngine: { render: () => {} },
      wasmTerm: {},
      viewportY: 0,
    };
    expect(hasGhosttyRepaintHook(term)).toBe(false);
  });
});
