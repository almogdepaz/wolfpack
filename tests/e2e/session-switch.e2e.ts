/**
 * Session switch — open drawer, switch between sessions, verify terminal updates.
 *
 * Uses mobile viewport which routes through /ws/pty unified terminal path.
 */
import { test, expect, type WebSocketRoute } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let srv: TestServer;

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  srv?.close();
});

test("open session drawer from terminal view", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only viewport tests");
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  // Navigate into a session first (drawer chip only shows in terminal view)
  const card = page.locator(".card", { hasText: "test-project" }).first();
  await card.click();
  await expect(page.locator("#terminal-view")).toBeVisible();

  // Chip should display current session name
  const chip = page.locator("#session-chip");
  await expect(chip).toBeVisible();
  await expect(page.locator("#chip-label")).toHaveText("test-project");

  // Click chip to open drawer
  await chip.click();

  const drawer = page.locator("#session-drawer");
  await expect(drawer).toHaveClass(/open/);
});

test("desktop full switchSession keeps cached snapshot hidden until hydration", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    localStorage.setItem("wp-effects", JSON.stringify({ soloPrefillMode: "full" }));
    localStorage.setItem(
      "wp-snap||another-project",
      JSON.stringify({ d: "cached-another-session", ts: Date.now() }),
    );
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#terminal-view")).toBeVisible();

  const immediateState = await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    switchSession("another-project");
    const container = document.getElementById("desktop-terminal-container");
    return {
      className: container?.className || "",
      placeholder: container?.querySelector(".cached-terminal-placeholder")?.textContent ?? "",
      loadState: container?.getAttribute("data-terminal-load-state") || "",
    };
  });

  expect(immediateState.className).not.toContain("cached-visible");
  expect(immediateState.placeholder).toBe("");
  expect(immediateState.loadState).toBe("prefill-loading");
});

async function expectSoloAttachPrefillMode(page: import("@playwright/test").Page, mode: "viewport" | "full") {
  await expect.poll(async () => page.evaluate((expectedMode) => {
    const debugWindow = window as unknown as {
      __wfTrace?: Record<string, { _meta: { session: string }; events: Array<{ kind: string; prefillMode?: string }> }>;
    };
    return Object.values(debugWindow.__wfTrace || {}).some((trace) =>
      trace._meta.session === "test-project" &&
      trace.events.some((event) => event.kind === "attach.send" && event.prefillMode === expectedMode),
    );
  }, mode), { timeout: 5000 }).toBe(true);
}

test("desktop solo saved fast still hides cached placeholder until full hydration", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wp-effects", JSON.stringify({ soloPrefillMode: "fast" }));
    localStorage.setItem("wp-snap||test-project", JSON.stringify({ d: "STALE-CACHED-LINE\n".repeat(20), ts: Date.now() }));
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  const immediateState = await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
    const container = document.getElementById("desktop-terminal-container");
    return {
      className: container?.className || "",
      placeholder: container?.querySelector(".cached-terminal-placeholder")?.textContent || "",
      loadState: container?.getAttribute("data-terminal-load-state") || "",
    };
  });

  expect(immediateState.className).not.toContain("cached-visible");
  expect(immediateState.placeholder).toBe("");
  expect(immediateState.loadState).toBe("prefill-loading");
});

test("desktop solo saved fast uses full prefill and clears cached prose", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.routeWebSocket(/\/ws\/pty/, mockPrefillWebSocket("full"));
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wp-effects", JSON.stringify({ soloPrefillMode: "fast" }));
    localStorage.setItem("wp-snap||test-project", JSON.stringify({ d: "CACHED-HISTORY-MUST-NOT-MIX\n".repeat(60), ts: Date.now() }));
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });

  await expect.poll(async () => page.evaluate(() => {
    const controller = (window as unknown as { state: { terminalController?: { term?: { buffer?: { active?: unknown } } } } }).state.terminalController;
    const buffer = controller?.term?.buffer?.active;
    if (!buffer) return "";
    return (window as unknown as { WP: { serializeBufferTail(buffer: unknown, maxLines: number): string } }).WP.serializeBufferTail(buffer, 80);
  }), { timeout: 5000 }).toContain("FULL-PREFILL");

  const tail = await page.evaluate(() => {
    const buffer = (window as unknown as { state: { terminalController?: { term?: { buffer?: { active?: unknown } } } } }).state.terminalController?.term?.buffer?.active;
    return buffer ? (window as unknown as { WP: { serializeBufferTail(buffer: unknown, maxLines: number): string } }).WP.serializeBufferTail(buffer, 80) : "";
  });
  expect(tail).not.toContain("CACHED-HISTORY-MUST-NOT-MIX");
});

