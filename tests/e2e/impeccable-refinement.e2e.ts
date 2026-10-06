import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { collapseInitialSessionMenu, openProjectPickerFromUi, startTestServer } from "./helpers.ts";
import type { TestServer } from "./helpers.ts";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.route("**/api/projects", route => route.fulfill({ json: { projects: ["catalog-project"] } }));
  await page.route("**/api/next-session-name**", route => route.fulfill({ json: { name: "catalog-project" } }));
  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open another-project", exact: true })).toBeVisible();
});

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("#settings-view")).not.toHaveAttribute("inert", "");
}

async function openAgentPicker(page: Page): Promise<void> {
  await openProjectPickerFromUi(page);
  await page.getByRole("button", { name: "Open project catalog-project", exact: true }).click();
  await expect(page.locator("#agent-list .card").first()).toBeVisible();
}

// WCAG relative luminance, applied to the browser's actual opaque text/surface colors.
async function contrast(text: Locator, surface: Locator, pseudo?: string): Promise<number> {
  const foreground = await text.evaluate((element, selector) => getComputedStyle(element, selector).color, pseudo);
  const background = await surface.evaluate(element => getComputedStyle(element).backgroundColor);
  const luminance = (color: string): number => {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`unsupported color: ${color}`);
    const [red, green, blue] = channels.map(channel => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

async function expectReadable(locator: Locator, minimum = 12): Promise<void> {
  expect.soft(await locator.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(minimum);
  await expect.soft(locator).toHaveCSS("text-transform", "none");
}

async function expectNoOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => innerWidth));
}

test("sidebar machine identity and creation action share a compact row with readable previews", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop sidebar contract");
  await collapseInitialSessionMenu(page);
  const header = page.locator("#sidebar-session-list .machine-header").first();
  const name = header.locator(".machine-name-handle");
  const add = header.locator(".machine-add-btn");
  const nameBox = (await name.boundingBox())!;
  const addBox = (await add.boundingBox())!;
  expect.soft(Math.abs(nameBox.y + nameBox.height / 2 - addBox.y - addBox.height / 2)).toBeLessThanOrEqual(2);
  await expectReadable(page.locator("#sidebar-session-list .card-preview").first(), 11);
  await expectNoOverflow(page);
});

test("picker layers are opaque even during transitions and desktop back controls remain available", async ({ page }, testInfo) => {
  const surfaceColor = await page.locator("body").evaluate(element => getComputedStyle(element).backgroundColor);
  await openProjectPickerFromUi(page);
  await expect.soft(page.locator("#projects-view")).toHaveCSS("background-color", surfaceColor);
  if (testInfo.project.name === "desktop") {
    await expect.soft(page.locator("#projects-view .picker-cancel-btn")).toBeVisible();
  }
  await page.getByRole("button", { name: "Open project catalog-project", exact: true }).click();
  await expect.soft(page.locator("#agent-view")).toHaveCSS("background-color", surfaceColor);
  if (testInfo.project.name === "desktop") {
    const back = page.locator("#agent-view .picker-cancel-btn");
    await expect.soft(back).toBeVisible();
    if (await back.isVisible()) await back.press("Enter");
    else return;
    await expect(page.locator("#projects-view")).not.toHaveAttribute("inert", "");
  }
});

test("session name hints and validation remain readable and recover after correction", async ({ page }) => {
  await openAgentPicker(page);
  const input = page.getByLabel("session name", { exact: true });
  expect.soft(await contrast(input, input, "::placeholder")).toBeGreaterThanOrEqual(4.5);
  await input.fill("invalid name");
  const error = page.locator("#session-name-error");
  await expect(error).toBeVisible();
  await expectReadable(error);
  await expect.soft(error).toHaveCSS("letter-spacing", "normal");
  await input.fill("valid-name");
  await expect(error).toBeHidden();
  await expect(input).toBeFocused();
  await expectNoOverflow(page);
});

