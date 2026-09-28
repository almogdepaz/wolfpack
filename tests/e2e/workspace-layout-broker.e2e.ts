import { dockPanel } from "./workspace-drag-helpers.ts";
import { selectTerminalLayoutFromUi } from "./helpers.ts";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { PROVIDER_DEFINITIONS } from "../../src/provider-readiness.ts";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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
  const bin = join(home.path, "bin"); mkdirSync(bin);
  // Server startup reads a login-shell PATH; macOS path_helper otherwise puts
  // installed agents ahead of the fixture PATH. Own its profile as well.
  writeFileSync(join(home.path, ".profile"), `export PATH=${JSON.stringify(bin)}:"$PATH"\n`);
  for (const provider of PROVIDER_DEFINITIONS) writeFileSync(join(bin, provider.command), '#!/bin/sh\n[ "$1" = "--version" ] || exit 64\nprintf "placement-fixture-provider 1.0\\n"\n', { mode: 0o700 });
  // Verify fresh executable fixtures serially before concurrent readiness probes.
  // Cold script starts on macOS can consume nearly the probe's 2s budget.
  for (const provider of PROVIDER_DEFINITIONS) expect(execFileSync(join(bin, provider.command), ["--version"], { encoding: "utf8", timeout: 2_000 }).trim()).toBe("placement-fixture-provider 1.0");
  server = await start({ envOverrides: {
    HOME: home.path, ZDOTDIR: home.path, SHELL: "/bin/sh", PATH: `${bin}:${process.env.PATH ?? ""}`,
    WOLFPACK_DEV_DIR: devDir,
    WOLFPACK_TAILSCALE_STATUS_JSON: "{}", // Local-name fallback without consulting the operator's Tailnet.
    WOLFPACK_MACHINE_ID_PATH: join(home.path, "machine-id"),
  } });
  const readiness = await (await fetch(`${server.baseUrl}/api/providers`)).json();
  expect(readiness.providers).toHaveLength(PROVIDER_DEFINITIONS.length);
  for (const provider of readiness.providers) {
    expect(provider.executablePath).toBe(join(bin, provider.command));
    expect(provider.version).toBe("placement-fixture-provider 1.0");
  }
});

test.afterAll(async () => {
  await server?.teardown();
  server = null;
  if (devDir) rmSync(devDir, { recursive: true, force: true });
  devDir = null;
  if (home) removeOwnedTestServerHome(home);
  home = null;
});

test("desktop dock dragging previews without changing layout and cancels safely", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only pointer and keyboard docking");
  const name = "drag-cancel-retention"; await createShellSession(name);
  let sockets = 0, resizes = 0;
  page.on("websocket", socket => {
    if (!socket.url().includes("/ws/pty")) return;
    sockets++;
    socket.on("framesent", ({ payload }) => { if (typeof payload === "string") { try { if (JSON.parse(payload).type === "resize") resizes++; } catch {} } });
  });
  await page.goto(server!.baseUrl); await page.locator(".card", { hasText: name }).first().click();
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  const handle = page.getByRole("button", { name: "Move Sessions", exact: true });
  await expect(handle).toBeVisible();
  await expect(page.locator("[data-widget-placement], [data-native-placement], #workspace-move-dialog")).toHaveCount(0);
  const snapshot = () => page.evaluate(() => [localStorage.getItem("wolfpack-widget-layout:v1"), localStorage.getItem("wolfpack-workspace-shell")]);
  await expect(page.locator("#desktop-terminal-container canvas")).toHaveCSS("opacity", "1");
  const saved = await snapshot(), attached = sockets;
  await page.evaluate(() => {
    (window as any).__dockWrites = 0;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === "wolfpack-widget-layout:v1" || key === "wolfpack-workspace-shell") (window as any).__dockWrites++; set.call(this, key, value); };
  });
  const edge = (await handle.boundingBox())!;
  await page.mouse.move(edge.x + 10, edge.y + 10); await page.mouse.down();
  await page.mouse.move(edge.x + 12, edge.y + 10);
  await expect(page.locator(".workspace-dock-targets")).toHaveCount(0);
  const beforeHover = resizes;
  await page.mouse.move(edge.x + 25, edge.y + 10);
  await expect(page.locator("[data-dock-target]")).toHaveCount(4);
  const previewAccessibility = await new AxeBuilder({ page }).include("#workspace-shell").exclude("canvas").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(previewAccessibility.violations.filter(violation => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("desktop-dock-preview.png") });
  expect(await snapshot()).toEqual(saved);
  expect(resizes).toBe(beforeHover);
  expect(sockets).toBe(attached);
  await page.keyboard.press("Escape"); await page.mouse.up();
  await expect(page.locator(".workspace-dock-targets")).toHaveCount(0);
  expect(await snapshot()).toEqual(saved);
  await expect(handle).toBeFocused();
  await handle.press("Space"); await handle.press("ArrowDown");
  await expect(page.locator('[data-dock-target="bottom"]')).toHaveAttribute("data-active", "true");
  await expect(page.locator('[data-dock-target="bottom"]')).toContainText("Bottom");
  await expect(page.locator("#workspace-dock-status")).toContainText("Sessions → bottom");
  expect(await snapshot()).toEqual(saved);
  await handle.press("Escape");
  expect(await snapshot()).toEqual(saved);
  await handle.press("Space");
  await page.locator("#sidebar-settings-btn").focus();
  await expect(page.locator(".workspace-dock-targets")).toHaveCount(0);
  expect(await snapshot()).toEqual(saved);
  // Outside release cancels rather than inventing a free-form position.
  await page.mouse.move(edge.x + 10, edge.y + 10); await page.mouse.down();
  const rootBox = (await page.locator("#workspace-shell").boundingBox())!;
  await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height + 10, { steps: 5 });
  await expect(page.locator("#workspace-dock-status")).toContainText("Outside workspace");
  await page.mouse.up();
  expect(await snapshot()).toEqual(saved);
  await handle.press("Space");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".workspace-dock-targets")).toHaveCount(0);
  await expect(page.locator("[data-dock-handle]:visible")).toHaveCount(0);
  expect(await snapshot()).toEqual(saved);
  expect(await page.evaluate(() => (window as any).__dockWrites)).toBe(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Keyboard uses the same bounded drop, not a hidden placement menu.
  await handle.focus(); await handle.press("Space"); await handle.press("ArrowDown"); await handle.press("Enter");
  await expect(page.locator("#desktop-sidebar")).toHaveAttribute("data-widget-area", "bottom");
  await expect(handle).toBeFocused();
  await dockPanel(page, "Sessions", "left");
  await page.getByRole("button", { name: "Close Widgets", exact: true }).click();
  await page.locator("#sidebar-collapse-btn").click();
  await expect(page.getByRole("button", { name: "Move Terminal grid", exact: true })).toHaveCount(0);
  await expect(page.locator("#workspace-terminal-region .workspace-context-header:visible")).toHaveCount(0);
  await expect(page.locator("#workspace-terminal-region")).toHaveAttribute("data-widget-area", "main");
  expect(sockets).toBe(attached);
});

