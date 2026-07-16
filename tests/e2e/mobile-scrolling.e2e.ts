import { expect, test, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let srv: TestServer;

const HISTORY_LINE_COUNT = 160;

interface MobileTerminalState {
  readonly viewportY: number;
  readonly rowHeight: number;
}

async function openMobileTerminalWithHistory(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("wp-effects", JSON.stringify({ soloPrefillMode: "full" }));
  });
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
  await expect.poll(() => page.evaluate(() => {
    const terminal = (window as unknown as {
      state: { terminalController?: { term?: { getScrollbackLength?: () => number } } };
    }).state.terminalController?.term;
    return terminal?.getScrollbackLength?.() ?? 0;
  })).toBeGreaterThan(0);
}

async function dragTerminal(page: Page, startY: number, endY: number): Promise<MobileTerminalState> {
  return page.evaluate(({ startY, endY }) => {
    const container = document.getElementById("desktop-terminal-container");
    const canvas = container?.querySelector("canvas");
    const terminal = (window as unknown as {
      state: {
        terminalController?: {
          term?: {
            readonly viewportY: number;
            readonly renderer?: { getMetrics?: () => { readonly height: number } };
          };
        };
      };
    }).state.terminalController?.term;
    if (!canvas || !terminal) throw new Error("missing mobile terminal");

    const dispatchTouch = (type: string, clientY: number): void => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value: type === "touchend" ? [] : [{ clientX: 100, clientY }],
      });
      canvas.dispatchEvent(event);
    };

    dispatchTouch("touchstart", startY);
    dispatchTouch("touchmove", endY);
    const state = {
      viewportY: terminal.viewportY,
      rowHeight: terminal.renderer?.getMetrics?.().height ?? 17,
    };
    dispatchTouch("touchend", endY);
    return state;
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

  const terminalState = await dragTerminal(page, 200, 370);
  expect(terminalState.viewportY).toBeGreaterThan(0);
});

test("mobile touch drag scrolls at least one history row per rendered row", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only touch path");
  await openMobileTerminalWithHistory(page);

  const dragDistance = 170;
  const terminalState = await dragTerminal(page, 200, 200 + dragDistance);
  const expectedRows = Math.trunc(dragDistance / terminalState.rowHeight);

  expect(terminalState.viewportY).toBeGreaterThanOrEqual(expectedRows);
});

test("opening the mobile keyboard returns the terminal to latest output", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only keyboard behavior");
  await openMobileTerminalWithHistory(page);

  const scrolledState = await dragTerminal(page, 200, 370);
  expect(scrolledState.viewportY).toBeGreaterThan(0);

  await page.locator("#kb-open-btn").click();
  await expect(page.locator("#mobile-kb-proxy")).toBeFocused();
  await expect.poll(() => page.evaluate(() => {
    const terminal = (window as unknown as {
      state: { terminalController?: { term?: { readonly viewportY: number } } };
    }).state.terminalController?.term;
    return terminal?.viewportY ?? -1;
  })).toBe(0);
});
