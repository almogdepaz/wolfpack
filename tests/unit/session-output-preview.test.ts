import { describe, expect, test } from "bun:test";
import { lastTerminalPreviewLine } from "../../src/server/session-observation";

describe("cached session output preview", () => {
  test("uses the final rendered line and bounds/control-sanitizes it", () => {
    expect(lastTerminalPreviewLine("first\n final status ")).toBe("final status");
    expect(lastTerminalPreviewLine("ok\u0007bad")).toBe("okbad");
    expect(Array.from(lastTerminalPreviewLine("x".repeat(500)))).toHaveLength(240);
  });
});
