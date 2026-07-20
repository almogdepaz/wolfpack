import { describe, expect, test } from "bun:test";
import {
  LAYOUT_STABLE_DEBUG_MODE_KEY,
  resolveLayoutStableDebugMode,
  shouldSendImmediateLayoutStable,
} from "../../src/terminal-layout-stable-debug";

describe("resolveLayoutStableDebugMode", () => {
  test("defaults to after-paint when debug is disabled", () => {
    const storage = new Map([[LAYOUT_STABLE_DEBUG_MODE_KEY, "immediate-and-after-paint"]]);

    expect(resolveLayoutStableDebugMode({ getItem: (key) => storage.get(key) ?? null }, false)).toBe("after-paint");
  });

  test("accepts immediate-and-after-paint only when debug is enabled", () => {
    const storage = new Map([[LAYOUT_STABLE_DEBUG_MODE_KEY, "immediate-and-after-paint"]]);

    expect(resolveLayoutStableDebugMode({ getItem: (key) => storage.get(key) ?? null }, true)).toBe("immediate-and-after-paint");
  });

  test("accepts viewport-only immediate mode only when debug is enabled", () => {
    const storage = new Map([[LAYOUT_STABLE_DEBUG_MODE_KEY, "viewport-immediate-and-after-paint"]]);

    expect(resolveLayoutStableDebugMode({ getItem: (key) => storage.get(key) ?? null }, true)).toBe("viewport-immediate-and-after-paint");
    expect(resolveLayoutStableDebugMode({ getItem: (key) => storage.get(key) ?? null }, false)).toBe("after-paint");
  });

  test("ignores invalid values", () => {
    const storage = new Map([[LAYOUT_STABLE_DEBUG_MODE_KEY, "immediate"]]);

    expect(resolveLayoutStableDebugMode({ getItem: (key) => storage.get(key) ?? null }, true)).toBe("after-paint");
  });
});

describe("shouldSendImmediateLayoutStable", () => {
  test("sends immediate for global debug mode", () => {
    expect(shouldSendImmediateLayoutStable("immediate-and-after-paint", "full")).toBe(true);
    expect(shouldSendImmediateLayoutStable("immediate-and-after-paint", "viewport")).toBe(true);
  });

  test("sends immediate for viewport-only mode only on viewport prefill", () => {
    expect(shouldSendImmediateLayoutStable("viewport-immediate-and-after-paint", "viewport")).toBe(true);
    expect(shouldSendImmediateLayoutStable("viewport-immediate-and-after-paint", "full")).toBe(false);
    expect(shouldSendImmediateLayoutStable("viewport-immediate-and-after-paint", "none")).toBe(false);
  });

  test("does not send immediate by default", () => {
    expect(shouldSendImmediateLayoutStable("after-paint", "viewport")).toBe(false);
  });
});
