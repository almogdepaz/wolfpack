import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });

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
  await page.route("https://**", route => route.abort());
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [] } }));
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
  const shortBox = (await header.boundingBox())!;
  await page.screenshot({ path: info.outputPath("header-short.png") });
  long = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(header).toContainText("reading activity · not confirmed yet");
  const longBox = (await header.boundingBox())!;
  const actionBox = (await actions.boundingBox())!;
  expect(actionBox.y).toBeCloseTo(longBox.y, 0);
  expect(longBox.height).toBeCloseTo(shortBox.height, 0);
  await expect(header.locator(":scope > span").first()).toHaveAttribute("title", "reading activity · not confirmed yet");
  await page.screenshot({ path: info.outputPath("header-long.png") });
  offline = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(header).toContainText("offline · read-only");
  expect((await header.boundingBox())!.height).toBeCloseTo(shortBox.height, 0);
  expect((await actions.boundingBox())!.y).toBeCloseTo(shortBox.y, 0);
  await expect(header.locator(":scope > span").first()).toHaveAttribute("title", /focus from .*offline · read-only/);
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
