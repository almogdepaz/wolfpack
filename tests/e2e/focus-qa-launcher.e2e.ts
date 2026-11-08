import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });

test("QA-13: the sidebar name separates status and next without repeating next", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop sidebar");
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await page.getByRole("button", { name: "Talk to assistant" }).click();
  const tile = page.locator("#sidebar-assistant");
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAccessibleName(/^assistant, (?:\d+ next:|reading next:) prompt-project needs you$/);
  expect((await new AxeBuilder({ page }).include("#sidebar-assistant").analyze()).violations).toEqual([]);
});

test("QA-5: the sidebar assistant remains reachable with no other sessions", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop sidebar");
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.sessions = body.sessions.filter((s: { name: string }) => s.name === "assistant");
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  await page.getByRole("button", { name: "Talk to assistant" }).click();
  await expect(page.locator("#assistant-terminal-header")).toBeVisible();
  await expect(page.locator("#sidebar-session-list .card")).toHaveCount(0);
  await page.locator("#sidebar-assistant").click();
  await expect(page.locator("#assistant-view")).toBeVisible();
});