test("mobile fast restore with cached snapshot requests viewport prefill without showing cached placeholder", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only restore path");

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wp-effects", JSON.stringify({ soloPrefillMode: "fast" }));
    localStorage.setItem("wp-snap||test-project", JSON.stringify({ d: "MOBILE-CACHED-PROSE\n".repeat(60), ts: Date.now() }));
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  const immediateState = await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
    const container = document.getElementById("desktop-terminal-container");
    return {
      className: container?.className || "",
      placeholder: container?.querySelector(".cached-terminal-placeholder")?.textContent || "",
      loadState: container?.getAttribute("data-terminal-load-state") || "",
    };
  });

  expect(immediateState.className).not.toContain("cached-visible");
  expect(immediateState.placeholder).toBe("");
  expect(immediateState.loadState).toBe("prefill-loading");
  await expectSoloAttachPrefillMode(page, "viewport");
});

test("desktop solo terminal defaults to full prefill", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => localStorage.setItem("wolfpackDebug", "1"));
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });

  await expectSoloAttachPrefillMode(page, "full");
});

test("solo prefill setting persists from settings UI", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    showView("settings");
  });
  await page.locator('.solo-prefill-btn[data-mode="full"]').click();

  await expect(page.locator('.solo-prefill-btn[data-mode="full"]')).toHaveClass(/active/);
  await expect.poll(async () => page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("wp-effects") || "{}");
    return settings.soloPrefillMode;
  })).toBe("full");
});

function mockPrefillWebSocket(mode: "full" | "viewport"): (ws: WebSocketRoute) => void {
  return (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { type?: string };
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(`${mode.toUpperCase()}-PREFILL-1\n`));
      setTimeout(() => ws.send(Buffer.from(`${mode.toUpperCase()}-PREFILL-2\n`)), 25);
      if (mode === "viewport") setTimeout(() => ws.send(JSON.stringify({ type: "prefill_viewport" })), 50);
      setTimeout(() => ws.send(JSON.stringify({ type: "prefill_done" })), 100);
      setTimeout(() => ws.send(JSON.stringify({ type: "pty_ready" })), 110);
    });
  };
}

test("desktop switch hides old canvas before auto-collapsing sidebar", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.routeWebSocket(/\/ws\/pty/, mockPrefillWebSocket("full"));
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wp-effects", JSON.stringify({ soloPrefillMode: "full" }));
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });

  await page.evaluate(() => {
    const stateWindow = window as unknown as { state: { sidebarAutoExpanded: boolean; sidebarCollapsed: boolean } };
    stateWindow.state.sidebarAutoExpanded = true;
    stateWindow.state.sidebarCollapsed = false;
    const sidebar = document.getElementById("desktop-sidebar");
    sidebar?.classList.remove("collapsed");
    const originalAdd = DOMTokenList.prototype.add;
    DOMTokenList.prototype.add = function (...tokens: string[]) {
      if (this === sidebar?.classList && tokens.includes("collapsed")) {
        const container = document.getElementById("desktop-terminal-container");
        const canvas = container?.querySelector("canvas");
        const canvasStyle = canvas ? getComputedStyle(canvas) : null;
        (window as unknown as { __sidebarCollapseVisualState?: unknown }).__sidebarCollapseVisualState = {
          className: container?.className || "",
          loadState: container?.getAttribute("data-terminal-load-state") || "",
          canvasVisibility: canvasStyle?.visibility || "missing",
          canvasOpacity: canvasStyle?.opacity || "missing",
        };
      }
      return originalAdd.apply(this, tokens);
    };
  });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("another-project", "");
  });

  const collapseVisualState = await page.evaluate(() => (window as unknown as { __sidebarCollapseVisualState?: unknown }).__sidebarCollapseVisualState);
  expect(collapseVisualState).toEqual(expect.objectContaining({
    loadState: "prefill-loading",
    canvasVisibility: "hidden",
    canvasOpacity: "0",
  }));
});

