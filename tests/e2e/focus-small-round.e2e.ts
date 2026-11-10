import { test, expect, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
async function openAssistant(page: Page) {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
}

test("QA-34: hover sidebar overlays without shrinking the hydrated pane", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop hover/pane");
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "0"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAssistant(page);
  const pane = page.locator("#assistant-pty");
  await expect(pane).toHaveClass(/hydrated/);
  await expect.poll(() => pane.evaluate(el => el.querySelector("canvas")!.getBoundingClientRect().width <= el.clientWidth)).toBe(true);
  const before = (await pane.boundingBox())!.width;
  await page.mouse.move(2, 450);
  await expect(page.locator("#desktop-sidebar")).not.toHaveClass(/collapsed/);
  await page.locator("#desktop-sidebar").evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
  await expect.poll(() => pane.evaluate(el => el.querySelector("canvas")!.getBoundingClientRect().width <= el.clientWidth)).toBe(true);
  expect((await pane.boundingBox())!.width).toBeCloseTo(before, 0);
  await page.screenshot({ path: info.outputPath("qa34-hover-1440.png"), animations: "disabled" });
});
