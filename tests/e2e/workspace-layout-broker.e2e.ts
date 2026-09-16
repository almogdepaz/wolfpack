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
  for (const name of names.slice(1)) await page.locator(`[data-action="toggle-grid"][data-session="${name}"]`).filter({ visible: true }).click();
  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(names.length, { timeout: 10_000 });
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
  await page.locator("#desktop-grid-container .grid-cell canvas").evaluateAll((canvases) => canvases.forEach((canvas, index) => canvas.setAttribute("data-workspace-canvas", String(index))));
  const attachesBefore = socketUrls.length;
  await page.locator("#workspace-terminal-layout").selectOption("lead-stack");
  await expect(grid).toHaveAttribute("style", /grid-template-columns/);
  await expect(fifth).toHaveClass(/grid-focused/);
  await page.setViewportSize({ width: 1750, height: 900 });
  await expect.poll(() => resizeFrames.some(frame => (frame.cols ?? 0) > 0 && (frame.rows ?? 0) > 0)).toBe(true);
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
  await page.locator("#workspace-restore").click();
  await expect(fifth).toHaveClass(/grid-focused/);
  expect(socketUrls).toHaveLength(attachesBefore);
});

test("real broker desktop keyboard follows the rendered narrow vertical layout", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop workspace keyboard contract");
  await page.setViewportSize({ width: 1280, height: 720 });
  const names = ["workspace-key-one", "workspace-key-two"];
  for (const name of names) await createShellSession(name);
  await openGrid(page, names);
  await page.locator("#workspace-terminal-layout").selectOption("lead-stack");
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
  await page.getByRole("button", { name: `Collapse ${child}` }).click();
  await expect(childCell).toHaveClass(/collapsed/);
  await page.getByRole("button", { name: `Expand ${child}` }).click();
  await expect(childCell).toHaveClass(/hydrated/);
  await expect(childCell.locator("canvas")).toHaveAttribute("data-workspace-collapse-canvas", "retained");
  expect(sockets).toHaveLength(attachesBefore);
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
  await expect(page.locator("#workspace-restore")).toBeVisible();
  await page.locator("#workspace-restore").click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible();
  await expect(draft).toHaveValue("retain mobile draft");
  expect(await draft.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([7, 13]);
  expect(sockets).toHaveLength(attachesBefore);
});
