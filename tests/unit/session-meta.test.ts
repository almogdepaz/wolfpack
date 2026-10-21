import { expect, test } from "bun:test";
import { sessionMetaHtml } from "../../public/session-meta";

test("renders labeled structured fields with amber context at 85%", () => {
  const html = sessionMetaHtml({ meta: { model: "gpt-6-astra", reasoning: "medium", contextPct: 85, contextLimit: 272000, cost: 42.822, costTag: "sub" }, footer: "raw footer" });
  expect(html).toContain("gpt-6-astra · medium");
  expect(html).toContain('class="session-meta-context high"');
  expect(html).toContain("ctx 85%");
  expect(html).toContain("272k limit");
  expect(html).toContain("$42.822 (sub)");
  expect(html).not.toContain("raw footer");
  expect(sessionMetaHtml({ meta: { contextPct: 84.9, cost: 0 } })).not.toContain('context high');
  expect(sessionMetaHtml({ meta: { cost: 0 } })).toContain("$0.000");
});
test("raw footer fallback and all metadata are escaped", () => {
  expect(sessionMetaHtml({ footer: '<img src=x onerror="alert(1)">' })).toContain("&lt;img");
  expect(sessionMetaHtml({ meta: { model: "<script>", reasoning: "<b>", costTag: "<i>", cost: 1 } })).not.toContain("<script>");
  expect(sessionMetaHtml({})).toBe("");
});
