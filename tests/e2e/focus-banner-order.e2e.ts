import { test, expect, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });

async function sidebarOrder(page: Page) {
  const tile = page.locator("#sidebar-assistant");
  await expect(tile).toBeVisible();
  await expect(page.locator("#sidebar-session-filter")).toBeVisible();
  const boxes = await page.evaluate(() => {
    const rect = (s: string) => { const r = document.querySelector(s)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width }; };
    return { header: rect(".sidebar-header"), tile: rect("#sidebar-assistant"), search: rect(".sidebar-search"), filter: rect("#sidebar-session-filter") };
  });
  expect(boxes.tile.top).toBeGreaterThanOrEqual(boxes.header.bottom);
  expect(boxes.search.top).toBeGreaterThanOrEqual(boxes.tile.bottom);
  expect(boxes.filter.top).toBeGreaterThanOrEqual(boxes.search.bottom);
  expect(boxes.tile.width).toBeCloseTo(boxes.filter.width, 0);
  await tile.focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#sidebar-search")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#sidebar-session-filter button").first()).toBeFocused();
  await expect(tile.locator("button, input, canvas")).toHaveCount(0); // navigation only
}

for (const width of [1440, 1280, 1279, 390]) test(`assistant banner leads session controls at ${width}`, async ({ page }, info) => {
  test.skip((width === 390) !== (info.project.name !== "desktop"), "viewport belongs to the matching project");
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.goto(server.baseUrl);
  await expect(page.locator("#dashboard-focus")).toBeVisible();
  // Visual and native tab order share the same DOM order, with no CSS order override.
  expect.soft(await page.evaluate(() => document.querySelector(".sidebar-header")!.nextElementSibling?.id)).toBe("sidebar-assistant");
  expect.soft(await page.locator("#dashboard-focus").evaluate(el => el.nextElementSibling?.id)).toBe("session-dashboard-controls");
  expect.soft(await page.locator("#dashboard-focus").evaluate(el => el.previousElementSibling?.id)).toBe("expanded-toolbar");
  const block = (await page.locator("#dashboard-focus").boundingBox())!;
  const controls = (await page.locator("#session-dashboard-controls").boundingBox())!;
  expect(controls.y).toBeGreaterThanOrEqual(block.y + block.height);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  // Backwards from the first banner button reaches the header, not session status/filter/search.
  expect(await page.evaluate(() => !!document.activeElement?.closest("#session-dashboard-controls"))).toBe(false);
  await page.screenshot({ path: info.outputPath(`banner-${width}-main.png`), fullPage: true });
  if (width !== 390) {
    await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
    await sidebarOrder(page);
    await page.screenshot({ path: info.outputPath(`banner-${width}-pinned.png`), fullPage: true });
    await page.locator("#sidebar-expand-btn").click();
    await expect(page.locator("body")).toHaveClass(/sessions-expanded/);
    await page.screenshot({ path: info.outputPath(`banner-${width}-expanded-main.png`), fullPage: true });
    await page.locator("#expanded-collapse-btn").click();
    await expect(page.locator("body")).not.toHaveClass(/sessions-expanded/);
    await page.locator("#sidebar-collapse-btn").click();
    await expect(page.locator("#desktop-sidebar")).toHaveClass(/collapsed/);
    await expect(page.locator("#desktop-sidebar")).toHaveAttribute("inert", "");
    await page.screenshot({ path: info.outputPath(`banner-${width}-collapsed.png`), fullPage: true });
    await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
    // The edge disappears as soon as it opens the sidebar; move the pointer
    // rather than asking locator.hover() to keep that transient target actionable.
    await page.mouse.move(width - 10, 500);
    await page.mouse.move(1, 500);
    await expect(page.locator("#desktop-sidebar")).not.toHaveClass(/collapsed/);
    await sidebarOrder(page);
    await page.screenshot({ path: info.outputPath(`banner-${width}-hover-expanded.png`), fullPage: true });
    await page.locator("#sidebar-assistant").click();
    await expect(page.locator("#assistant-view")).toBeVisible();
  } else await expect(page.locator("#desktop-sidebar")).toBeHidden();
});

test("assistant off leaves no banner gap in the dashboard or sidebar", async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch(); const body = await response.json();
    body.assistant.enabled = false;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await expect(page.locator("#dashboard-focus")).toBeHidden();
  await expect(page.locator("#sidebar-assistant")).toBeHidden();
  expect(await page.locator("#dashboard-focus").innerHTML()).toBe("");
  await expect(page.locator("#session-dashboard-controls")).toBeVisible();
  expect(await page.locator("#dashboard-focus").evaluate(el => el.getClientRects().length)).toBe(0);
  await page.screenshot({ path: info.outputPath(`banner-off-${info.project.name}.png`), fullPage: true });
  if (info.project.name === "desktop") {
    await page.getByRole("button", { name: "Open test-project", exact: true }).click();
    await expect(page.locator("#desktop-sidebar")).not.toHaveClass(/collapsed/);
    const gap = await page.evaluate(() => document.querySelector(".sidebar-search")!.getBoundingClientRect().top - document.querySelector(".sidebar-header")!.getBoundingClientRect().bottom);
    expect(gap).toBe(0);
    await page.screenshot({ path: info.outputPath("banner-off-sidebar.png"), fullPage: true });
  }
});
