import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(() => server?.close());

test("terminal chrome and accessory contain only the requested controls", async ({ page }) => {
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Open test-project", exact: true }).first().click();
  await expect(page.locator("#terminal-chrome")).toHaveCount(1);
  await expect(page.locator("#terminal-chrome").getByRole("button", { name: "Inspect", exact: true, includeHidden: true })).toHaveCount(0);
  await expect(page.locator("#terminal-stop")).toHaveCount(1);
  expect(await page.locator("#kb-accessory > *").evaluateAll(nodes => nodes.map(node =>
    node.getAttribute("data-key") || (node.matches("details") ? "ctrl" : node.id),
  ))).toEqual(["Enter", "Escape", "ctrl", "BTab", "C-c", "Up", "Down", "Left", "Right", "kb-open-btn"]);
  await expect(page.locator("#kb-accessory .kb-control summary")).toHaveText("ctrl");
  expect(await page.locator("#kb-accessory .kb-control-menu [data-key]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-key"))))
    .toEqual(["C-a", "C-d", "C-l", "C-r", "C-z"]);
});
