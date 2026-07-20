import { describe, expect, test } from "bun:test";
import {
  HYDRATION_DEBUG_MIN_PENDING_KEY,
  HYDRATION_DEBUG_SILENCE_KEY,
  resolveHydrationDebugTiming,
} from "../../src/terminal-hydration-debug";

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

describe("resolveHydrationDebugTiming", () => {
  const defaults = { minPendingMs: 80, silenceMs: 32 } as const;

  test("keeps defaults when debug mode is disabled", () => {
    expect(resolveHydrationDebugTiming({
      debugEnabled: false,
      storage: storage({
        [HYDRATION_DEBUG_MIN_PENDING_KEY]: "0",
        [HYDRATION_DEBUG_SILENCE_KEY]: "0",
      }),
      defaults,
    })).toEqual(defaults);
  });

  test("uses non-negative finite overrides when debug mode is enabled", () => {
    expect(resolveHydrationDebugTiming({
      debugEnabled: true,
      storage: storage({
        [HYDRATION_DEBUG_MIN_PENDING_KEY]: "12",
        [HYDRATION_DEBUG_SILENCE_KEY]: "5",
      }),
      defaults,
    })).toEqual({ minPendingMs: 12, silenceMs: 5 });
  });

  test("ignores invalid override values independently", () => {
    expect(resolveHydrationDebugTiming({
      debugEnabled: true,
      storage: storage({
        [HYDRATION_DEBUG_MIN_PENDING_KEY]: "-1",
        [HYDRATION_DEBUG_SILENCE_KEY]: "17",
      }),
      defaults,
    })).toEqual({ minPendingMs: 80, silenceMs: 17 });
  });

  test("keeps defaults when storage is unavailable", () => {
    expect(resolveHydrationDebugTiming({
      debugEnabled: true,
      storage: null,
      defaults,
    })).toEqual(defaults);
  });
});