test("desktop switch hides old canvas before disposing previous terminal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.routeWebSocket(/\/ws\/pty/, mockPrefillWebSocket("full"));
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wp-effects", JSON.stringify({ soloPrefillMode: "full" }));
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });

  await page.evaluate(() => {
    const controller = (window as unknown as { state: { terminalController?: { dispose?: () => void } } }).state.terminalController;
    if (!controller?.dispose) throw new Error("missing terminal controller");
    const originalDispose = controller.dispose.bind(controller);
    controller.dispose = () => {
      const container = document.getElementById("desktop-terminal-container");
      const canvas = container?.querySelector("canvas");
      const canvasStyle = canvas ? getComputedStyle(canvas) : null;
      (window as unknown as { __disposeVisualState?: unknown }).__disposeVisualState = {
        className: container?.className || "",
        loadState: container?.getAttribute("data-terminal-load-state") || "",
        canvasVisibility: canvasStyle?.visibility || "missing",
        canvasOpacity: canvasStyle?.opacity || "missing",
      };
      originalDispose();
    };
  });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    switchSession("another-project");
  });

  await expect.poll(async () => page.evaluate(() =>
    (window as unknown as { __disposeVisualState?: unknown }).__disposeVisualState,
  )).not.toBeUndefined();
  const disposeVisualState = await page.evaluate(() => (window as unknown as { __disposeVisualState?: unknown }).__disposeVisualState);
  expect(disposeVisualState).toEqual(expect.objectContaining({
    loadState: "prefill-loading",
    canvasVisibility: "hidden",
    canvasOpacity: "0",
  }));
});

test("desktop keyboard session switch paints loading before terminal teardown", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.routeWebSocket(/\/ws\/pty/, mockPrefillWebSocket("full"));
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wp-effects", JSON.stringify({ soloPrefillMode: "full" }));
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });
  await expect.poll(async () => page.evaluate(() =>
    (window as unknown as { state: { allSessions: readonly unknown[] } }).state.allSessions.length,
  )).toBeGreaterThan(1);

  await page.evaluate(() => {
    const container = document.getElementById("desktop-terminal-container");
    const controller = (window as unknown as { state: { terminalController?: { dispose?: () => void } } }).state.terminalController;
    if (!container || !controller?.dispose) throw new Error("missing terminal controller");

    const originalAdd = DOMTokenList.prototype.add;
    (window as unknown as { __loadingPaintSeen?: boolean }).__loadingPaintSeen = false;
    DOMTokenList.prototype.add = function (...tokens: string[]) {
      const result = originalAdd.apply(this, tokens);
      if (this === container.classList && tokens.includes("hydrating")) {
        (window as unknown as { __loadingPaintSeen?: boolean }).__loadingPaintSeen = false;
        requestAnimationFrame(() => {
          (window as unknown as { __loadingPaintSeen?: boolean }).__loadingPaintSeen = true;
        });
      }
      return result;
    };

    const originalDispose = controller.dispose.bind(controller);
    controller.dispose = () => {
      const canvas = container.querySelector("canvas");
      const canvasStyle = canvas ? getComputedStyle(canvas) : null;
      (window as unknown as { __keyboardDisposeVisualState?: unknown }).__keyboardDisposeVisualState = {
        loadingPaintSeen: (window as unknown as { __loadingPaintSeen?: boolean }).__loadingPaintSeen === true,
        loadState: container.getAttribute("data-terminal-load-state") || "",
        canvasVisibility: canvasStyle?.visibility || "missing",
        canvasOpacity: canvasStyle?.opacity || "missing",
      };
      originalDispose();
    };
  });

  await page.keyboard.down("Meta");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Meta");

  await expect.poll(async () => page.evaluate(() =>
    (window as unknown as { __keyboardDisposeVisualState?: unknown }).__keyboardDisposeVisualState,
  )).not.toBeUndefined();
  const disposeVisualState = await page.evaluate(() => (window as unknown as { __keyboardDisposeVisualState?: unknown }).__keyboardDisposeVisualState);
  expect(disposeVisualState).toEqual(expect.objectContaining({
    loadingPaintSeen: true,
    loadState: "prefill-loading",
    canvasVisibility: "hidden",
    canvasOpacity: "0",
  }));
});

