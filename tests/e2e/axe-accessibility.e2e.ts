import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(() => server?.close());
test.beforeEach(async ({ page }) => {
  await page.goto(server.baseUrl);
  await expect(page.locator("#sessions-view")).toBeVisible();
});

async function expectNoSeriousViolations(page: import("@playwright/test").Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .exclude("canvas")
    .analyze();
  expect(result.violations.filter((violation) => ["serious", "critical"].includes(violation.impact || ""))).toEqual([]);
}

test("axe scans the active sessions view", async ({ page }) => {
  await expectNoSeriousViolations(page);
});

test("axe scans settings and its active modal dialog", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).first().click();
  await expect(page.locator("#settings-view")).toBeVisible();
  await expectNoSeriousViolations(page);
  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("button", { name: "Add Command" }).click();
  await expect(page.getByRole("dialog", { name: "Add quick command" })).toBeVisible();
  await expectNoSeriousViolations(page);
});