test("desktop docking rejects touch and cancels lost capture and navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop gesture lifecycle");
  const name = "drag-lifecycle"; await createShellSession(name);
  await page.goto(server!.baseUrl); await page.locator(".card", { hasText: name }).first().click();
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  const handle = page.getByRole("button", { name: "Move Sessions", exact: true });
  const saved = await page.evaluate(() => localStorage.getItem("wolfpack-widget-layout:v1"));
  const point = (await handle.boundingBox())!;
  // A simulated touch on a desktop handle must not enter a drag or capture it.
  await handle.dispatchEvent("pointerdown", { pointerId: 9, pointerType: "touch", isPrimary: true, button: 0, clientX: point.x + 10, clientY: point.y + 10 });
  await handle.dispatchEvent("pointermove", { pointerId: 9, pointerType: "touch", isPrimary: true, clientX: point.x + 30, clientY: point.y + 10 });
  await expect(page.locator(".workspace-dock-targets")).toHaveCount(0);
  await handle.evaluate(node => node.addEventListener("gotpointercapture", event => { if (event instanceof PointerEvent) (window as any).__dockPointer = event.pointerId; }, { once: true }));
  await page.mouse.move(point.x + 10, point.y + 10); await page.mouse.down(); await page.mouse.move(point.x + 25, point.y + 10);
  await expect(page.locator(".workspace-dock-targets")).toHaveCount(1);
  await handle.evaluate(node => node.releasePointerCapture((window as any).__dockPointer));
  await page.mouse.move(point.x + 30, point.y + 10);
  await expect(page.locator(".workspace-dock-targets")).toHaveCount(0); await page.mouse.up();
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-widget-layout:v1"))).toBe(saved);
  await handle.focus(); await handle.press("Space");
  await page.locator("#sidebar-settings-btn").click();
  await expect(page.locator("#settings-view")).toBeVisible();
  await expect(page.locator(".workspace-dock-targets")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-widget-layout:v1"))).toBe(saved);
  await page.locator("#settings-back-btn").click();
  await expect(handle).toBeVisible();
});

