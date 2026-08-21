import { expect, test, type Page } from "@playwright/test";
import { openSessionFromUi, startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

type AttachGeometry = {
  readonly cols: number;
  readonly rows: number;
};

const COPY_LINE_COUNT = 80;

async function routeCopyTerminal(page: Page): Promise<{
  readonly attachGeometry: () => AttachGeometry | undefined;
}> {
  let geometry: AttachGeometry | undefined;
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly cols?: number; readonly rows?: number; readonly prefillMode?: string };
      if (parsed.type !== "attach") return;
      geometry = {
        cols: parsed.cols ?? 80,
        rows: parsed.rows ?? 24,
      };
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(Array.from(
        { length: COPY_LINE_COUNT },
        (_, index) => `ROW_${String(index).padStart(2, "0")}_${"x".repeat(Math.max(1, Math.min((geometry?.cols ?? 80) - 8, 12)))}\r\n`,
      ).join("")));
      if (parsed.prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  return { attachGeometry: () => geometry };
}

async function selectionPoints(page: Page, geometry: AttachGeometry, visibleRow: number): Promise<{
  readonly startX: number;
  readonly endX: number;
  readonly y: number;
}> {
  const bounds = await page.locator("#desktop-terminal-container canvas").boundingBox();
  expect(bounds).not.toBeNull();
  const cellWidth = bounds!.width / geometry.cols;
  const cellHeight = bounds!.height / geometry.rows;
  return {
    startX: bounds!.x + cellWidth * 0.5,
    endX: bounds!.x + cellWidth * 6.5,
    y: bounds!.y + cellHeight * (visibleRow + 0.5),
  };
}

async function expectAttachGeometry(route: { readonly attachGeometry: () => AttachGeometry | undefined }): Promise<AttachGeometry> {
  await expect.poll(() => route.attachGeometry()).not.toBeUndefined();
  const geometry = route.attachGeometry();
  if (!geometry) throw new Error("missing attach geometry");
  return geometry;
}

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(() => {
  server?.close();
});

test("mobile copy preserves the text highlighted in scrolled-back terminal output", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("iphone"), "mobile touch selection test");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const terminalRoute = await routeCopyTerminal(page);

  await page.goto(server.baseUrl);
  await page.locator(".card", { hasText: "test-project" }).first().click();
  const canvas = page.locator("#desktop-terminal-container canvas");
  await expect(canvas).toBeVisible({ timeout: 5_000 });
  const geometry = await expectAttachGeometry(terminalRoute);

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await page.touchscreen.tap(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.evaluate(() => {
    const canvasElement = document.querySelector("#desktop-terminal-container canvas");
    if (!canvasElement) throw new Error("missing terminal canvas");
    const dispatchTouch = (type: string, y: number): void => {
      const touch = new Touch({ identifier: 1, target: canvasElement, clientX: 100, clientY: y });
      canvasElement.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === "touchend" ? [] : [touch],
        changedTouches: [touch],
      }));
    };
    dispatchTouch("touchstart", 180);
    dispatchTouch("touchmove", 430);
    dispatchTouch("touchend", 430);
  });

  const { startX, endX, y } = await selectionPoints(page, geometry, Math.min(2, geometry.rows - 1));
  await page.evaluate(({ startX, endX, y }) => {
    const canvasElement = document.querySelector("#desktop-terminal-container canvas");
    if (!(canvasElement instanceof HTMLCanvasElement)) throw new Error("missing terminal canvas");

    const dispatchTouch = (type: string, x: number): void => {
      const touch = new Touch({ identifier: 1, target: canvasElement, clientX: x, clientY: y });
      canvasElement.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === "touchend" ? [] : [touch],
        changedTouches: [touch],
      }));
    };

    dispatchTouch("touchstart", startX);
    setTimeout(() => {
      dispatchTouch("touchmove", endX);
      dispatchTouch("touchend", endX);
    }, 550);
  }, { startX, endX, y });

  await expect(page.locator(".sel-copy-btn")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/ROW_\d{2}/);
});

test("desktop copy writes the active terminal selection", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal selection test");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const terminalRoute = await routeCopyTerminal(page);

  await page.goto(server.baseUrl);
  await page.waitForSelector(".card", { timeout: 5_000 });
  await openSessionFromUi(page, "test-project", "");
  const canvas = page.locator("#desktop-terminal-container canvas");
  await expect(canvas).toBeVisible({ timeout: 5_000 });
  const geometry = await expectAttachGeometry(terminalRoute);

  const { startX, endX, y } = await selectionPoints(page, geometry, Math.min(2, geometry.rows - 1));
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(endX, y);
  await page.mouse.up();

  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/ROW_\d{2}/);
});
