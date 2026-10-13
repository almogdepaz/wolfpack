import { describe, expect, test } from "bun:test";
import { harnessIconHtml } from "../../public/harness-icon.ts";

describe("harnessIconHtml", () => {
  test("renders a labelled icon for every known harness", () => {
    for (const kind of ["pi", "claude", "codex", "gemini", "cursor", "shell"]) {
      const html = harnessIconHtml(kind);
      expect(html).toContain(`class="harness-icon"`);
      expect(html).toContain(`data-harness="${kind}"`);
      expect(html).toContain(`aria-label="${kind}"`);
      expect(html).toContain(`title="${kind}"`);
    }
  });

  test("renders nothing for custom, unknown, or missing kinds", () => {
    expect(harnessIconHtml("custom")).toBe("");
    expect(harnessIconHtml("something-else")).toBe("");
    expect(harnessIconHtml(undefined)).toBe("");
    expect(harnessIconHtml(42)).toBe("");
  });

  test("never interpolates unvalidated input into markup", () => {
    expect(harnessIconHtml('pi" onmouseover="x')).toBe("");
  });
});