test("opening a session from shared Main reveals its retained terminal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop shared native docks");
  const name = "shared-main-open", other = "shared-main-other";
  await createShellSession(name); await createShellSession(other);
  let sockets = 0;
  page.on("websocket", socket => { if (socket.url().includes("/ws/pty")) sockets++; });
  await page.goto(server!.baseUrl);
  await page.locator(".card", { hasText: name }).first().click();
  const terminal = page.locator("#workspace-terminal-region");
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  const canvas = page.locator("#desktop-terminal-container canvas");
  await canvas.evaluate(node => { (window as any).__sharedCanvas = { node, parent: node.parentElement }; });
  const attached = sockets;
  const grip = (await page.getByRole("button", { name: "Move Sessions", exact: true }).boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 8, grip.y + grip.height / 2);
  const mainTarget = page.locator('[data-dock-target="main"]');
  const box = (await mainTarget.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await expect(mainTarget).toContainText("Tabs with Terminal grid");
  await page.mouse.up();
  const placements = await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-widget-layout:v1")!).placements);
  await expect(page.getByRole("tab", { name: "Terminal grid", exact: true })).toBeVisible();
  await expect(terminal).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("sessions-dropped-into-main.png") });
  await page.getByRole("tab", { name: "Terminal grid", exact: true }).click();
  await expect(terminal).toBeVisible();
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  await page.locator("#sidebar-session-list .card", { hasText: name }).click();
  await expect(terminal).toBeVisible();
  expect(await canvas.evaluate(node => node === (window as any).__sharedCanvas.node && node.parentElement === (window as any).__sharedCanvas.parent)).toBe(true);
  expect(sockets).toBe(attached);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-widget-layout:v1")!).placements)).toEqual(placements);
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  await page.locator("#sidebar-session-list .card", { hasText: other }).click();
  await expect(terminal).toBeVisible();
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  await page.screenshot({ path: testInfo.outputPath("session-open-reveals-shared-terminal.png") });
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  await page.locator("#sidebar-settings-btn").click();
  await expect(page.locator("#settings-view")).toBeVisible();
  await expect(page.locator(".view.swiping")).toHaveCount(0);
  await page.locator("#settings-back-btn").click();
  await expect(page.getByRole("tab", { name: "Sessions", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(terminal).toBeHidden();
  await page.getByRole("tab", { name: "Terminal grid", exact: true }).click();
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  // Returning from Settings preserves the selected dock tab, not explicit session-opening intent.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-widget-layout:v1")!).placements)).toEqual(placements);
});

test("opening a grid session from shared Main reveals the intact grid", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop shared native docks");
  const names = ["shared-grid-one", "shared-grid-two"];
  for (const name of names) await createShellSession(name);
  let sockets = 0;
  page.on("websocket", socket => { if (socket.url().includes("/ws/pty")) sockets++; });
  await openGrid(page, names);
  const cells = page.locator("#desktop-grid-container .grid-cell");
  await expect(cells.first()).toHaveAttribute("data-terminal-load-state", "live");
  await expect(cells.last()).toHaveAttribute("data-terminal-load-state", "live");
  await cells.locator("canvas").evaluateAll(nodes => { (window as any).__sharedGrid = nodes.map(node => ({ node, parent: node.parentElement })); });
  const attached = sockets;
  await dockPanel(page, "Sessions", "main");
  await page.locator("#sidebar-session-list .card", { hasText: names[0]! }).click();
  await expect(page.locator("#workspace-terminal-region")).toBeVisible();
  await expect(cells.first()).toHaveClass(/grid-focused/);
  expect(await cells.locator("canvas").evaluateAll(nodes => nodes.every((node, index) => node === (window as any).__sharedGrid[index].node && node.parentElement === (window as any).__sharedGrid[index].parent))).toBe(true);
  expect(sockets).toBe(attached);
});

test("adding a session to a tab-hidden grid reveals its dock", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop grid action");
  const names = ["hidden-grid-one", "hidden-grid-two"];
  for (const name of names) await createShellSession(name);
  await page.goto(server!.baseUrl);
  await page.locator(".card", { hasText: names[0]! }).first().click();
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  await dockPanel(page, "Sessions", "main");
  await page.locator(`#sidebar-session-list [data-action="toggle-grid"][data-session="${names[1]}"]`).click();
  await expect(page.locator("#workspace-terminal-region")).toBeVisible();
  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(2);
});

