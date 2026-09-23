import { selectTerminalLayoutFromUi } from "./helpers.ts";
import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { start, skipIfNoBroker, type BrokerTestServer } from "./broker-helpers.ts";
import { openSessionFromUi } from "./helpers.ts";
import {
  createOwnedTestServerHome,
  removeOwnedTestServerHome,
  type OwnedTestServerHome,
} from "./test-server-home.ts";

test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);

const PROJECT_NAME = "wp-workspace-layout";
const DESKTOP_SESSIONS = ["workspace-one", "workspace-two", "workspace-three", "workspace-four", "workspace-five"];
let server: BrokerTestServer | null = null;
let devDir: string | null = null;
let home: OwnedTestServerHome | null = null;

async function createShellSession(name: string): Promise<void> {
  const response = await fetch(`${server!.baseUrl}/api/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: PROJECT_NAME, cmd: "shell", sessionName: name }),
  });
  expect(response.ok, `create ${name}`).toBeTruthy();
}

async function createChildSession(parentSession: string, sessionName: string): Promise<void> {
  const response = await fetch(`${server!.baseUrl}/api/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: PROJECT_NAME, cmd: "shell", parentSession, sessionName }),
  });
  expect(response.ok, `open child ${sessionName}`).toBeTruthy();
}

async function openGrid(page: Page, names: readonly string[]): Promise<void> {
  await page.goto(server!.baseUrl);
  await page.locator(".card", { hasText: names[0]! }).first().click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#sidebar-settings-btn")).toBeVisible();
  for (const name of names.slice(1)) await page.locator(`[data-action="toggle-grid"][data-session="${name}"]`).filter({ visible: true }).click();
  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(names.length, { timeout: 10_000 });
  await expect(page.locator("#sidebar-settings-btn")).toBeVisible();
}

test.beforeAll(async () => {
  if (skipIfNoBroker.condition) return;
  devDir = realpathSync(mkdtempSync(join(tmpdir(), "wp-workspace-layout-")));
  mkdirSync(join(devDir, PROJECT_NAME));
  home = createOwnedTestServerHome();
  server = await start({ envOverrides: {
    HOME: home.path,
    WOLFPACK_DEV_DIR: devDir,
    WOLFPACK_MACHINE_ID_PATH: join(home.path, "machine-id"),
  } });
});

test.afterAll(async () => {
  await server?.teardown();
  server = null;
  if (devDir) rmSync(devDir, { recursive: true, force: true });
  devDir = null;
  if (home) removeOwnedTestServerHome(home);
  home = null;
});

