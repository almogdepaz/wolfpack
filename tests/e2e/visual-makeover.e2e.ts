import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(() => server?.close());
test.beforeEach(async ({ page }, testInfo) => {
  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open another-project", exact: true })).toBeVisible();
  // Main's pinned sidebar owns the desktop chooser until explicitly expanded.
  if (testInfo.project.name === "desktop") {
    await page.getByRole("button", { name: "Expand sessions", exact: true }).click();
  }
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
  expect(await name.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("ui-monospace");
  const viewport = page.viewportSize()!;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
});

test("existing command dialog is centered, bounded, and remains keyboard cancellable", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
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
  await expect(name).toHaveCSS("color", "rgb(143, 159, 149)");
  await expect(name).toHaveCSS("text-transform", "uppercase");
  expect(await name.evaluate(element => getComputedStyle(element).fontFamily)).toContain("ui-monospace");
  const add = page.locator("#session-list .machine-add-btn").first();
  await expect(add).toHaveText("New session");
  await expect(add.locator("svg")).toHaveAttribute("aria-hidden", "true");
  const buttonBox = (await add.boundingBox())!;
  expect(buttonBox.width).toBeGreaterThan(buttonBox.height);
  if (testInfo.project.name !== "desktop") {
    expect(buttonBox.height).toBeGreaterThanOrEqual(44);
    const logo = page.locator("header .wolfpack-icon");
    await expect(logo).toBeVisible();
    await expect(logo).toHaveCSS("width", "24px");
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
  await page.route("**/api/info", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), name: machineName } });
  });
  await page.reload();
  if (testInfo.project.name === "desktop") {
    await page.getByRole("button", { name: "Expand sessions", exact: true }).click();
  }
  const name = page.locator("#session-list .machine-header-name").first();
  await expect(name).toHaveText(machineName);
  await expect(name).toHaveAttribute("title", machineName);
  await expect(name).toHaveCSS("text-overflow", "ellipsis");
  const add = page.getByRole("button", { name: `Start a session on ${machineName}`, exact: true });
  await expect(add).toBeVisible();
  const nameBox = (await name.boundingBox())!;
  const addBox = (await add.boundingBox())!;
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(addBox.x);
  expect(addBox.x + addBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width);
});

test("visual transitions still respect reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("#session-list .card").first()).toHaveCSS("transition-duration", "0s");
  await expect(page.locator("#session-list .card").first()).toHaveCSS("animation-name", "none");
});
