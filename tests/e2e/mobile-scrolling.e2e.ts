import { expect, test, type Page } from "@playwright/test";
import { startTestServer, terminalTail, type TestServer } from "./helpers.ts";

let srv: TestServer;

const HISTORY_LINE_COUNT = 160;

type AttachGeometry = {
  readonly cols: number;
  readonly rows: number;
};

type CanvasSnapshot = {
  readonly data: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly pixelRowHeight: number;
  readonly cssRowHeight: number;
};

function historyLine(prefix: string, index: number): string {
  return `${prefix}-${index}`;
}

async function canvasSnapshot(page: Page, geometry: AttachGeometry): Promise<CanvasSnapshot> {
  return page.locator("#desktop-terminal-container canvas").evaluate((element, rows) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("missing canvas context");
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(canvas.width * 0.2);
    const width = Math.max(1, Math.floor(canvas.width * 0.6));
    const height = Math.max(1, Math.floor(canvas.height * 0.75));
    return {
      data: Array.from(context.getImageData(x, 0, width, height).data),
      width,
      height,
      pixelRowHeight: canvas.height / rows,
      cssRowHeight: rect.height / rows,
    };
  }, geometry.rows);
}

function averageMismatchAtShift(before: CanvasSnapshot, after: CanvasSnapshot, rowShift: number): number {
  const shiftPixels = Math.round(before.pixelRowHeight * rowShift);
  const overlapHeight = before.height - shiftPixels;
  if (overlapHeight <= 0) return Number.POSITIVE_INFINITY;
  const rowStride = before.width * 4;
  const mismatch = (beforeOffsetRows: number, afterOffsetRows: number): number => {
    let total = 0;
    let samples = 0;
    const beforeOffset = beforeOffsetRows * rowStride;
    const afterOffset = afterOffsetRows * rowStride;
    const length = overlapHeight * rowStride;
    for (let index = 0; index < length; index += 4) {
      total += Math.abs(before.data[beforeOffset + index] - after.data[afterOffset + index]);
      total += Math.abs(before.data[beforeOffset + index + 1] - after.data[afterOffset + index + 1]);
      total += Math.abs(before.data[beforeOffset + index + 2] - after.data[afterOffset + index + 2]);
      samples += 3;
    }
    return total / Math.max(1, samples);
  };
  return Math.min(mismatch(shiftPixels, 0), mismatch(0, shiftPixels));
}

function renderedRowDisplacement(before: CanvasSnapshot, after: CanvasSnapshot, dragDistance: number): number {
  if (before.width !== after.width || before.height !== after.height) throw new Error("canvas snapshot dimensions changed");
  const expectedRows = Math.trunc(dragDistance / before.cssRowHeight);
  const maxRows = Math.min(Math.floor(before.height / before.pixelRowHeight) - 1, expectedRows + 6);
  let best = { rows: 0, mismatch: averageMismatchAtShift(before, after, 0) };
  for (let rows = 1; rows <= maxRows; rows += 1) {
    const mismatch = averageMismatchAtShift(before, after, rows);
    if (mismatch < best.mismatch) best = { rows, mismatch };
  }
  return best.rows;
}

async function openMobileTerminalWithHistory(page: Page): Promise<AttachGeometry> {
  let geometry: AttachGeometry | undefined;
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { readonly type?: string; readonly cols?: number; readonly rows?: number };
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.type !== "attach") return;
      geometry = { cols: parsed.cols ?? 80, rows: parsed.rows ?? 24 };
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(Array.from(
        { length: HISTORY_LINE_COUNT },
        (_, index) => `${historyLine("history", index)}\r\n`,
      ).join("")));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.locator(".card", { hasText: "test-project" }).first().click();
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute(
    "data-terminal-load-state",
    "live",
    { timeout: 5000 },
  );
  await expect.poll(() => terminalTail(page.locator("#desktop-terminal-container"), 80)).toContain("history-");
  if (!geometry) throw new Error("missing attach geometry");
  return geometry;
}

async function dragTerminal(page: Page, startY: number, endY: number): Promise<void> {
  await page.evaluate(({ startY, endY }) => {
    const canvas = document.querySelector("#desktop-terminal-container canvas");
    if (!canvas) throw new Error("missing mobile terminal");

    const dispatchTouch = (type: string, clientY: number): void => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value: type === "touchend" ? [] : [{ clientX: 100, clientY }],
      });
      canvas.dispatchEvent(event);
    };

    dispatchTouch("touchstart", startY);
    dispatchTouch("touchmove", endY);
    dispatchTouch("touchend", endY);
  }, { startY, endY });
}

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  srv?.close();
});

test("first mobile session opens with touch-scrollable history", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only first-open path");

  let geometry: AttachGeometry | undefined;
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { readonly type?: string; readonly cols?: number; readonly prefillMode?: string; readonly rows?: number };
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.type !== "attach") return;
      geometry = { cols: parsed.cols ?? 80, rows: parsed.rows ?? 24 };
      const prefillMode = parsed.prefillMode ?? "full";
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(Array.from(
        { length: HISTORY_LINE_COUNT },
        (_, index) => `${historyLine("first-open-history", index)}\r\n`,
      ).join("")));
      if (prefillMode === "viewport") {
        ws.send(JSON.stringify({ type: "prefill_viewport" }));
      }
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.locator(".card", { hasText: "test-project" }).first().click();
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute(
    "data-terminal-load-state",
    "live",
    { timeout: 5000 },
  );

  if (!geometry) throw new Error("missing attach geometry");
  const dragDistance = 170;
  const before = await canvasSnapshot(page, geometry);
  await dragTerminal(page, 200, 200 + dragDistance);
  const after = await canvasSnapshot(page, geometry);
  expect(renderedRowDisplacement(before, after, dragDistance)).toBeGreaterThanOrEqual(
    Math.trunc(dragDistance / before.cssRowHeight),
  );
});

test("mobile touch drag scrolls at least one history row per rendered row", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only touch path");
  const geometry = await openMobileTerminalWithHistory(page);

  const dragDistance = 170;
  const before = await canvasSnapshot(page, geometry);
  await dragTerminal(page, 200, 200 + dragDistance);
  const after = await canvasSnapshot(page, geometry);

  expect(renderedRowDisplacement(before, after, dragDistance)).toBeGreaterThanOrEqual(
    Math.trunc(dragDistance / before.cssRowHeight),
  );
});

test("opening the mobile keyboard returns the terminal to latest output", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only keyboard behavior");
  const geometry = await openMobileTerminalWithHistory(page);

  const latestBottom = await canvasSnapshot(page, geometry);
  await dragTerminal(page, 200, 370);
  expect(await canvasSnapshot(page, geometry)).not.toEqual(latestBottom);

  await page.locator("#kb-open-btn").click();
  await expect(page.locator("#desktop-terminal-container textarea")).toBeFocused();
  await expect.poll(() => canvasSnapshot(page, geometry)).toEqual(latestBottom);
});
