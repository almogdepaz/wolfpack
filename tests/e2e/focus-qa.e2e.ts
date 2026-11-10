import { test, expect, type Locator } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
async function measuredBox(locator: Locator) {
  let box: Awaited<ReturnType<Locator["boundingBox"]>> = null;
  await expect.poll(async () => {
    box = await locator.boundingBox();
    return box?.height ?? 0;
  }).toBeGreaterThan(0);
  return box!;
}

test("QA-4: an empty focus document has no today count or empty rule disclosure", async ({ page }) => {
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions = [];
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block).toBeVisible();
  await expect.soft(block).not.toContainText("0 of 0 done");
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect.soft(view).not.toContainText("0 of 0 done");
  await expect.soft(view.getByText("why this order", { exact: true })).toHaveCount(0);
  await expect(view.getByRole("textbox", { name: "Add an intention" })).toBeVisible();
});

test("QA-19: phone header keeps actions on the first row across long status changes", async ({ page }, info) => {
  test.skip(info.project.name === "desktop", "phone geometry");
  let long = false;
  let offline = false;
  let sessionsDown = false;
  await page.route("https://**", route => route.abort());
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [] } }));
  await page.route(`${server.baseUrl}/api/sessions`, route => sessionsDown ? route.fulfill({ status: 503, json: { error: "sessions unavailable" } }) : route.continue());
  await page.route(url => url.pathname === "/api/focus", async route => {
    if (offline) return route.abort();
    const response = await route.fetch();
    const body = await response.json();
    body.routines.catchingUp = long ? { machines: 1, since: null, unconfirmed: true } : null;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const header = page.locator("#assistant-content .focus-header");
  const actions = header.locator(".focus-header-actions");
  await expect(header).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const shortBox = await measuredBox(header);
  await page.screenshot({ path: info.outputPath("header-short.png") });
  long = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(header).toContainText("reading activity · not confirmed yet");
  const longBox = await measuredBox(header);
  const actionBox = await measuredBox(actions);
  expect(actionBox.y).toBeCloseTo(longBox.y, 0);
  expect(longBox.height).toBeCloseTo(shortBox.height, 0);
  await expect(header.locator(":scope > span").first()).toHaveAttribute("title", "reading activity · not confirmed yet");
  await page.screenshot({ path: info.outputPath("header-long.png") });
  sessionsDown = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const note = header.getByText("sessions unavailable", { exact: true });
  await expect(note).toHaveText("sessions unavailable");
  await page.screenshot({ path: info.outputPath("header-session-notice.png") });
  const statusBox = await measuredBox(header.locator(":scope > span").first());
  expect(statusBox.width).toBeGreaterThan(44); // The status dot/text must not collapse behind the notice.
  const noticeHeader = await measuredBox(header);
  const noticeActions = await measuredBox(actions);
  expect(noticeActions.y).toBeCloseTo(shortBox.y, 0);
  expect((await measuredBox(note)).y).toBeGreaterThanOrEqual(noticeActions.y + noticeActions.height);
  expect(await note.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  long = false;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(header).not.toContainText("reading activity");
  expect((await measuredBox(header)).height).toBeCloseTo(noticeHeader.height, 0);
  expect((await measuredBox(actions)).y).toBeCloseTo(shortBox.y, 0);
  sessionsDown = false;
  offline = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(header).toContainText("offline · read-only");
  expect((await measuredBox(header)).height).toBeCloseTo(shortBox.height, 0);
  expect((await measuredBox(actions)).y).toBeCloseTo(shortBox.y, 0);
  await expect(header.locator(":scope > span").first()).toHaveAttribute("title", /focus from .*offline · read-only/);
});

test("QA-21: phone done target is 44 square without enlarging the box or covering the summary", async ({ page }, info) => {
  test.skip(info.project.name === "desktop", "phone touch target");
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  const row = view.locator(".focus-today > li").first();
  const label = row.locator(".focus-check");
  const target = (await label.boundingBox())!;
  const box = (await label.locator("input").boundingBox())!;
  const summary = (await row.locator("summary").boundingBox())!;
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBe(18);
  expect(box.height).toBe(18);
  expect(summary.x).toBeGreaterThanOrEqual(target.x + target.width);
  const title = (await row.locator(".focus-title").textContent())!;
  await page.screenshot({ path: info.outputPath("done-target.png") });
  // Tap padding, not the visible 18px box: ticks done rather than opening details.
  await label.click({ position: { x: target.width - 2, y: target.height / 2 } });
  await expect(view.locator(".focus-done")).toContainText(title);
});

test("QA-10: a write announces focus updated then the notice expires, including after another render", async ({ page }) => {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Add an intention" });
  await input.fill("transient notice intention");
  await input.press("Enter");
  const status = page.locator("#focus-status");
  await expect(status).toHaveText("focus updated");
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toBeEmpty({ timeout: 8_000 });
  await page.locator("#assistant-back").evaluate((el: HTMLButtonElement) => el.click());
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await expect(status).toBeEmpty();
});
