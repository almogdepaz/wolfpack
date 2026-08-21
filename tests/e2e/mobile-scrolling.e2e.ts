import { expect, test, type Page } from "@playwright/test";
import { startTestServer, terminalTail, type TestServer } from "./helpers.ts";

let srv: TestServer;

const HISTORY_LINE_COUNT = 160;

type CanvasRegion = readonly number[];

async function canvasRegion(page: Page, verticalStart: number, verticalEnd: number): Promise<CanvasRegion> {
  return page.locator("#desktop-terminal-container canvas").evaluate((element, region) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("missing canvas context");
    const y = Math.max(0, Math.floor(canvas.height * region.start));
    const height = Math.max(1, Math.floor(canvas.height * (region.end - region.start)));
    return Array.from(context.getImageData(0, y, canvas.width, height).data);
  }, { start: verticalStart, end: verticalEnd });
}

async function openMobileTerminalWithHistory(page: Page): Promise<void> {
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { readonly type?: string };
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(Array.from(
        { length: HISTORY_LINE_COUNT },
        (_, index) => `history-${index}\r\n`,
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

  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { readonly type?: string; readonly prefillMode?: string; readonly rows?: number };
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.type !== "attach") return;
      const prefillMode = parsed.prefillMode ?? "full";
      const viewportRows = Math.max(1, (parsed.rows ?? 24) - 1);
      const lineCount = prefillMode === "full" ? HISTORY_LINE_COUNT : viewportRows;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(Array.from(
        { length: lineCount },
        (_, index) => `first-open-history-${index}\r\n`,
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

  const before = await canvasRegion(page, 0, 0.25);
  await dragTerminal(page, 200, 370);
  const after = await canvasRegion(page, 0, 0.25);
  expect(after).not.toEqual(before);
});

test("mobile touch drag scrolls at least one history row per rendered row", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only touch path");
  await openMobileTerminalWithHistory(page);

  const before = await canvasRegion(page, 0, 0.35);
  await dragTerminal(page, 200, 370);
  const after = await canvasRegion(page, 0, 0.35);

  expect(after).not.toEqual(before);
});

test("opening the mobile keyboard returns the terminal to latest output", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only keyboard behavior");
  await openMobileTerminalWithHistory(page);

  const latestBottom = await canvasRegion(page, 0.72, 1);
  await dragTerminal(page, 200, 370);
  expect(await canvasRegion(page, 0.72, 1)).not.toEqual(latestBottom);

  await page.locator("#kb-open-btn").click();
  await expect(page.locator("#desktop-terminal-container textarea")).toBeFocused();
  await expect.poll(() => canvasRegion(page, 0.72, 1)).toEqual(latestBottom);
});
