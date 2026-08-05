import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(() => {
  server?.close();
});

test("mobile copy preserves the text highlighted in scrolled-back terminal output", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("iphone"), "mobile touch selection test");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto(server.baseUrl);
  await page.locator(".card", { hasText: "test-project" }).first().click();
  const canvas = page.locator("#desktop-terminal-container canvas");
  await expect(canvas).toBeVisible({ timeout: 5_000 });

  await page.evaluate(() => {
    const term = (window as unknown as {
      state: { terminalController?: { term?: { reset(): void; resize(cols: number, rows: number): void; write(data: string): void; scrollToLine(line: number): void } } };
    }).state.terminalController?.term;
    if (!term) throw new Error("missing terminal");
    term.reset();
    term.resize(20, 5);
    term.write(Array.from({ length: 30 }, (_, index) => `ROW_${String(index).padStart(2, "0")}\r\n`).join(""));
    term.scrollToLine(5);
  });

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const startX = bounds!.x + 1;
  const endX = bounds!.x + (bounds!.width / 20) * 6 - 1;
  const y = bounds!.y + (bounds!.height / 5) / 2;

  await page.evaluate(({ startX, endX, y }) => {
    const canvas = document.querySelector("#desktop-terminal-container canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("missing terminal canvas");

    const dispatchTouch = (type: string, x: number): void => {
      const touch = new Touch({ identifier: 1, target: canvas, clientX: x, clientY: y });
      canvas.dispatchEvent(new TouchEvent(type, {
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
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/_?21$/);
});

test("desktop copy writes the active terminal selection", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal selection test");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto(server.baseUrl);
  await page.waitForSelector(".card", { timeout: 5_000 });
  await page.evaluate(() => {
    // @ts-ignore browser bundle global
    openSession("test-project", "");
  });
  const canvas = page.locator("#desktop-terminal-container canvas");
  await expect(canvas).toBeVisible({ timeout: 5_000 });

  await page.evaluate(() => {
    const term = (window as unknown as {
      state: { terminalController?: { term?: { reset(): void; resize(cols: number, rows: number): void; write(data: string): void; scrollToLine(line: number): void } } };
    }).state.terminalController?.term;
    if (!term) throw new Error("missing terminal");
    term.reset();
    term.resize(20, 5);
    term.write(Array.from({ length: 30 }, (_, index) => `ROW_${String(index).padStart(2, "0")}\r\n`).join(""));
    term.scrollToLine(5);
  });

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const startX = bounds!.x + 1;
  const endX = bounds!.x + (bounds!.width / 20) * 6 - 1;
  const y = bounds!.y + (bounds!.height / 5) / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(endX, y);
  await page.mouse.up();

  const selected = await page.evaluate(() => {
    const term = (window as unknown as {
      state: { terminalController?: { term?: { getSelection(): string } } };
    }).state.terminalController?.term;
    return term?.getSelection() ?? "";
  });
  expect(selected).toMatch(/_?21$/);

  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selected);
});
