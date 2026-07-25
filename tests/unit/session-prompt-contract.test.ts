import { describe, expect, test } from "bun:test";
import {
  SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS,
  SESSION_PROMPT_PENDING_OUTPUT_MAX_BYTES,
  unicodeCodePointLength,
  unicodeCodePointSuffix,
} from "../../src/session-prompt-contract.ts";

describe("session prompt Unicode contract", () => {
  test("counts code points and truncates without splitting a surrogate pair", () => {
    expect(unicodeCodePointLength("a🚀é")).toBe(3);
    expect(unicodeCodePointSuffix("prefix🚀", 1)).toBe("🚀");
  });

  test("bounds readiness bytes for maximum UTF-8 plus decoder alignment", () => {
    expect(SESSION_PROMPT_PENDING_OUTPUT_MAX_BYTES).toBe(
      SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS * 4 + 3,
    );
  });
});