test("Sessions docking resizes the fixed grid without replacing live terminals",  async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop native-panel dragging and retained grid");
  await page.setViewportSize({ width: 1440, height: 900 });
  const names = ["docking-one", "docking-two"];
  for (const name of names) await createShellSession(name);
  let sockets = 0;
  const sizes: Array<{ cols: number; rows: number }> = [];
  page.on("websocket", socket => {
    if (!socket.url().includes("/ws/pty")) return;
    sockets++;
    socket.on("framesent", ({ payload }) => { if (typeof payload === "string") { try { const frame = JSON.parse(payload); if (frame.type === "resize") sizes.push(frame); } catch {} } });
  });
  await openGrid(page, names);
  const cells = page.locator("#desktop-grid-container .grid-cell");
  await expect(cells.locator("canvas")).toHaveCount(2);
  await expect(cells.first()).toHaveAttribute("data-terminal-load-state", "live");
  await expect(cells.last()).toHaveAttribute("data-terminal-load-state", "live");
  await cells.first().click(); await page.keyboard.type("printf 'DOCK_%s\\n' RETENTION"); await page.keyboard.press("Enter");
  const tail = () => cells.first().evaluate(node => (window as any).__wolfpackTest.serializeTerminalTail(node, 200));
  await expect.poll(tail).toContain("DOCK_RETENTION");
  await cells.locator("canvas").evaluateAll(nodes => { (window as any).__dockCanvases = nodes.map(node => ({ node, parent: node.parentElement })); });
  const attached = sockets;
  const sessions = page.locator("#desktop-sidebar"), terminal = page.locator("#workspace-terminal-region");
  await expect(terminal.locator(".workspace-context-header:visible")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Move Terminal grid", exact: true })).toHaveCount(0);
  const leftDivider = page.getByRole("separator", { name: "Resize left panels", exact: true });
  const rightDivider = page.getByRole("separator", { name: "Resize right panels", exact: true });
  await leftDivider.focus(); await leftDivider.press("ArrowRight");
  await expect(leftDivider).toHaveAttribute("aria-valuenow", "282");
  await expect(rightDivider).toHaveAttribute("aria-valuenow", "320");
  const edge = (await leftDivider.boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 20); await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 30, edge.y + 20, { steps: 4 }); await page.mouse.up();
  await expect(leftDivider).toHaveAttribute("aria-valuenow", "312");
  await page.setViewportSize({ width: 769, height: 900 });
  await leftDivider.focus(); await leftDivider.press("Home");
  await expect(leftDivider).toHaveAttribute("aria-valuenow", "220");
  await leftDivider.press("ArrowRight"); await expect(leftDivider).toHaveAttribute("aria-valuenow", "230");
  await leftDivider.press("End");
  expect(await leftDivider.getAttribute("aria-valuenow")).toBe(await leftDivider.getAttribute("aria-valuemax"));
  expect((await terminal.boundingBox())!.width).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await dockPanel(page, "Sessions", "right");
  await expect(sessions).toHaveAttribute("data-widget-area", "right");
  expect((await sessions.boundingBox())!.x).toBeGreaterThan((await terminal.boundingBox())!.x);
  await dockPanel(page, "Sessions", "bottom");
  await expect(sessions).toHaveAttribute("data-widget-area", "bottom");
  await expect(terminal).toHaveAttribute("data-widget-area", "main");
  const sessionsBox = (await sessions.boundingBox())!, terminalBox = (await terminal.boundingBox())!;
  expect(sessionsBox.y).toBeGreaterThanOrEqual(terminalBox.y + terminalBox.height);
  expect(terminalBox.height).toBeGreaterThan(0);
  await expect(cells.first().locator(".grid-cell-loading")).toBeHidden();
  await expect(cells.first().locator("canvas")).toHaveCSS("opacity", "1");
  await expect(cells.last().locator("canvas")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("sessions-bottom-grid-main.png") });
  // Sharing Main uses tabs, not a view-navigation action or a terminal remount.
  await dockPanel(page, "Sessions", "main");
  await page.getByRole("tab", { name: "Terminal grid", exact: true }).click();
  const selectedTab = page.getByRole("tab", { name: "Terminal grid", exact: true });
  const sessionsTab = page.getByRole("tab", { name: "Sessions", exact: true });
  await expect(selectedTab).toHaveCSS("border-bottom-width", "1px");
  await expect(selectedTab).toHaveCSS("border-bottom-color", "rgb(27, 36, 30)");
  await expect(selectedTab).toHaveCSS("background-color", "rgb(27, 36, 30)");
  await expect(selectedTab).toHaveCSS("box-shadow", "rgb(69, 237, 126) 0px 2px 0px 0px inset");
  await expect(selectedTab).toHaveCSS("font-weight", "600");
  await expect(selectedTab).toHaveCSS("border-bottom-left-radius", "0px");
  await expect(sessionsTab).toHaveCSS("border-bottom-color", "rgb(43, 57, 48)");
  await expect(sessionsTab).toHaveCSS("background-color", "rgb(20, 27, 23)");
  await page.screenshot({ path: testInfo.outputPath("shared-main-tab-strip.png") });
  await selectedTab.focus(); await selectedTab.press("ArrowRight");
  await expect(sessionsTab).toBeFocused();
  await expect(sessionsTab).toHaveCSS("outline-style", "solid");
  await expect(sessionsTab).toHaveCSS("outline-width", "2px");
  const accessibility = await new AxeBuilder({ page }).include("#workspace-shell").exclude("canvas").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(accessibility.violations.filter(violation => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
  await sessionsTab.click();
  await expect(terminal).toBeHidden();
  await expect(sessionsTab).toHaveCSS("font-weight", "600");
  await expect(selectedTab).toHaveCSS("border-bottom-color", "rgb(43, 57, 48)");
  await expect(sessionsTab).toHaveCSS("background-color", "rgb(27, 36, 30)");
  await page.getByRole("tab", { name: "Terminal grid", exact: true }).click();
  await expect(terminal).toBeVisible();
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  await dockPanel(page, "Sessions", "right");
  await expect(sessions).toHaveAttribute("data-widget-area", "right");
  await expect(terminal).toHaveAttribute("data-widget-area", "main");
  expect(await cells.locator("canvas").evaluateAll(nodes => nodes.every((node, index) => { const old = (window as any).__dockCanvases[index]; return node === old.node && node.parentElement === old.parent; }))).toBe(true);
  expect(sockets).toBe(attached);
  expect(sizes.length).toBeGreaterThan(0);
  expect(sizes.every(size => size.cols > 0 && size.rows > 0)).toBe(true);
  await expect.poll(tail).toContain("DOCK_RETENTION");
  const saved = await page.evaluate(() => localStorage.getItem("wolfpack-widget-layout:v1"));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(terminal).toBeVisible(); await expect(sessions).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-widget-layout:v1"))).toBe(saved);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(terminal).toHaveAttribute("data-widget-area", "main");
  await dockPanel(page, "Sessions", "left");
  await expect(sessions).toHaveAttribute("data-widget-area", "left");
  await expect(terminal).toHaveAttribute("data-widget-area", "main");
  expect(sockets).toBe(attached);
  const persisted = await page.evaluate(() => localStorage.getItem("wolfpack-widget-layout:v1"));
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === "wolfpack-widget-layout:v1" || key === "wolfpack-workspace-shell") throw Error("blocked"); set.call(this, key, value); };
  });
  await dockPanel(page, "Sessions", "right");
  await expect(page.locator("#workspace-dock-status")).toContainText("this tab only");
  await expect(sessions).toHaveAttribute("data-widget-area", "right");
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-widget-layout:v1"))).toBe(persisted);
  await page.reload(); await page.locator(".card", { hasText: names[0]! }).first().click();
  await expect(terminal).toHaveAttribute("data-widget-area", "main");
  await expect(sessions).toHaveAttribute("data-widget-area", "left");
});