test("desktop full prefill writes chunks while hidden before prefill_done", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.routeWebSocket(/\/ws\/pty/, mockPrefillWebSocket("full"));
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wp-effects", JSON.stringify({ soloPrefillMode: "full" }));
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });

  await expect.poll(async () => page.evaluate(() => {
    const debugWindow = window as unknown as {
      __wfTrace?: Record<string, { _meta: { session: string }; events: Array<{ kind: string; bucket?: string }> }>;
    };
    const trace = Object.values(debugWindow.__wfTrace || {}).find((candidate) => candidate._meta.session === "test-project");
    if (!trace) return false;
    const prefillBinaryIndex = trace.events.findIndex((event) => event.kind === "ws.binary" && event.bucket === "prefill");
    const firstWriteIndex = trace.events.findIndex((event) => event.kind === "_writeTermData");
    const prefillDoneIndex = trace.events.findIndex((event) => event.kind === "prefill_done");
    const revealIndex = trace.events.findIndex((event) => event.kind === "hydration.reveal");
    return prefillBinaryIndex >= 0 && firstWriteIndex >= 0 && prefillDoneIndex >= 0 && revealIndex >= 0;
  }), { timeout: 5000 }).toBe(true);

  const order = await page.evaluate(() => {
    const debugWindow = window as unknown as {
      __wfTrace?: Record<string, { _meta: { session: string }; events: Array<{ kind: string; bucket?: string }> }>;
    };
    const trace = Object.values(debugWindow.__wfTrace || {}).find((candidate) => candidate._meta.session === "test-project");
    if (!trace) throw new Error("missing trace");
    return {
      prefillBinaryIndex: trace.events.findIndex((event) => event.kind === "ws.binary" && event.bucket === "prefill"),
      firstWriteIndex: trace.events.findIndex((event) => event.kind === "_writeTermData"),
      prefillDoneIndex: trace.events.findIndex((event) => event.kind === "prefill_done"),
      revealIndex: trace.events.findIndex((event) => event.kind === "hydration.reveal"),
    };
  });

  expect(order.prefillBinaryIndex).toBeGreaterThanOrEqual(0);
  expect(order.firstWriteIndex).toBeGreaterThan(order.prefillBinaryIndex);
  expect(order.firstWriteIndex).toBeLessThan(order.prefillDoneIndex);
  expect(order.revealIndex).toBeGreaterThan(order.prefillDoneIndex);
});

test("desktop saved fast still uses full prefill", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wp-effects", JSON.stringify({ soloPrefillMode: "fast" }));
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  const desktopSettingState = await page.evaluate(() => ({
    fastActive: document.querySelector('.solo-prefill-btn[data-mode="fast"]')?.classList.contains("active") ?? false,
    fullActive: document.querySelector('.solo-prefill-btn[data-mode="full"]')?.classList.contains("active") ?? false,
    fastDisabled: (document.querySelector('.solo-prefill-btn[data-mode="fast"]') as HTMLButtonElement | null)?.disabled ?? false,
  }));
  expect(desktopSettingState).toEqual({ fastActive: false, fullActive: true, fastDisabled: true });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });

  await expectSoloAttachPrefillMode(page, "full");
});

test("desktop solo terminal full setting requests full prefill", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wp-effects", JSON.stringify({ soloPrefillMode: "full" }));
  });
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });

  await expectSoloAttachPrefillMode(page, "full");
});

