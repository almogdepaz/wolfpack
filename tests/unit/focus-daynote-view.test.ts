import { expect, test } from "bun:test";
import { dayNoteSections } from "../../public/focus-day-note";
const mainFacts = "# day\n\n<!-- generated untrusted data -->\n\n## sessions\n- facts";
const updateFacts = "# later · after 2026-11-09T18:00:00.000Z\n\n<!-- generated untrusted data -->\n\n## git\n- new facts";
const note = (main: string, update: string) => `${mainFacts}\n\n## assistant\n${main}\n\n---\n\n${updateFacts}\n\n## assistant\n${update}\n`;

test("D1: main and answered updates are authored sections in order, never collapsed with facts", () => {
  const parsed = dayNoteSections(note("Main review.", "Evening outcome."));
  expect(parsed.writeUps).toEqual([{ text: "Main review." }, { label: "later · after 2026-11-09T18:00:00.000Z", text: "Evening outcome." }]);
  expect(parsed.pending).toBe(false);
  expect(parsed.details).toContain(mainFacts);
  expect(parsed.details).toContain(updateFacts);
  expect(parsed.details).not.toContain("Main review.");
  expect(parsed.details).not.toContain("Evening outcome.");
});
test("D1: a pending newest update preserves the main write-up", () => {
  const parsed = dayNoteSections(note("Main review.", ""));
  expect(parsed.writeUps).toEqual([{ text: "Main review." }]);
  expect(parsed.pending).toBe(true);
  expect(parsed.details).not.toContain("Main review.");
});
test("D1: no answered section has no invented prose, and multiple updates keep their own labels", () => {
  expect(dayNoteSections(note("", "")).writeUps).toEqual([]);
  expect(dayNoteSections(note("", "")).pending).toBe(true);
  const more = `${note("Main review.", "First update.")}\n---\n\n# later · after 2026-11-09T20:00:00.000Z\n\n## sessions\n- more facts\n\n## assistant\nSecond update.\n`;
  expect(dayNoteSections(more).writeUps.map(s => [s.label, s.text])).toEqual([
    [undefined, "Main review."], ["later · after 2026-11-09T18:00:00.000Z", "First update."], ["later · after 2026-11-09T20:00:00.000Z", "Second update."],
  ]);
});
test("old plain prose and CRLF remain readable; inline lookalike markers are not section delimiters", () => {
  expect(dayNoteSections("# day\r\n\r\n## assistant\r\n\r\nPlain prose.\r\n- ## assistant is data\r\n").writeUps).toEqual([{ text: "Plain prose.\r\n- ## assistant is data" }]);
  expect(dayNoteSections("## sessions\n- ## assistant is data")).toEqual({ writeUps: [], pending: false, details: "## sessions\n- ## assistant is data" });
});