test("late server-owned local name preserves the attached terminal and scrollback", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop retained native canvas");
  const name = "local-name-retention";
  await createShellSession(name);
  const info = await (await fetch(`${server!.baseUrl}/api/info`)).json();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  // Name rendering must not replace an already attached terminal.
  let handling: Promise<void> | undefined;
  await page.route(`${server!.baseUrl}/api/info`, route => handling = (async () => {
    await held;
    await route.fulfill({ json: { ...info, name: "Server fixture machine" } });
  })());
  let sockets = 0;
  page.on("websocket", socket => { if (socket.url().includes("/ws/pty")) sockets++; });
  try {
    await page.goto(server!.baseUrl);
    await page.locator(".card", { hasText: name }).first().click();
    const terminal = page.locator("#desktop-terminal-container");
    await expect(terminal).toHaveAttribute("data-terminal-load-state", "live");
    await terminal.locator("canvas").evaluate(node => { (window as any).__nameCanvas = node; });
    const attached = sockets;
    await terminal.click(); await page.keyboard.type("printf 'NAME_%s\\n' RETENTION"); await page.keyboard.press("Enter");
    const readTail = () => terminal.evaluate(node => (window as any).__wolfpackTest.serializeTerminalTail(node, 200));
    await expect.poll(readTail).toContain("NAME_RETENTION");
    release();
    await expect(page.locator('#sidebar-session-list .machine-group[data-machine=""] .machine-header-name')).toHaveText("Server fixture machine");
    expect(await terminal.locator("canvas").evaluate(node => node === (window as any).__nameCanvas)).toBe(true);
    expect(sockets).toBe(attached);
    expect(await readTail()).toContain("NAME_RETENTION");
    await expect(terminal).toHaveAttribute("data-terminal-load-state", "live");
  } finally { release(); await handling; }
});

