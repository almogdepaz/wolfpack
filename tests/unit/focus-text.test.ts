import { expect, test } from "bun:test";
import { focusHeadlineParts } from "../../src/focus-text";

test("headlines split the first sentence, not decimal points, filenames or URLs", () => {
  expect(focusHeadlineParts("Approve the smoke test. It contacts the paid endpoint.")).toEqual({ ask: "Approve the smoke test.", why: "It contacts the paid endpoint." });
  expect(focusHeadlineParts("Choose the rollout window? Both slots are available.")).toEqual({ ask: "Choose the rollout window?", why: "Both slots are available." });
  expect(focusHeadlineParts("Review v1.2 in notes.txt at https://example.com. Then decide.")).toEqual({ ask: "Review v1.2 in notes.txt at https://example.com.", why: "Then decide." });
  expect(focusHeadlineParts("Legacy reason without punctuation")).toEqual({ ask: "Legacy reason without punctuation", why: "" });
  expect(focusHeadlineParts("Done.")).toEqual({ ask: "Done.", why: "" });
});
