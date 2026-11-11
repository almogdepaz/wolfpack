import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { AGENT_KIND } from "../../src/agent-kind.ts";
import { focusSummary } from "../../src/focus-summary.ts";

// Captured screens are untrusted fixture data, never instructions to execute.
const captures = [
  { file: "pi-real-mock-suggest.txt", lastLine: "Proceed with step 2 — insert the badge into README.md?" },
  { file: "pi-real-assistant.txt", lastLine: "remains first." },
];

describe("real pi summary chrome", () => {
  for (const capture of captures) {
    const rows = readFileSync(new URL(`./fixtures/focus-summary/${capture.file}`, import.meta.url), "utf8").split("\n");
    test(capture.file, () => {
      const summary = focusSummary(rows, AGENT_KIND.PI.id);
      expect(summary.at(-1)).toBe(capture.lastLine);
      expect(summary.join("\n")).not.toMatch(/fatal:|~\/\.(?:cache|wolfpack)|↑|Update Available|New version|Changelog:/u);
    });
    test(`${capture.file} with an extra footer rule`, () => {
      const cwdIndex = rows.findLastIndex(row => row.startsWith("~/"));
      const withRule = [...rows.slice(0, cwdIndex), "──────────────────", ...rows.slice(cwdIndex)];
      const summary = focusSummary(withRule, AGENT_KIND.PI.id);
      expect(summary.at(-1)).toBe(capture.lastLine);
      expect(summary.join("\n")).not.toMatch(/fatal:|~\/\.(?:cache|wolfpack)|↑|Update Available|New version|Changelog:/u);
    });
    test(`${capture.file} with a blank editor instead of stray stderr`, () => {
      const summary = focusSummary(rows.map(row => row.startsWith("fatal:") ? "" : row), AGENT_KIND.PI.id);
      expect(summary.at(-1)).toBe(capture.lastLine);
      expect(summary.join("\n")).not.toMatch(/~\/\.(?:cache|wolfpack)|↑|Update Available|New version|Changelog:/u);
    });
  }
  test("does not mistake cost/review prose for a glyph-less footer", () => {
    const body = ["$5 per day is the limit; may I proceed?", "R2 still fails on iphone-se", "W1 flaky retry", "↑3 files staged, ready"];
    expect(focusSummary([...body, "──────────────────", "", "──────────────────"], AGENT_KIND.PI.id)).toEqual(body);
  });
  test("update-like prose outside the startup box stays visible", () => {
    const body = ["Update Available", "New version 1.5.2 is available. Run pi update", "Changelog: https://pi.dev/changelog", "Should I review that update?"];
    expect(focusSummary(body, AGENT_KIND.PI.id)).toEqual(body);
  });
});