test("real broker desktop preserves existing equal-grid cardinalities and reversible workspace identity", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop workspace geometry contract");
  await page.setViewportSize({ width: 1800, height: 900 });
  for (const name of DESKTOP_SESSIONS) await createShellSession(name);
  const socketUrls: string[] = [];
  const resizeFrames: Array<{ readonly cols?: number; readonly rows?: number }> = [];
  page.on("websocket", socket => {
    if (!socket.url().includes("/ws/pty")) return;
    socketUrls.push(socket.url());
    socket.on("framesent", event => {
      if (typeof event.payload !== "string") return;
      try {
        const frame = JSON.parse(event.payload) as { readonly type?: string; readonly cols?: number; readonly rows?: number };
        if (frame.type === "resize") resizeFrames.push(frame);
      } catch { /* non-control PTY data */ }
    });
  });
  await openGrid(page, DESKTOP_SESSIONS.slice(0, 3));
  const grid = page.locator("#desktop-grid-container");
  const third = page.locator(`#desktop-grid-container .grid-cell[data-session="${DESKTOP_SESSIONS[2]}"]`);
  const [gridBox, thirdBox] = await Promise.all([grid.boundingBox(), third.boundingBox()]);
  expect(gridBox).not.toBeNull();
  expect(thirdBox).not.toBeNull();
  expect(Math.abs(thirdBox!.width - (gridBox!.width - 8))).toBeLessThanOrEqual(2);

  for (const name of DESKTOP_SESSIONS.slice(3)) await page.locator(`[data-action="toggle-grid"][data-session="${name}"]`).filter({ visible: true }).click();
  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(5, { timeout: 10_000 });
  const fifth = page.locator(`#desktop-grid-container .grid-cell[data-session="${DESKTOP_SESSIONS[4]}"]`);
  const fifthBox = await fifth.boundingBox();
  expect(fifthBox).not.toBeNull();
  expect(fifthBox!.width).toBeGreaterThan(gridBox!.width * 0.45);

  const selected = DESKTOP_SESSIONS[4]!;
  await fifth.click();
  await expect(fifth).toHaveClass(/grid-focused/);
  await selectTerminalLayoutFromUi(page, "lead-stack");
  await expect(grid).toHaveAttribute("style", /grid-template-columns/);
  await expect.poll(async () => (await grid.locator(".grid-cell").first().boundingBox())!.height > (await fifth.boundingBox())!.height).toBe(true);
  await selectTerminalLayoutFromUi(page, "vertical-stack");
  await expect(grid).toHaveCSS("grid-template-columns", /^\d+(\.\d+)?px$/);
  await selectTerminalLayoutFromUi(page, "lead-stack");
  await expect(page.locator('#desktop-grid-container .grid-cell.hydrated')).toHaveCount(5);
  await expect(fifth).toHaveClass(/grid-focused/);
  // Settings uses its existing suspend/resume lifecycle; direct workspace controls retain these restored canvases.
  await page.locator("#desktop-grid-container .grid-cell canvas").evaluateAll((canvases) => canvases.forEach((canvas, index) => canvas.setAttribute("data-workspace-canvas", String(index))));
  const attachesBefore = socketUrls.length;
  const placements = () => grid.locator(".grid-cell").evaluateAll(cells => cells.map(cell => ({ row: (cell as HTMLElement).style.gridRow, column: (cell as HTMLElement).style.gridColumn })));
  const initialPlacements = await placements();
  const resizeCount = resizeFrames.length;
  const fourth = grid.locator(".grid-cell").nth(3);
  await fourth.click();
  await expect(fourth).toHaveClass(/grid-focused/);
  await page.setViewportSize({ width: 1750, height: 900 });
  await expect.poll(() => resizeFrames.length).toBeGreaterThan(resizeCount);
  expect(await placements()).toEqual(initialPlacements);
  await fifth.click();
  await expect(fifth).toHaveClass(/grid-focused/);
  await page.locator("#workspace-context-collapse").click();
  await expect(page.locator("#workspace-restore")).toBeVisible();
  expect(await page.locator("#desktop-grid-container .grid-cell canvas").evaluateAll((canvases) => canvases.map(canvas => canvas.getAttribute("data-workspace-canvas")))).toEqual(["0", "1", "2", "3", "4"]);
  await page.locator("#workspace-restore").click();
  await page.locator("#workspace-context-full").click();
  await expect(page.locator("#workspace-terminal-region")).toBeHidden();
  const [shellBox, contextBox] = await Promise.all([page.locator("#workspace-shell").boundingBox(), page.locator("#workspace-context-region").boundingBox()]);
  expect(shellBox).not.toBeNull();
  expect(contextBox).not.toBeNull();
  expect(Math.abs(contextBox!.width - shellBox!.width)).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await expect(fifth).toHaveClass(/grid-focused/);
  expect(socketUrls).toHaveLength(attachesBefore);
});

