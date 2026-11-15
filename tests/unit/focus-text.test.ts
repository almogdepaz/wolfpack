import { expect, test } from "bun:test";
import { focusHeadlineParts, isFocusStatusBar } from "../../src/focus-text";

test("status bars require a spaced pipe and only recognizable status segments", () => {
  for (const line of ["Opus 5.5 | tokens: 152.3k | ctx: 25% left", "gpt-6.1-sol | cost: $1.25", "tokens: 150k | context left: 25%", "claude-sonnet-4-5 | ctx: 5% left"]) expect(isFocusStatusBar(line)).toBe(true);
  for (const line of ["", "Opus 5.5", "tokens: 150k", "Opus 5.5|tokens: 150k", "Choose tokens | or credentials?", "Implement tokens: 5 | rerun tests", "Opus 5.5 | Approval is needed", "Cost of rollout | approve $5?", "Review file.ts | ctx: 25% left"]) expect(isFocusStatusBar(line)).toBe(false);
});

test("headlines split the first sentence, not decimal points, filenames or URLs", () => {
  expect(focusHeadlineParts("Approve the smoke test. It contacts the paid endpoint.")).toEqual({ ask: "Approve the smoke test.", why: "It contacts the paid endpoint." });
  expect(focusHeadlineParts("Choose the rollout window? Both slots are available.")).toEqual({ ask: "Choose the rollout window?", why: "Both slots are available." });
  expect(focusHeadlineParts("Review v1.2 in notes.txt at https://example.com. Then decide.")).toEqual({ ask: "Review v1.2 in notes.txt at https://example.com.", why: "Then decide." });
  expect(focusHeadlineParts("Legacy reason without punctuation")).toEqual({ ask: "Legacy reason without punctuation", why: "" });
  expect(focusHeadlineParts("Done.")).toEqual({ ask: "Done.", why: "" });
});
