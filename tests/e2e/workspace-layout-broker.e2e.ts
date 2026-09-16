import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { start, skipIfNoBroker, type BrokerTestServer } from "./broker-helpers.ts";

test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);

const PROJECT_NAME = "wp-workspace-layout";
let server: BrokerTestServer | null = null;
let devDir: string | null = null;

async function createShellSession(name: string): Promise<void> {
  const response = await fetch(`${server!.baseUrl}/api/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: PROJECT_NAME, cmd: "shell", sessionName: name }),
  });
  expect(response.ok, `create ${name}`).toBeTruthy();
}

test.beforeAll(async () => {
  if (skipIfNoBroker.condition) return;
  devDir = realpathSync(mkdtempSync(join(tmpdir(), "wp-workspace-layout-")));
  mkdirSync(join(devDir, PROJECT_NAME));
  server = await start({ envOverrides: { WOLFPACK_DEV_DIR: devDir } });
});

test.afterAll(async () => {
  await server?.teardown();
  server = null;
  if (devDir) rmSync(devDir, { recursive: true, force: true });
  devDir = null;
});

test("real broker desktop workspace geometry retains attached terminal controllers", async ({ page }, testInfo) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  test.skip(testInfo.project.name !== "desktop", "desktop workspace geometry contract");
  const first = "workspace-one";
  const second = "workspace-two";
  await createShellSession(first);
  await createShellSession(second);
  const sockets: string[] = [];
  page.on("websocket", socket => {
    if (socket.url().includes("/ws/pty")) sockets.push(socket.url());
  });
  await page.goto(server!.baseUrl);
  await page.locator(".card", { hasText: first }).first().click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 10_000 });
  await page.locator(`[data-action="toggle-grid"][data-session="${second}"]`).filter({ visible: true }).click();
  await expect(page.locator("#desktop-grid-container .grid-cell canvas")).toHaveCount(2, { timeout: 10_000 });
  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(2, { timeout: 10_000 });
  await page.locator(`#desktop-grid-container .grid-cell[data-session="${second}"]`).click();
  await expect(page.locator("#desktop-grid-container .grid-cell.grid-focused")).toHaveAttribute("data-session", second);
  await page.locator("#desktop-grid-container .grid-cell canvas").evaluateAll((canvases) => canvases.forEach((canvas, index) => canvas.setAttribute("data-workspace-canvas", String(index))));
  const attachesBefore = sockets.length;

  await page.locator("#workspace-terminal-layout").selectOption("lead-stack");
  await expect(page.locator("#desktop-grid-container")).toHaveCSS("grid-template-columns", /minmax/);
  await expect(page.locator("#desktop-grid-container .grid-cell.grid-focused")).toHaveAttribute("data-session", second);
  await page.locator("#workspace-context-collapse").click();
  await expect(page.locator("#workspace-restore")).toBeVisible();
  expect(await page.locator("#desktop-grid-container .grid-cell canvas").evaluateAll((canvases) => canvases.map(canvas => canvas.getAttribute("data-workspace-canvas")))).toEqual(["0", "1"]);
  await page.locator("#workspace-restore").click();
  await page.locator("#workspace-context-full").click();
  await expect(page.locator("#workspace-terminal-region")).toBeHidden();
  await page.locator("#workspace-restore").click();
  await expect(page.locator("#desktop-grid-container .grid-cell.grid-focused")).toHaveAttribute("data-session", second);
  expect(sockets).toHaveLength(attachesBefore);
});

test("real broker mobile workspace recovery keeps the terminal attached", async ({ page }, testInfo) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
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
  const attachesBefore = sockets.length;
  await page.locator("#workspace-context-full").click();
  await expect(page.locator("#workspace-terminal-region")).toBeHidden();
  await expect(page.locator("#workspace-restore")).toBeVisible();
  await page.locator("#workspace-restore").click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible();
  expect(sockets).toHaveLength(attachesBefore);
});