test("right context panel resizes with real pointer and keyboard input without replacing the terminal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop splitter contract; mobile retains the stacked recovery layout");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    if (!localStorage.getItem("splitter-test-seeded")) {
      localStorage.setItem("wolfpack-workspace-shell", JSON.stringify({ placement: "left", splitSize: 320 }));
      localStorage.setItem("splitter-test-seeded", "true");
    }
  });
  const name = "workspace-resize";
  await createShellSession(name);
  const sockets: string[] = [];
  const sizes: Array<{ cols: number; rows: number }> = [];
  page.on("websocket", socket => {
    if (!socket.url().includes("/ws/pty")) return;
    sockets.push(socket.url());
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      try { const value = JSON.parse(payload); if (value.type === "resize") sizes.push(value); } catch { /* PTY data */ }
    });
  });
  await page.goto(server!.baseUrl);
  await page.locator(".card", { hasText: name }).first().click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#sidebar-settings-btn")).toBeVisible();
  await expect(page.locator("#workspace-terminal-full")).toHaveCount(0);
  for (const [id, label] of [["workspace-context-collapse", "Hide widgets"], ["workspace-context-full", "Context full view"]]) {
    const control = page.locator(`#${id}`);
    await expect(control).toHaveAccessibleName(label!);
    await expect(control).toHaveText(id === "workspace-context-collapse" ? "Hide widgets" : "");
    await expect(control.locator("svg")).toBeVisible();
    await expect(control).toHaveAttribute("title", /.+/);
  }
  const context = page.locator("#workspace-context-region");
  const terminal = page.locator("#workspace-terminal-region");
  const before = (await context.boundingBox())!;
  const terminalBefore = (await terminal.boundingBox())!;
  expect(before.x).toBeGreaterThanOrEqual(terminalBefore.x + terminalBefore.width);
  await expect(page.locator("#workspace-context-placement, #workspace-context-size")).toHaveCount(0);
  const border = page.getByRole("separator", { name: "Resize context panel" });
  await expect(border).toBeVisible();
  await expect(border).toHaveCSS("cursor", "col-resize");
  await page.locator("#desktop-terminal-container canvas").click();
  await page.evaluate(() => {
    (window as any).__splitterRetained = { canvas: document.querySelector("#desktop-terminal-container canvas"), focus: document.activeElement };
  });
  const attaches = sockets.length;
  const edge = (await border.boundingBox())!;
  expect(edge.x + edge.width).toBeCloseTo(before.x, 0);
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 110, edge.y + edge.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#workspace-shell")).not.toHaveClass(/workspace-resizing/);
  await expect.poll(async () => Math.round((await context.boundingBox())!.width)).toBe(Math.round(before.width + 110));
  expect(await page.evaluate(() => {
    const saved = (window as any).__splitterRetained;
    return [saved.canvas === document.querySelector("#desktop-terminal-container canvas"), saved.focus === document.activeElement];
  })).toEqual([true, true]);
  expect(sockets).toHaveLength(attaches);
  await expect.poll(() => sizes.length).toBeGreaterThan(0);
  expect(sizes.every(size => size.cols > 0 && size.rows > 0)).toBe(true);
  await border.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => Math.round((await context.boundingBox())!.width)).toBe(Math.round(before.width + 120));
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => Math.round((await context.boundingBox())!.width)).toBe(Math.round(before.width + 100));
  const savedSize = await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-workspace-shell")!).splitSize);
  expect(savedSize).toBe(Math.round(before.width + 100));
  await page.keyboard.press("End");
  expect((await terminal.boundingBox())!.width).toBeGreaterThanOrEqual(240);
  await page.setViewportSize({ width: 850, height: 900 });
  await expect.poll(async () => (await terminal.boundingBox())!.width).toBeGreaterThanOrEqual(240);
  await page.setViewportSize({ width: 1440, height: 900 });
  await border.focus();
  await page.keyboard.press("Home");
  await expect.poll(async () => Math.round((await context.boundingBox())!.width)).toBe(220);
  await page.screenshot({ path: testInfo.outputPath("right-context-controls.png") });
  await page.locator("#workspace-context-full").click();
  await expect(page.locator("#workspace-context-full .restore-icon")).toBeVisible();
  await expect(border).toBeHidden();
  await page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  const collapseBox = (await page.locator("#workspace-context-collapse").boundingBox())!;
  const toolsBeforeCollapse = (await page.locator("#sidebar-session-controls").boundingBox())!;
  await page.locator("#workspace-context-collapse").click();
  const expand = page.getByRole("button", { name: "Show widgets", exact: true });
  await expect(expand).toHaveText("Show widgets");
  await expect(expand).toBeFocused();
  await expect(expand).toHaveAttribute("aria-controls", "workspace-context-region");
  await expect(expand.locator("svg rect")).toHaveAttribute("width", "18");
  await expect(border).toBeHidden();
  const expandBox = (await expand.boundingBox())!;
  const toolsBox = (await page.locator("#sidebar-session-controls").boundingBox())!;
  expect(expandBox).toEqual(collapseBox);
  expect(toolsBox).toEqual(toolsBeforeCollapse);
  await expect(expand.locator("svg")).toHaveCSS("color", "rgb(69, 237, 126)");
  expect(expandBox.y).toBeGreaterThanOrEqual(toolsBox.y);
  expect(expandBox.y + expandBox.height).toBeLessThanOrEqual(toolsBox.y + toolsBox.height);
  await expect(page.locator(".workspace-terminal-toolbar")).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("context-expand-top.png") });
  await expand.press("Enter");
  await expect(page.locator("#workspace-context-collapse")).toBeFocused();
  await expect(expand).toBeHidden();
  await expect(border).toBeVisible();
  await page.reload();
  await page.locator(".card", { hasText: name }).first().click();
  await expect.poll(async () => Math.round((await context.boundingBox())!.width)).toBe(220);
});