test("shared widget panel moves right bottom and full screen while native grid instances survive", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop drag and splitter geometry");
  await page.setViewportSize({ width: 1440, height: 900 });
  const names = ["placement-one", "placement-two"];
  for (const name of names) await createShellSession(name);
  let sockets = 0;
  const sizes: Array<{ cols: number; rows: number }> = [];
  page.on("websocket", socket => { if (!socket.url().includes("/ws/pty")) return; sockets++; socket.on("framesent", ({ payload }) => { if (typeof payload === "string") { try { const value = JSON.parse(payload); if (value.type === "resize") sizes.push(value); } catch {} } }); });
  await openGrid(page, names);
  const firstCell = page.locator("#desktop-grid-container .grid-cell").first();
  await expect(firstCell).toHaveAttribute("data-terminal-load-state", "live");
  await firstCell.click(); await page.keyboard.type("printf 'WP%s\\n' PLACEMENT_RETENTION"); await page.keyboard.press("Enter");
  const readTail = () => firstCell.evaluate(cell => (window as any).__wolfpackTest.serializeTerminalTail(cell, 200));
  await expect.poll(readTail).toContain("WPPLACEMENT_RETENTION");
  const canvases = page.locator("#desktop-grid-container .grid-cell canvas");
  await canvases.evaluateAll(nodes => { (window as any).__placementCanvases = nodes; });
  const attached = sockets;
  const panel = page.locator(".widget-panel:visible");
  const terminal = page.locator("#workspace-terminal-region");
  const divider = page.locator("#workspace-context-divider:visible, #workspace-bottom-divider:visible");
  await dockPanel(page, "Widgets", "bottom");
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  await expect(divider).toHaveCSS("cursor", "row-resize");
  const before = (await panel.boundingBox())!;
  const terminalBox = (await terminal.boundingBox())!;
  expect(before.y).toBeGreaterThanOrEqual(terminalBox.y + terminalBox.height);
  expect(Math.abs(before.width - terminalBox.width)).toBeLessThanOrEqual(2);
  const edge = (await divider.boundingBox())!;
  await canvases.first().click();
  const focus = await page.evaluateHandle(() => document.activeElement);
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down(); await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2 - 60, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => Math.round((await panel.boundingBox())!.height)).toBe(Math.round(before.height + 60));
  expect(await page.evaluate(previous => document.activeElement === previous, focus)).toBe(true);
  await divider.focus(); await divider.press("ArrowUp");
  await expect.poll(async () => Math.round((await panel.boundingBox())!.height)).toBe(Math.round(before.height + 70));
  await divider.press("End"); expect((await terminal.boundingBox())!.height).toBeGreaterThanOrEqual(160);
  await divider.press("Home"); await expect(divider).toHaveAttribute("aria-valuenow", "140");
  await dockPanel(page, "Widgets", "right"); await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect(divider).toHaveAttribute("aria-valuenow", "320");
  await divider.focus(); await divider.press("ArrowLeft");
  await dockPanel(page, "Widgets", "bottom"); await expect(divider).toHaveAttribute("aria-valuenow", "140");
  await page.getByRole("button", { name: "Context full view", exact: true }).click(); await expect(terminal).toBeHidden(); await expect(divider).toBeHidden();
  await page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await expect(panel).toHaveAttribute("data-widget-area", "bottom"); await expect(terminal).toBeVisible();
  expect(await canvases.evaluateAll(nodes => nodes.every((node, index) => node === (window as any).__placementCanvases[index]))).toBe(true);
  expect(sockets).toBe(attached); expect(sizes.length).toBeGreaterThan(0); expect(sizes.every(size => size.cols > 0 && size.rows > 0)).toBe(true);
  await expect(firstCell).toHaveAttribute("data-terminal-load-state", "live");
  await expect.poll(readTail).toContain("WPPLACEMENT_RETENTION");
  await expect(firstCell.locator(".grid-cell-loading")).toBeHidden();
  await expect(canvases.first()).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("bottom-widget-panel.png") });
  await page.setViewportSize({ width: 1440, height: 320 });
  await expect.poll(async () => (await terminal.boundingBox())!.height).toBeGreaterThan(0);
  const shortShell = (await page.locator("#workspace-shell").boundingBox())!;
  const shortPanel = (await panel.boundingBox())!;
  expect(shortPanel.y + shortPanel.height).toBeLessThanOrEqual(shortShell.y + shortShell.height + 1);
  expect(shortPanel.height).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(divider).toHaveAttribute("aria-valuenow", "140");
  await page.reload(); await page.locator(".card", { hasText: names[0]! }).first().click();
  await expect(panel).toHaveAttribute("data-widget-area", "bottom"); await expect(divider).toHaveAttribute("aria-valuenow", "140");
  await page.locator("#sidebar-settings-btn").click();
  await page.getByRole("link", { name: "Widgets", exact: true }).click();
  await page.getByRole("button", { name: "Reset workspace layout", exact: true }).click();
  await page.locator("#settings-back-btn").click();
  await expect(panel).toHaveAttribute("data-widget-area", "right"); await expect(divider).toHaveAttribute("aria-valuenow", "320");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wolfpack-workspace-shell")!).bottomSize)).toBe(240);
});

test("widget layout remains recoverable when browser storage rejects writes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop in-memory recovery and Settings reset");
  const name = "placement-storage"; await createShellSession(name);
  await page.goto(server!.baseUrl); await page.locator(".card", { hasText: name }).first().click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible();
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === "wolfpack-workspace-shell" || key === "wolfpack-widget-layout:v1") throw Error("blocked"); set.call(this, key, value); };
  });
  await dockPanel(page, "Widgets", "bottom");
  await expect(page.locator(".widget-panel:visible")).toHaveAttribute("data-widget-area", "bottom");
  await expect(page.locator(".widget-panel:visible [data-extension-status]")).toContainText("this tab only");
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-widget-layout:v1"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-workspace-shell"))).toBeNull();
  await page.getByRole("button", { name: "Context full view", exact: true }).click();
  await page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await page.locator("#sidebar-settings-btn").click();
  await page.getByRole("link", { name: "Widgets", exact: true }).click();
  await page.getByRole("button", { name: "Reset workspace layout", exact: true }).click();
  await expect(page.locator("#settings-extensions [data-workspace-layout-status]")).toContainText("storage is unavailable");
  await page.locator("#settings-back-btn").click();
  await expect(page.locator(".widget-panel:visible")).toHaveAttribute("data-widget-area", "right");
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible();
});

