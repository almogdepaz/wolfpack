import { expect, test } from "bun:test";
import { dayNoteSections } from "../../public/focus-day-note";
test("latest assistant heading wins and all preceding material stays in the details", () => {
  const prefix = "# day\n\n## sessions\n- facts\n\n## assistant\nOld review\n\n---\n\n# later\n## sessions\n- new facts\n\n";
  expect(dayNoteSections(`${prefix}## assistant\n\n### done\n- Latest outcome.\n`)).toEqual({ writeUp: "### done\n- Latest outcome.", details: prefix.trim() });
  expect(dayNoteSections(`${prefix}## assistant\n\n`)).toEqual({ writeUp: "", details: prefix.trim() });
});
test("old plain prose and CRLF remain readable; inline lookalike markers are not section delimiters", () => {
  expect(dayNoteSections("# day\r\n\r\n## assistant\r\n\r\nPlain prose.\r\n- ## assistant is data\r\n").writeUp).toBe("Plain prose.\r\n- ## assistant is data");
  expect(dayNoteSections("## sessions\n- ## assistant is data")).toEqual({ writeUp: "", details: "## sessions\n- ## assistant is data" });
});