test("context controls stay fixed beside desktop filters and in the mobile toolbar", async ({ page }, testInfo) => {
  test.skip(!["desktop", "iphone-14"].includes(testInfo.project.name), "desktop and responsive Chromium touch contract");
  const name = `workspace-top-toggle-${testInfo.project.name}`;
  await createShellSession(name);
  await page.goto(server!.baseUrl);
  await page.locator(".card", { hasText: name }).first().click();
  const canvas = page.locator("#desktop-terminal-container canvas");
  await expect(canvas).toBeVisible();
  await canvas.evaluate(node => { (window as any).__toggleCanvas = node; });
  if (testInfo.project.name === "desktop") {
    const tools = page.locator("#sidebar-session-controls");
    const before = await tools.boundingBox();
    await expect(page.locator(".workspace-terminal-toolbar")).toBeHidden();
    await expect(page.locator("#workspace-tools, #workspace-settings-dialog, #terminal-transcript-btn")).toHaveCount(0);
    const collapse = tools.locator("#workspace-context-collapse");
    const box = await collapse.boundingBox();
    await expect(collapse.locator("svg")).toHaveCSS("color", "rgb(69, 237, 126)");
    await collapse.click();
    const expand = tools.locator("#workspace-restore");
    await expect(expand).toBeFocused();
    expect(await expand.boundingBox()).toEqual(box);
    await expand.press("Space");
    await expect(collapse).toBeFocused();
    await page.locator("#workspace-context-full").click();
    expect(await collapse.boundingBox()).toEqual(box);
    await collapse.click();
    await expect(page.locator("#workspace-context-region")).toBeHidden();
    await expand.click();
    expect(await tools.boundingBox()).toEqual(before);
    expect(await canvas.evaluate(node => node === (window as any).__toggleCanvas)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("desktop-tools-controls.png") });
    return;
  }
  const toolbar = page.locator(".workspace-terminal-toolbar");
  const height = (await toolbar.boundingBox())!.height;
  await expect(toolbar.locator("select, #terminal-transcript-btn")).toHaveCount(0);
  const controlSize = 44;
  expect(height).toBe(controlSize + 7);
  expect((await toolbar.boundingBox())!.y).toBe((await page.locator("#terminal-view").boundingBox())!.y);
  const collapse = page.getByRole("button", { name: "Collapse context panel", exact: true });
  const collapseBox = (await collapse.boundingBox())!;
  await expect(collapse.locator("svg")).toHaveCSS("color", "rgb(69, 237, 126)");
  await page.screenshot({ path: testInfo.outputPath("controls-expanded.png") });
  if (testInfo.project.name === "iphone-14") await collapse.tap(); else await collapse.click();
  const expand = page.getByRole("button", { name: "Expand context panel", exact: true });
  await expect(expand).toBeVisible();
  const box = (await expand.boundingBox())!;
  expect(box).toEqual(collapseBox);
  await expect(expand.locator("svg")).toHaveCSS("color", "rgb(69, 237, 126)");
  const top = (await toolbar.boundingBox())!;
  expect(top.height).toBe(height);
  expect(box.y).toBeGreaterThanOrEqual(top.y);
  expect(box.y + box.height).toBeLessThanOrEqual(top.y + top.height);
  expect(box.height).toBeGreaterThanOrEqual(testInfo.project.name === "iphone-14" ? 44 : 34);
  await page.screenshot({ path: testInfo.outputPath("top-context-toggle.png") });
  if (testInfo.project.name === "iphone-14") await expand.tap(); else await expand.press("Space");
  await expect(collapse).toBeVisible();
  await expect(expand).toBeHidden();
  expect(await collapse.boundingBox()).toEqual(collapseBox);
  const full = page.getByRole("button", { name: "Context full view", exact: true });
  await expect(full.locator("svg")).toHaveCSS("color", "rgb(69, 237, 126)");
  await full.click();
  expect(await collapse.boundingBox()).toEqual(collapseBox);
  await collapse.click();
  await expect(expand).toBeVisible();
  await expect(page.locator("#workspace-context-region")).toBeHidden();
  expect(await expand.boundingBox()).toEqual(collapseBox);
  await expand.click();
  expect(await canvas.evaluate(node => node === (window as any).__toggleCanvas)).toBe(true);
});

