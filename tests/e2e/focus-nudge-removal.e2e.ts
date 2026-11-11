import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });

for (const empty of [false, true]) test(`legacy nudges stay stored but never render ${empty ? "without" : "with"} cards`, async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("wolfpack-sidebar-pinned", "1");
    localStorage.setItem("wolfpack-focus-mobile-expanded-v1", "1");
  });
  if (empty) {
    await page.route("**/api/sessions", async route => {
      const response = await route.fetch(); const body = await response.json();
      for (const session of body.sessions) session.runtimeState = { ...session.runtimeState, state: "working", unseen: false };
      await route.fulfill({ response, json: body });
    });
    await page.route(url => url.pathname === "/api/focus" && url.search === "", async route => {
      const response = await route.fetch(); const body = await response.json();
      body.document.intentions = [];
      delete body.document.next;
      await route.fulfill({ response, json: body });
    });
  }
  let legacy = "Legacy assistant paragraph that must never appear in focus.";
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  const response = await page.request.post(`${server.baseUrl}/api/focus`, { data: {
    expectedRevision: current.revision, ops: [{ type: "nudge", text: legacy, author: "assistant" }],
  } });
  expect(response.ok()).toBe(true);
  expect((await response.json()).document.nudge.text).toBe(legacy);
  await page.goto(server.baseUrl);
  const dashboard = page.locator("#dashboard-focus");
  await expect(dashboard).toBeVisible();
  await expect(dashboard.locator(".focus-nudge")).toHaveCount(0);
  await expect(dashboard).not.toContainText(legacy);
  await dashboard.getByRole("button", { name: "Open assistant page", exact: true }).click();
  const view = page.locator("#assistant-content");
  const tile = page.locator("#sidebar-assistant");
  // A running old assistant can keep writing nudges after the page is already open.
  legacy = "A newer legacy paragraph must not reappear after a live refresh.";
  const latest = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  const changed = await page.request.post(`${server.baseUrl}/api/focus`, { data: {
    expectedRevision: latest.revision, ops: [{ type: "nudge", text: legacy, author: "assistant" }],
  } });
  expect(changed.ok()).toBe(true);
  const saved = await changed.json();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-focus-cache")!).revision)).toBe(saved.revision);
  await expect(dashboard.locator(".focus-nudge")).toHaveCount(0);
  await expect(dashboard).not.toContainText(legacy);
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await expect(view.locator(".focus-header")).toBeVisible();
    await expect(view.locator(".focus-nudge")).toHaveCount(0);
    await expect(view).not.toContainText(legacy);
    await expect(tile).not.toContainText(legacy);
    await expect(tile).not.toHaveAttribute("title", new RegExp(legacy));
    if (empty) await expect(tile.locator(".assistant-tile-next")).toHaveText("nothing queued");
    else await expect(view.locator(".focus-next > li").first()).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-focus-cache")!).document.nudge.text)).toBe(legacy);
  }
});
