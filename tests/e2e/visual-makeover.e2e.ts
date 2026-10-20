import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(() => server?.close());
test.beforeEach(async ({ page }) => {
  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open another-project", exact: true })).toBeVisible();
  // An unfocused desktop now opens this full menu directly.
  await expect(page.locator("#session-list .card").first()).toBeVisible();
});

test("session chrome keeps the original logo and readable, untransformed names", async ({ page }) => {
  const logo = page.locator(".wolfpack-icon:visible").first();
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute("src", "/wolfpack-icon.svg");
  await expect(logo).toHaveJSProperty("naturalWidth", 256);

  const name = page.locator("#session-list .card-name").first();
  await expect(name).toHaveCSS("text-transform", "none");
  await expect(name).toHaveCSS("text-shadow", "none");
  await expect(name).toHaveCSS("font-family", /system-ui/);
  const viewport = page.viewportSize()!;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
});

test("existing command dialog is centered, bounded, and remains keyboard cancellable", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true }).first().click();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.locator("#add-quick-cmd-btn").click();
  const dialog = page.getByRole("dialog", { name: "Add quick command", exact: true });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2);
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(box.y).toBeGreaterThanOrEqual(16);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 16);
  await expect(dialog.getByRole("textbox", { name: "Label", exact: true })).toBeFocused();
  if (testInfo.project.name !== "desktop") {
    await expect(dialog.getByRole("textbox", { name: "Label", exact: true })).toHaveCSS("font-size", "16px");
  }
  await dialog.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#add-quick-cmd-btn")).toBeFocused();
});

test("machine names stay quiet and the labelled session action keeps its existing flow", async ({ page }, testInfo) => {
  const name = page.locator("#session-list .machine-header-name").first();
  await expect(name).toHaveCSS("font-size", "11px");
  await expect(name).toHaveCSS("color", "rgb(127, 144, 135)");
  await expect(name).toHaveCSS("text-transform", "uppercase");
  // Re-resolve the name across session-list refreshes, like the other CSS assertions above.
  await expect(name).toHaveCSS("font-family", /system-ui/);
  const add = page.locator("#session-list .machine-add-btn").first();
  await expect(add).toHaveText("New session");
  await expect(add.locator("svg")).toHaveAttribute("aria-hidden", "true");
  const buttonBox = (await add.boundingBox())!;
  expect(buttonBox.width).toBeGreaterThan(buttonBox.height);
  if (testInfo.project.name !== "desktop") {
    expect(buttonBox.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator(".session-heading h1")).toHaveText("Sessions");
  }
  await add.click();
  await expect(page.locator("#projects-view")).toHaveClass(/visible/);
  if (testInfo.project.name !== "desktop") {
    // Branding belongs in the main banner, not between picker/terminal controls.
    await expect(page.locator("header .wolfpack-icon")).toBeHidden();
  }
});

test("long machine names stay bounded without squeezing the session action", async ({ page }, testInfo) => {
  const machineName = "studio-macbook-pro-with-a-very-long-machine-name";
  await page.route(`${server.baseUrl}/api/info`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), name: machineName } });
  });
  await page.reload();
  const name = page.locator("#session-list .machine-header-name").first();
  await expect(name).toHaveText(machineName);
  await expect(name).toHaveAttribute("title", machineName);
  await expect(name).toHaveCSS("text-overflow", "ellipsis");
  const add = page.getByRole("button", { name: `Start a session on ${machineName}`, exact: true });
  await expect(add).toBeVisible();
  // Measure both controls in the same frame while the expanded view settles.
  await expect.poll(() => name.evaluate(element => {
    const nameBox = element.getBoundingClientRect();
    const addBox = element.closest(".machine-header")!.querySelector(".machine-add-btn")!.getBoundingClientRect();
    return nameBox.right <= addBox.left && addBox.right <= innerWidth
      && document.documentElement.scrollWidth === innerWidth;
  })).toBe(true);
});

test("triage segments are keyboard-operable and toggle back to All", async ({ page }, testInfo) => {
  const filter = page.locator("#session-dashboard-controls").getByRole("group", { name: "Session view" });
  const work = filter.getByRole("button", { name: "Working sessions", exact: true });
  const idle = filter.getByRole("button", { name: "Idle sessions", exact: true });
  await expect(filter.getByRole("button")).toHaveCount(4);
  await expect(idle).toHaveAttribute("aria-pressed", "false");
  await expect(idle).toHaveAccessibleDescription(/\d+ sessions/);
  await expect(filter).toHaveCSS("padding", "3px");
  await expect(idle).toHaveCSS("border-radius", "7px");
  for (const button of [work, idle]) {
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(testInfo.project.name === "desktop" ? 28 : 44);
  }
  await work.focus();
  await page.keyboard.press("Tab");
  await expect(idle).toBeFocused();
  await expect(idle).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  await expect(idle).toHaveAttribute("aria-pressed", "true");
  await idle.click();
  await expect(idle).toHaveAttribute("aria-pressed", "false");

  if (testInfo.project.name === "desktop") {
    await page.getByRole("button", { name: "Collapse sessions", exact: true }).click();
    const sidebar = page.locator("#sidebar-session-controls").getByRole("group", { name: "Session view" });
    await expect(sidebar).toBeVisible();
    const bounds = (await sidebar.boundingBox())!;
    expect(bounds.width).toBeLessThanOrEqual(256);
    expect(bounds.height).toBeLessThanOrEqual(80);
    for (const button of await sidebar.getByRole("button").all()) {
      expect(await button.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await sidebar.getByRole("button", { name: "Idle sessions", exact: true }).click();
    await expect(sidebar.getByRole("button", { name: "Idle sessions", exact: true })).toHaveAttribute("aria-pressed", "true");
  }
});

test("visual transitions still respect reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("#session-list .card").first()).toHaveCSS("transition-duration", "0s");
  await expect(page.locator("#session-list .card").first()).toHaveCSS("animation-name", "none");
  await expect(page.locator("#session-dashboard-controls .session-card-view-button").first()).toHaveCSS("transition-duration", "0s");
});
