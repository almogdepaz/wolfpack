import { describe, expect, test } from "bun:test";
import {
  GHOSTTY_PREWARM_DEBUG_DELAY_KEY,
  resolveGhosttyPrewarmDebugTiming,
} from "../../src/ghostty-prewarm-debug";

function storage(values: Record<string, string | null>): Storage {
  return {
    getItem(key: string): string | null {
      return values[key] ?? null;
    },
    setItem(): void {},
    removeItem(): void {},
    clear(): void {},
    key(): string | null { return null; },
    length: 0,
  };
}

describe("resolveGhosttyPrewarmDebugTiming", () => {
  const defaults = { delayMs: 750 } as const;

  test("keeps defaults when debug mode is disabled", () => {
    expect(resolveGhosttyPrewarmDebugTiming({
      debugEnabled: false,
      storage: storage({ [GHOSTTY_PREWARM_DEBUG_DELAY_KEY]: "0" }),
      defaults,
    })).toEqual(defaults);
  });

  test("uses non-negative finite delay overrides when debug mode is enabled", () => {
    expect(resolveGhosttyPrewarmDebugTiming({
      debugEnabled: true,
      storage: storage({ [GHOSTTY_PREWARM_DEBUG_DELAY_KEY]: "0" }),
      defaults,
    })).toEqual({ delayMs: 0 });
  });

  test("ignores invalid delay overrides", () => {
    for (const value of ["", "-1", "NaN", "Infinity"]) {
      expect(resolveGhosttyPrewarmDebugTiming({
        debugEnabled: true,
        storage: storage({ [GHOSTTY_PREWARM_DEBUG_DELAY_KEY]: value }),
        defaults,
      })).toEqual(defaults);
    }
  });

  test("keeps defaults when storage is unavailable", () => {
    expect(resolveGhosttyPrewarmDebugTiming({
      debugEnabled: true,
      storage: null,
      defaults,
    })).toEqual(defaults);
  });
});