test("real broker desktop keyboard follows the rendered narrow vertical layout", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop workspace keyboard contract");
  await page.setViewportSize({ width: 1280, height: 720 });
  const names = ["workspace-key-one", "workspace-key-two"];
  for (const name of names) await createShellSession(name);
  await openGrid(page, names);
  await selectTerminalLayoutFromUi(page, "lead-stack");
  const first = page.locator(`#desktop-grid-container .grid-cell[data-session="${names[0]}"]`);
  const second = page.locator(`#desktop-grid-container .grid-cell[data-session="${names[1]}"]`);
  const [firstBox, secondBox] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(Math.abs(firstBox!.x - secondBox!.x)).toBeLessThanOrEqual(2);
  expect(secondBox!.y).toBeGreaterThan(firstBox!.y + firstBox!.height - 2);
  await first.click();
  await page.keyboard.press("Meta+Shift+ArrowDown");
  await expect(second).toHaveClass(/grid-focused/);
});

test("real broker delegation collapse retains the child controller and canvas", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation retention contract");
  const parent = "workspace-parent";
  const child = "workspace-child";
  await createShellSession(parent);
  await createChildSession(parent, child);
  await expect.poll(async () => {
    const response = await fetch(`${server!.baseUrl}/api/sessions`);
    const payload = await response.json() as { readonly sessions?: readonly { readonly name?: string; readonly identity?: { readonly parentSession?: { readonly wolfpackSessionName?: string } } }[] };
    return payload.sessions?.find(session => session.name === child)?.identity?.parentSession?.wolfpackSessionName;
  }).toBe(parent);
  const sockets: string[] = [];
  page.on("websocket", socket => {
    if (socket.url().includes("/ws/pty")) sockets.push(socket.url());
  });
  await page.goto(server!.baseUrl);
  await expect(page.locator(".delegation-parent-card", { hasText: parent }).first()).toBeVisible();
  await openSessionFromUi(page, parent, "");
  const childCell = page.locator(`#delegation-grid-container .grid-cell[data-session="${child}"]`);
  await expect(childCell).toHaveClass(/hydrated/);
  await childCell.locator("canvas").evaluate(canvas => canvas.setAttribute("data-workspace-collapse-canvas", "retained"));
  const attachesBefore = sockets.length;
  await expect(page.locator("#sidebar-settings-btn")).toBeVisible();
  await page.getByRole("button", { name: `Collapse ${child}` }).click();
  await expect(childCell).toHaveClass(/collapsed/);
  await expect(page.locator("#sidebar-settings-btn")).toBeVisible();
  await page.getByRole("button", { name: `Expand ${child}` }).click();
  await expect(page.locator("#sidebar-settings-btn")).toBeVisible();
  await expect(childCell).toHaveClass(/hydrated/);
  await expect(childCell.locator("canvas")).toHaveAttribute("data-workspace-collapse-canvas", "retained");
  expect(sockets).toHaveLength(attachesBefore);
  await page.getByRole("button", { name: `Focus ${child}` }).click();
  await expect(page.locator("#delegation-focus-back")).toBeVisible();
  await expect(page.locator("#sidebar-settings-btn")).toBeVisible();
  await selectTerminalLayoutFromUi(page, "vertical-stack");
  await expect(page.locator('#desktop-terminal-container canvas')).toBeVisible();
  await expect(page.locator('#delegation-focus-label')).toContainText(child);
  await expect(page.locator('#delegation-focus-back')).toBeVisible();
  await page.locator('#sidebar-settings-btn').click();
  await expect(page.locator('#desktop-terminal-container canvas')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#desktop-terminal-container canvas')).toBeVisible();
  await expect(page.locator('#delegation-focus-back')).toBeVisible();
  await expect(page.locator('#delegation-focus-label')).toContainText(child);
  await page.locator("#delegation-focus-back").click();
  await expect(page.locator("#sidebar-settings-btn")).toBeVisible();
});

