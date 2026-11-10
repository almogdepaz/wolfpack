import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
const day = new Date(Date.now() - 2 * 86400_000).toLocaleDateString("en-CA");
const latest = "### done\n- The review is finished.\n- The release is ready.\n\n### still open\n- The rollout remains open.\n- The retry needs verification.\n\n### needs you tomorrow\n- Choose the rollout window.\n- Review <img src=x onerror=alert(1)> as literal text.\n";
async function note(text: string) {
  mkdirSync(join(server.home, ".wolfpack/assistant/days"), { recursive: true });
  writeFileSync(join(server.home, ".wolfpack/assistant/days", `${day}.md`), text);
}

test.beforeEach(async ({ page }) => {
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  expect((await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops: [
    { type: "day-summary", summary: { date: day, done: 2, carried: 2, questions: 1 } },
    { type: "seen-day-note", at: "1970-01-01T00:00:00.000Z" },
  ] } })).ok()).toBe(true);
});

for (const width of [1440, 1280, 390]) test(`day note ${width} opens all readable write-ups first, with raw facts collapsed and mark-read intact`, async ({ page }, info) => {
  test.skip(info.project.name === "desktop" ? width === 390 : width !== 390, "viewport belongs to the matching project");
  await page.setViewportSize({ width, height: 900 });
  await note(`# ${day}\n\n## sessions\n\n- generated session facts\n\n## assistant\n\nEarlier write-up.\n\n---\n\n# later · after today\n\n<!-- generated untrusted data -->\n\n## git\n\n- generated commit facts\n\n## assistant\n\n${latest}`);
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await page.getByRole("button", { name: `Read day note for ${day}`, exact: true }).click();
  const dialog = page.locator("#app-dialog");
  await expect(dialog.locator(".focus-note > section")).toContainText("Earlier write-up.");
  const writeUp = dialog.getByRole("region", { name: "Assistant write-ups", exact: true });
  await expect(writeUp.getByRole("heading")).toHaveText(["done", "still open", "needs you tomorrow"]);
  await expect(writeUp.getByRole("listitem")).toHaveCount(6);
  await expect(writeUp).toContainText("Earlier write-up.");
  const authored = await writeUp.textContent();
  expect(authored!.indexOf("Earlier write-up.")).toBeLessThan(authored!.indexOf("The review is finished."));
  await expect(writeUp).toContainText("later · after today");
  await expect(writeUp).toContainText("Review <img src=x onerror=alert(1)> as literal text.");
  await expect(dialog.locator("img")).toHaveCount(0);
  const details = dialog.locator("details");
  await expect(details).not.toHaveAttribute("open");
  await expect(details.locator("pre")).toBeHidden();
  expect(await writeUp.evaluate(el => !!(el.compareDocumentPosition(el.parentElement!.querySelector("details")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  expect(await writeUp.evaluate(el => getComputedStyle(el).fontFamily)).not.toMatch(/mono/i);
  const gaps = await writeUp.locator("h3").evaluateAll(headings => headings.slice(1).map(h => h.getBoundingClientRect().top - h.previousElementSibling!.getBoundingClientRect().bottom));
  for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(10);
  if (info.project.name === "iphone-14") expect((await details.locator("summary").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await new AxeBuilder({ page }).include("#app-dialog").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`day-note-${width}.png`), fullPage: true });
  await details.locator("summary").click();
  await expect(details.locator("pre")).toContainText("generated commit facts");
  await expect(details.locator("pre")).not.toContainText("Earlier write-up.");
  await expect(details.locator("pre")).not.toContainText("The review is finished.");
  await page.locator("#app-dialog-confirm").click();
  await expect(page.locator("#assistant-content .focus-yesterday")).toHaveCount(0);
});

for (const [timezoneId, clock] of [["America/New_York", "13:05"], ["Asia/Jerusalem", "20:05"]] as const) test.describe(`update labels in ${timezoneId}`, () => {
  test.use({ timezoneId });
  test("update label uses local HH:MM and preserves an unparseable label", async ({ page }) => {
    const instant = "2026-11-09T18:05:00.000Z";
    await note(`# ${day}\n\n## assistant\nMain review.\n\n---\n\n# later · after ${instant}\n\n## sessions\n- update facts\n\n## assistant\nEvening review.\n\n---\n\n# later · after not-a-timestamp\n\n## sessions\n- more facts\n\n## assistant\nAnother review.\n`);
    await page.goto(server.baseUrl);
    await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
    await page.getByRole("button", { name: `Read day note for ${day}`, exact: true }).click();
    const dialog = page.locator("#app-dialog");
    await expect(dialog.locator(".focus-context-note")).toHaveText([`later · after ${clock}`, "later · after not-a-timestamp"]);
    await expect(dialog.getByRole("region", { name: "Assistant write-ups", exact: true })).not.toContainText(instant);
    await dialog.locator("summary").click();
    await expect(dialog.locator("pre")).toContainText(instant);
    await page.locator("#app-dialog-cancel").click();
  });
});

for (const empty of ["no heading", "pending update", "none answered"] as const) test(`day note ${empty}: authored reviews stay visible and generated facts stay collapsed`, async ({ page }) => {
  await note(empty === "no heading" ? `# ${day}\n\n## sessions\n- raw activity only` : `# ${day}\n\n## assistant\n${empty === "pending update" ? "Earlier prose" : ""}\n\n---\n\n# later · after 2026-11-09T18:00:00.000Z\n\n## sessions\n- raw activity only\n\n## assistant\n\n`);
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await page.getByRole("button", { name: `Read day note for ${day}`, exact: true }).click();
  const dialog = page.locator("#app-dialog");
  const authored = dialog.getByRole("region", { name: "Assistant write-ups", exact: true });
  if (empty === "pending update") {
    await expect(authored).toContainText("Earlier prose");
    await expect(authored).not.toContainText("No assistant write-up yet.");
  } else await expect(authored).toContainText("No assistant write-up yet.");
  if (empty !== "no heading") await expect(authored).toContainText("Update pending.");
  await expect(dialog.locator("details")).not.toHaveAttribute("open");
  await dialog.locator("summary").click();
  await expect(dialog.locator("pre")).toContainText("raw activity only");
  await page.locator("#app-dialog-cancel").click();
  await expect(dialog).not.toBeVisible();
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  expect(current.document.seenDayNoteAt).toBe("1970-01-01T00:00:00.000Z");
});
