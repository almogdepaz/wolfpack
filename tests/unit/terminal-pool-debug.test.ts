import { describe, expect, test } from "bun:test";
import {
  PARKED_TERMINAL_DEBUG_TTL_KEY,
  resolveParkedTerminalDebugTtlMs,
  TERMINAL_POOL_DEBUG_SIZE_KEY,
  TERMINAL_POOL_DEBUG_MAX_SIZE,
  resolveTerminalPoolDebugSize,
} from "../../src/terminal-pool-debug";

function storage(values: Record<string, string | null>): Pick<Storage, "getItem"> {
  return { getItem: (key: string): string | null => values[key] ?? null };
}

describe("resolveTerminalPoolDebugSize", () => {
  test("keeps the default when debug mode is disabled", () => {
    expect(resolveTerminalPoolDebugSize({
      debugEnabled: false,
      storage: storage({ [TERMINAL_POOL_DEBUG_SIZE_KEY]: "1" }),
      defaultSize: 3,
    })).toBe(3);
  });

  test("uses an integer override between 1 and the maximum when debug mode is enabled", () => {
    for (const size of [1, 3, TERMINAL_POOL_DEBUG_MAX_SIZE]) {
      expect(resolveTerminalPoolDebugSize({
        debugEnabled: true,
        storage: storage({ [TERMINAL_POOL_DEBUG_SIZE_KEY]: String(size) }),
        defaultSize: 3,
      })).toBe(size);
    }
  });

  test("ignores invalid overrides and missing storage", () => {
    for (const value of ["", "0", "-1", "1.5", "NaN", String(TERMINAL_POOL_DEBUG_MAX_SIZE + 1)]) {
      expect(resolveTerminalPoolDebugSize({
        debugEnabled: true,
        storage: storage({ [TERMINAL_POOL_DEBUG_SIZE_KEY]: value }),
        defaultSize: 1,
      })).toBe(1);
    }
    expect(resolveTerminalPoolDebugSize({ debugEnabled: true, storage: null, defaultSize: 3 })).toBe(3);
  });
});

describe("resolveParkedTerminalDebugTtlMs", () => {
  test("keeps the default unless debug mode supplies a positive finite override", () => {
    const resolve = (debugEnabled: boolean, value: string | null): number => resolveParkedTerminalDebugTtlMs({
      debugEnabled,
      storage: storage({ [PARKED_TERMINAL_DEBUG_TTL_KEY]: value }),
      defaultTtlMs: 150_000,
    });
    expect(resolve(false, "500")).toBe(150_000);
    expect(resolve(true, "500")).toBe(500);
    for (const value of [null, "", "0", "-5", "NaN", "Infinity"]) expect(resolve(true, value)).toBe(150_000);
    expect(resolveParkedTerminalDebugTtlMs({ debugEnabled: true, storage: null, defaultTtlMs: 150_000 })).toBe(150_000);
  });
});
