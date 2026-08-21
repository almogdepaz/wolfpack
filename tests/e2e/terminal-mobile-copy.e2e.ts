import { expect, test, type Page } from "@playwright/test";
import { openSessionFromUi, startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

type AttachGeometry = {
  readonly cols: number;
  readonly rows: number;
};

type CopyRoute = {
  readonly attachGeometry: () => AttachGeometry | undefined;
  readonly lineCount: () => number | undefined;
};

const SCROLLBACK_ROWS_FOR_COPY = 5;

function rowLabel(index: number): string {
  return `ROW_${String(index).padStart(2, "0")}`;
}

function copiedTerminalText(text: string): string {
  return text.replace(/\r?\n$/, "");
}

async function routeCopyTerminal(page: Page): Promise<CopyRoute> {
  let geometry: AttachGeometry | undefined;
  let lineCount: number | undefined;
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly cols?: number; readonly rows?: number; readonly prefillMode?: string };
      if (parsed.type !== "attach") return;
      geometry = {
        cols: parsed.cols ?? 80,
        rows: parsed.rows ?? 24,
      };
      lineCount = geometry.rows + 10;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(Array.from(
        { length: lineCount },
        (_, index) => `${rowLabel(index)}\r\n`,
      ).join("")));
      if (parsed.prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  return { attachGeometry: () => geometry, lineCount: () => lineCount };
}

async function selectionPoints(page: Page, geometry: AttachGeometry, visibleRow: number, columns: number): Promise<{
  readonly startX: number;
  readonly endX: number;
  readonly y: number;
  readonly cellHeight: number;
}> {
  const bounds = await page.locator("#desktop-terminal-container canvas").boundingBox();
  expect(bounds).not.toBeNull();
  const cellWidth = bounds!.width / geometry.cols;
  const cellHeight = bounds!.height / geometry.rows;
  return {
    startX: bounds!.x + 1,
    endX: bounds!.x + cellWidth * columns - 1,
    y: bounds!.y + cellHeight * (visibleRow + 0.5),
    cellHeight,
  };
}

async function expectCopyRoute(route: CopyRoute): Promise<{ readonly geometry: AttachGeometry; readonly lineCount: number }> {
  await expect.poll(() => route.attachGeometry()).not.toBeUndefined();
  const geometry = route.attachGeometry();
  const lineCount = route.lineCount();
  if (!geometry || !lineCount) throw new Error("missing attach geometry");
  return { geometry, lineCount };
}

async function touchDragTerminal(page: Page, startY: number, endY: number): Promise<void> {
  await page.evaluate(({ startY, endY }) => {
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
    dispatchTouch("touchstart", startY);
    dispatchTouch("touchmove", endY);
    dispatchTouch("touchend", endY);
  }, { startY, endY });
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
  const { geometry, lineCount } = await expectCopyRoute(terminalRoute);

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  // Matches the original 20x5 fixture: 30 streamed rows, scroll back 5 => ROW_21.
  const firstVisibleRow = lineCount - geometry.rows + 1;
  const expectedRow = firstVisibleRow - SCROLLBACK_ROWS_FOR_COPY;
  const { startX, endX, y, cellHeight } = await selectionPoints(page, geometry, 0, rowLabel(expectedRow).length);
  await page.touchscreen.tap(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await touchDragTerminal(page, y + cellHeight * 2, y + cellHeight * (2 + SCROLLBACK_ROWS_FOR_COPY));

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
  await expect.poll(async () => copiedTerminalText(await page.evaluate(() => navigator.clipboard.readText()))).toBe(rowLabel(expectedRow));
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
  const { geometry, lineCount } = await expectCopyRoute(terminalRoute);
  // Matches the original 20x5 fixture's bottom-first row formula.
  const firstVisibleRow = lineCount - geometry.rows + 1;
  const expectedLabel = rowLabel(firstVisibleRow);

  const shortSelection = await selectionPoints(page, geometry, 0, 3);
  await page.mouse.move(shortSelection.startX, shortSelection.y);
  await page.mouse.down();
  await page.mouse.move(shortSelection.endX, shortSelection.y);
  await page.mouse.up();
  await page.keyboard.press("Control+c");
  const shortCopy = copiedTerminalText(await page.evaluate(() => navigator.clipboard.readText()));
  expect(shortCopy).toBe(expectedLabel.slice(0, 3));

  const fullSelection = await selectionPoints(page, geometry, 0, expectedLabel.length);
  await page.mouse.move(fullSelection.startX, fullSelection.y);
  await page.mouse.down();
  await page.mouse.move(fullSelection.endX, fullSelection.y);
  await page.mouse.up();
  await page.keyboard.press("Control+c");
  const fullCopy = copiedTerminalText(await page.evaluate(() => navigator.clipboard.readText()));
  expect(fullCopy.length).toBeGreaterThan(shortCopy.length);
  expect(fullCopy).toBe(expectedLabel);
});
