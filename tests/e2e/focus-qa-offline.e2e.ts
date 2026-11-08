import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });

test("QA-14: self-offline keeps last known next rows, disabled, then recovers", async ({ page, context }) => {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-next")).toContainText("prompt-project needs you");
  const summaries = await view.locator(".focus-next .focus-card > summary").allTextContents();
  await context.setOffline(true);
  await expect(view).toContainText("offline · read-only", { timeout: 15_000 });
  expect(await view.locator(".focus-next .focus-card > summary").allTextContents()).toEqual(summaries);
  for (const action of await view.locator(".focus-next button, .focus-chips button, .focus-done button").all()) await expect(action).toBeDisabled();
  await expect(view.getByRole("button", { name: "Talk to assistant" })).toBeDisabled();
  await context.setOffline(false);
  await expect(view).not.toContainText("offline · read-only", { timeout: 15_000 });
  await expect(view.locator(".focus-next button").first()).toBeEnabled();
});