test("mobile widgets are a separate full-screen view and never overwrite the desktop layout", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-14", "responsive mobile presentation and breakpoint recovery");
  const name = "placement-mobile"; await createShellSession(name);
  await page.addInitScript(() => { if (!localStorage.getItem("placement-seeded")) { localStorage.setItem("wolfpack-workspace-shell", JSON.stringify({ panelPlacement: "bottom", bottomSize: 270, splitSize: 410, fullView: "context" })); localStorage.setItem("placement-seeded", "yes"); } });
  let sockets = 0; page.on("websocket", socket => { if (socket.url().includes("/ws/pty")) sockets++; });
  await page.goto(server!.baseUrl); await page.locator(".card", { hasText: name }).first().click();
  const canvas = page.locator("#desktop-terminal-container canvas"); await expect(canvas).toBeVisible();
  const old = await canvas.elementHandle(); const attached = sockets;
  const saved = await page.evaluate(() => localStorage.getItem("wolfpack-workspace-shell"));
  const draft = page.locator("#msg-input"); await draft.evaluate((node: HTMLTextAreaElement) => { node.value = "retained draft"; node.setSelectionRange(2, 5); });
  await expect(page.locator("#workspace-context-region")).toBeHidden();
  await page.locator("#workspace-restore").tap();
  await expect(page.locator("#workspace-terminal-region")).toBeHidden();
  await expect(page.locator("[data-dock-handle]:visible")).toHaveCount(0);
  for (const selector of ["#workspace-context-divider", "#workspace-bottom-divider"]) await expect(page.locator(selector)).toBeHidden();
  const shell = (await page.locator("#workspace-shell").boundingBox())!; const panel = (await page.locator(".widget-panel:visible").boundingBox())!;
  const header = (await page.locator("#workspace-mobile-header").boundingBox())!;
  expect(panel.width).toBeCloseTo(shell.width, 0);
  expect(header.y).toBeCloseTo(shell.y, 0);
  expect(panel.y).toBeCloseTo(header.y + header.height, 0);
  expect(panel.height + header.height).toBeCloseTo(shell.height, 0);
  await expect(page.getByRole("button", { name: "Back to terminal", exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("mobile-widget-screen.png") });
  await page.getByRole("button", { name: "Back to terminal", exact: true }).tap();
  await expect(canvas).toBeVisible(); expect(await canvas.evaluate((node, previous) => node === previous, old)).toBe(true); expect(sockets).toBe(attached);
  await expect(draft).toHaveValue("retained draft"); expect(await draft.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([2, 5]);
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-workspace-shell"))).toBe(saved);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("#workspace-shell")).toHaveAttribute("data-full-view", "context");
  expect(await page.evaluate(() => localStorage.getItem("wolfpack-workspace-shell"))).toBe(saved);
  await page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await expect(page.locator(".widget-panel:visible")).toHaveAttribute("data-widget-area", "bottom");
  const divider = page.locator("#workspace-bottom-divider");
  await expect(divider).toHaveAttribute("aria-valuenow", "270");
  const edge = (await divider.boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2); await page.mouse.down();
  await expect(page.locator("#workspace-shell")).toHaveClass(/workspace-resizing/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#workspace-shell")).not.toHaveClass(/workspace-resizing/);
  await page.mouse.up();
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((node, previous) => node === previous, old)).toBe(true);
  expect(sockets).toBe(attached);
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
  await page.getByRole("button", { name: "Collapse Widgets", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Widgets", exact: true })).toBeVisible();
  expect(await page.locator("#desktop-grid-container .grid-cell canvas").evaluateAll((canvases) => canvases.map(canvas => canvas.getAttribute("data-workspace-canvas")))).toEqual(["0", "1", "2", "3", "4"]);
  await page.getByRole("tab", { name: "Widgets", exact: true }).click();
  await page.locator("[data-widget-full]:visible").click();
  await expect(page.locator("#workspace-terminal-region")).toBeHidden();
  const [shellBox, contextBox] = await Promise.all([page.locator("#workspace-shell").boundingBox(), page.locator(".widget-panel:visible").boundingBox()]);
  expect(shellBox).not.toBeNull();
  expect(contextBox).not.toBeNull();
  expect(Math.abs(contextBox!.width - shellBox!.width)).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await expect(fifth).toHaveClass(/grid-focused/);
  expect(socketUrls).toHaveLength(attachesBefore);
});

test("right context panel resizes with real pointer and keyboard input without replacing the terminal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop splitter contract; mobile uses a separate widget screen");
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
  for (const label of ["Collapse Widgets", "Close Widgets", "Context full view"]) {
    const control = page.getByRole("button", { name: label, exact: true });
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute("title", label);
  }
  await expect(page.locator("#workspace-context-collapse")).toHaveCount(0);
  const context = page.locator(".widget-panel:visible");
  const terminal = page.locator("#workspace-terminal-region");
  const before = (await context.boundingBox())!;
  const terminalBefore = (await terminal.boundingBox())!;
  expect(before.x).toBeGreaterThanOrEqual(terminalBefore.x + terminalBefore.width);
  await expect(page.locator("#workspace-context-placement, #workspace-context-size")).toHaveCount(0);
  const border = page.locator("#workspace-context-divider:visible");
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
  await page.locator("[data-widget-full]:visible").click();
  await expect(page.locator("[data-widget-full]:visible .restore-icon")).toBeVisible();
  await expect(border).toBeHidden();
  await page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  const toolsBeforeCollapse = (await page.locator("#sidebar-session-controls").boundingBox())!;
  const collapse = page.getByRole("button", { name: "Collapse Widgets", exact: true });
  await collapse.click();
  const expand = page.getByRole("tab", { name: "Widgets", exact: true });
  await expect(expand).toBeFocused();
  await expect(context).toHaveAttribute("data-collapsed", "true");
  expect((await context.boundingBox())!.width).toBe(44);
  await expect(border).toBeHidden();
  expect(await page.locator("#sidebar-session-controls").boundingBox()).toEqual(toolsBeforeCollapse);
  await expect(page.locator(".workspace-terminal-toolbar")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("collapsed-widget-rail.png") });
  await expand.press("Enter");
  await expect(collapse).toBeFocused();
  await expect(expand).toBeHidden();
  await expect(border).toBeVisible();
  await page.reload();
  await page.locator(".card", { hasText: name }).first().click();
  await expect.poll(async () => Math.round((await context.boundingBox())!.width)).toBe(220);
});

