import { describe, expect, test } from "bun:test";
import { CURSOR_BLINK_DEBUG_DISABLED_KEY, isCursorBlinkDebugDisabled } from "../../src/terminal-cursor-blink-debug";

function storage(values: Record<string, string>): Pick<Storage, "getItem"> {
  return { getItem: (key: string): string | null => values[key] ?? null };
}

describe("isCursorBlinkDebugDisabled", () => {
  test("disables blinking only when debug mode is on and the key is set to 1", () => {
    expect(isCursorBlinkDebugDisabled(storage({ [CURSOR_BLINK_DEBUG_DISABLED_KEY]: "1" }), true)).toBe(true);
  });

  test("ignores the key when debug mode is off", () => {
    expect(isCursorBlinkDebugDisabled(storage({ [CURSOR_BLINK_DEBUG_DISABLED_KEY]: "1" }), false)).toBe(false);
  });

  test("keeps blinking for a missing or other value or unavailable storage", () => {
    expect(isCursorBlinkDebugDisabled(storage({}), true)).toBe(false);
    expect(isCursorBlinkDebugDisabled(storage({ [CURSOR_BLINK_DEBUG_DISABLED_KEY]: "0" }), true)).toBe(false);
    expect(isCursorBlinkDebugDisabled(null, true)).toBe(false);
  });
});