test("saved terminal-only preferences still restore after removing the terminal full-view button", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop saved-preference recovery");
  const name = "workspace-legacy-full";
  await createShellSession(name);
  await page.goto(server!.baseUrl);
  await page.evaluate(() => localStorage.setItem("wolfpack-workspace-shell", JSON.stringify({ fullView: "terminals", splitSize: 320 })));
  await page.reload();
  await page.locator(".card", { hasText: name }).first().click();
  const canvas = page.locator("#desktop-terminal-container canvas");
  await expect(canvas).toBeVisible();
  await canvas.evaluate(node => { (window as any).__legacyFullCanvas = node; });
  await expect(page.locator("#workspace-terminal-full")).toHaveCount(0);
  await expect(page.locator("#workspace-context-region")).toBeHidden();
  await page.getByRole("button", { name: "Show widgets", exact: true }).click();
  await expect(page.locator("#workspace-context-region")).toBeVisible();
  expect(await canvas.evaluate(node => node === (window as any).__legacyFullCanvas)).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-workspace-shell")!).fullView)).toBe("none");
});

test("real broker mobile workspace recovery keeps the terminal attached", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-webkit", "mobile WebKit workspace recovery contract");
  const session = "workspace-mobile";
  await createShellSession(session);
  const sockets: string[] = [];
  page.on("websocket", socket => {
    if (socket.url().includes("/ws/pty")) sockets.push(socket.url());
  });
  await page.goto(server!.baseUrl);
  await page.locator(".card", { hasText: session }).first().click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 10_000 });
  const draft = page.locator("#msg-input");
  await draft.evaluate((input: HTMLTextAreaElement) => {
    input.value = "retain mobile draft";
    input.setSelectionRange(7, 13);
  });
  const attachesBefore = sockets.length;
  await page.locator("#workspace-context-full").click();
  await expect(page.locator("#workspace-terminal-region")).toBeHidden();
  await expect(page.getByRole("button", { name: "Restore workspace", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible();
  await expect(draft).toHaveValue("retain mobile draft");
  expect(await draft.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([7, 13]);
  expect(sockets).toHaveLength(attachesBefore);
});