test("long agent commands wrap inside their real creation controls", async ({ page }) => {
  const command = `custom-agent --context=${"project".repeat(30)}`;
  await page.route("**/api/settings", route => route.fulfill({ json: { effective: { cmds: [command], agentCmd: command } } }));
  await openAgentPicker(page);
  const button = page.getByRole("button", { name: `Start ${command}`, exact: true });
  const name = button.locator(".card-name");
  expect(await name.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await button.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expectNoOverflow(page);
});

test("settings feedback is readable and native choices fit on narrow screens", async ({ page }, testInfo) => {
  await openSettings(page);
  await page.getByRole("link", { name: "Effects", exact: true }).click();
  await expectReadable(page.locator(".quiet-alert-setting-help"));
  await expectReadable(page.locator("#notification-setting-status"));
  if (testInfo.project.name !== "desktop") {
    const select = page.locator("#setting-quiet-alert-mode");
    await expect.soft(select).toHaveCSS("font-size", "16px");
    expect.soft((await select.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const label = select.locator("..");
    expect(await label.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    const policy = page.locator("#task-worker-extension-policy");
    await policy.scrollIntoViewIfNeeded();
    expect.soft((await policy.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect.soft(policy).toHaveCSS("font-size", "16px");
    const addInput = page.locator("#agent-add-input");
    expect(await addInput.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
  }
  await expectNoOverflow(page);
});

test("native task-worker choice remains readable beside the pinned sidebar at intermediate widths", async ({ page }, testInfo) => {
  const widths = testInfo.project.name === "desktop" ? [769, 820] : [375];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 720 });
    await openSettings(page);
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    const policy = page.locator("#task-worker-extension-policy");
    await policy.selectOption("isolated");
    await policy.scrollIntoViewIfNeeded();
    await expect(policy).toHaveValue("isolated");
    const measured = await policy.evaluate(element => {
      const control = element as HTMLSelectElement;
      const selected = control.selectedOptions.item(0);
      const context = document.createElement("canvas").getContext("2d");
      if (!selected || !context) throw new Error("selected text measurement unavailable");
      const style = getComputedStyle(control);
      context.font = style.font;
      // Reserve space for Chromium's native select arrow as well as CSS padding.
      const nativeArrowAllowance = 20;
      return {
        textWidth: context.measureText(selected.text).width,
        availableWidth: control.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - nativeArrowAllowance,
      };
    });
    expect.soft(measured.availableWidth, `selected policy must fit at ${width}px`).toBeGreaterThanOrEqual(measured.textWidth);
    await expectNoOverflow(page);
    if (testInfo.project.name === "desktop") await expect(page.locator("#desktop-sidebar")).toBeVisible();
    await page.goto(server.baseUrl);
  }
});

test("debug labels and reset have readable contrast rather than disabled-looking text", async ({ page }, testInfo) => {
  await openSettings(page);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.locator("#setting-debugPanel").check();
  const panel = page.locator("#debug-panel");
  await panel.scrollIntoViewIfNeeded();
  expect.soft(await contrast(panel.locator(".debug-grid > span").first(), panel)).toBeGreaterThanOrEqual(4.5);
  const reset = panel.getByRole("button", { name: "Reset", exact: true });
  expect.soft(await contrast(reset, reset)).toBeGreaterThanOrEqual(4.5);
  if (testInfo.project.name !== "desktop") expect((await reset.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test("project errors keep sentence typography and a recoverable picker", async ({ page }) => {
  await page.route("**/api/projects", route => route.fulfill({ status: 500, json: { error: "unavailable" } }));
  await openProjectPickerFromUi(page);
  const error = page.locator("#project-list .empty");
  await expect(error).toHaveText("Failed to load projects");
  await expectReadable(error, 13);
  await expect(page.locator("#open-folder-action")).toBeEnabled();
  await expectNoOverflow(page);
});

test("slow terminal chrome presents readable loading labels without changing hydration", async ({ page }) => {
  let releaseMessages: (() => void) | undefined;
  const released = new Promise<void>(resolve => { releaseMessages = resolve; });
  await page.routeWebSocket(/\/ws\/pty/, socket => {
    const upstream = socket.connectToServer();
    socket.onMessage(message => upstream.send(message));
    upstream.onMessage(async message => { await released; socket.send(message); });
  });
  await page.getByRole("button", { name: "Open test-project", exact: true }).click();
  const terminal = page.locator("#desktop-terminal-container");
  try {
    await expect(terminal).toHaveClass(/hydrating/);
    const style = await terminal.evaluate(element => {
      const computed = getComputedStyle(element, "::before");
      return { font: parseFloat(computed.fontSize), color: computed.color, transform: computed.textTransform };
    });
    expect.soft(style.font).toBeGreaterThanOrEqual(12);
    expect.soft(style.transform).toBe("none");
    expect.soft(style.color).not.toMatch(/rgba/);
  } finally { releaseMessages?.(); }
  await expect(terminal.locator("canvas")).toBeVisible();
});

test("long quick command labels keep edit and delete actions inside the settings row", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.locator("#add-quick-cmd-btn").click();
  const dialog = page.getByRole("dialog", { name: "Add quick command", exact: true });
  const label = "deployment".repeat(20);
  await dialog.getByLabel("Label", { exact: true }).fill(label);
  await dialog.getByLabel("Command", { exact: true }).fill(`bun run ${"project".repeat(30)}`);
  await dialog.getByRole("button", { name: "Add command", exact: true }).click();
  const row = page.locator(".qc-item").filter({ hasText: label });
  await row.scrollIntoViewIfNeeded();
  expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (const actionClass of ["edit", "delete"]) {
    const action = row.locator(`.qc-btn.${actionClass}`);
    expect(await action.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await expect(action).toBeInViewport();
  }
  await expectNoOverflow(page);
});

test("refined creation retains accessible real controls", async ({ page }) => {
  await openAgentPicker(page);
  await page.locator("#session-name-input").fill("invalid name");
  const result = await new AxeBuilder({ page }).include("#agent-view").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(result.violations.filter(violation => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
});