test("widget controls stay local on desktop and open from the mobile app header",  async ({ page }, testInfo) => {
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
    await expect(page.locator(".workspace-terminal-toolbar")).toHaveCount(0);
    await expect(page.locator("#workspace-tools, #workspace-settings-dialog, #terminal-transcript-btn, #workspace-context-collapse")).toHaveCount(0);
    const collapse = page.getByRole("button", { name: "Collapse Widgets", exact: true });
    await collapse.click();
    const expand = page.getByRole("tab", { name: "Widgets", exact: true });
    await expect(expand).toBeFocused();
    await expand.press("Space");
    await expect(collapse).toBeFocused();
    await page.locator("[data-widget-full]:visible").click();
    await collapse.click();
    await expect(page.locator("#workspace-terminal-region")).toBeVisible();
    await expect(page.locator(".widget-panel:visible")).toHaveAttribute("data-collapsed", "true");
    await expand.click();
    expect(await tools.boundingBox()).toEqual(before);
    expect(await canvas.evaluate(node => node === (window as any).__toggleCanvas)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("desktop-tools-controls.png") });
    return;
  }
  // Initial navigation translates the entire mobile view; measure settled chrome.
  await expect(page.locator("#terminal-view")).not.toHaveClass(/swiping/);
  const toolbar = page.locator("body > header");
  await expect(page.locator(".workspace-terminal-toolbar, #terminal-transcript-btn")).toHaveCount(0);
  const expand = page.getByRole("button", { name: "Widgets", exact: true });
  await expect(expand).toBeVisible();
  const box = (await expand.boundingBox())!;
  await expect(expand.locator("svg")).toHaveCSS("color", "rgb(69, 237, 126)");
  const top = (await toolbar.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(top.y);
  expect(box.y + box.height).toBeLessThanOrEqual(top.y + top.height);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath("top-context-toggle.png") });
  await expand.tap();
  await expect(expand).toBeHidden();
  await expect(page.locator("#workspace-terminal-region")).toBeHidden();
  const back = page.getByRole("button", { name: "Back to terminal", exact: true });
  await expect(back).toBeFocused();
  await back.tap();
  await expect(expand).toBeFocused();
  await expect(page.locator("#workspace-context-region")).toBeHidden();
  expect(await expand.boundingBox()).toEqual(box);
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

test("saved terminal-only preferences recover through Settings without a terminal header",  async ({ page }, testInfo) => {
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
  await page.locator("#sidebar-settings-btn").click();
  await page.getByRole("link", { name: "Widgets", exact: true }).click();
  await page.getByRole("button", { name: "Reopen closed widgets", exact: true }).click();
  await page.locator("#settings-back-btn").click();
  await expect(page.locator(".widget-panel:visible")).toBeVisible();
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  // Real Settings navigation retains its existing suspend/reattach lifecycle.
  expect(await canvas.evaluate(node => node !== (window as any).__legacyFullCanvas)).toBe(true);
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
  await page.locator("#workspace-restore").click();
  await expect(page.locator("#workspace-terminal-region")).toBeHidden();
  await expect(page.getByRole("button", { name: "Back to terminal", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to terminal", exact: true }).click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible();
  await expect(draft).toHaveValue("retain mobile draft");
  expect(await draft.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([7, 13]);
  expect(sockets).toHaveLength(attachesBefore);
});
