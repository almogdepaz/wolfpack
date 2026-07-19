/**
 * Session switch — open drawer, switch between sessions, verify terminal updates.
 *
 * Uses mobile viewport which routes through /ws/pty unified terminal path.
 */
import { test, expect, type WebSocketRoute } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";
import { CLOSE_CODE_PREFILL_TIMEOUT, WS_CLOSE_REASONS } from "../../src/ws-constants.ts";

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

test("mobile touch scrolling works immediately after switching sessions", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only touch path");

  const attachModes: string[] = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { type?: string; prefillMode?: string };
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.type !== "attach") return;
      const prefillMode = parsed.prefillMode || "full";
      attachModes.push(prefillMode);
      const lineCount = prefillMode === "full" ? 120 : 12;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(Array.from({ length: lineCount }, (_, index) => `history-${index}\r\n`).join("")));
      if (prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    switchSession("another-project");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });
  await expect.poll(() => attachModes).toEqual(["full", "full"]);
  await expect.poll(() => page.evaluate(() => {
    const terminal = (window as unknown as { state: { terminalController?: { term?: { getScrollbackLength?: () => number } } } }).state.terminalController?.term;
    return terminal?.getScrollbackLength?.() ?? 0;
  })).toBeGreaterThan(0);

  const viewportY = await page.evaluate(() => {
    const container = document.getElementById("desktop-terminal-container");
    const canvas = container?.querySelector("canvas");
    const terminal = (window as unknown as { state: { terminalController?: { term?: { viewportY: number } } } }).state.terminalController?.term;
    if (!container || !canvas || !terminal) throw new Error("missing mobile terminal");
    const dispatchTouch = (type: string, clientY: number): void => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value: type === "touchend" ? [] : [{ clientX: 100, clientY }],
      });
      canvas.dispatchEvent(event);
    };
    dispatchTouch("touchstart", 300);
    dispatchTouch("touchmove", 500);
    dispatchTouch("touchend", 500);
    return terminal.viewportY;
  });

  expect(viewportY).toBeGreaterThan(0);
  await expect(page.locator("#mobile-kb-proxy")).not.toBeFocused();
});

test("full session switch and reconnect keep partial prefill hidden until prefill_done", async ({ page }) => {
  let switchedPrefillMode = "";
  let switchedFullAttachCount = 0;
  let latestFullPrefillDone = true;
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    const session = new URL(ws.url()).searchParams.get("session");
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { readonly type?: string; readonly prefillMode?: string };
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.type !== "attach") return;
      const prefillMode = parsed.prefillMode || "full";
      ws.send(JSON.stringify({ type: "attach_ack" }));
      if (session === "test-project") {
        ws.send(Buffer.from("INITIAL-SESSION\r\n"));
        if (prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
        return;
      }

      switchedPrefillMode = prefillMode;
      if (prefillMode === "viewport") {
        ws.send(Buffer.from("SWITCHED-VIEWPORT\r\n"));
        ws.send(JSON.stringify({ type: "prefill_viewport" }));
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
        return;
      }

      switchedFullAttachCount++;
      latestFullPrefillDone = false;
      ws.send(Buffer.from("SWITCHED-PARTIAL-1\r\n"));
      setTimeout(() => ws.send(Buffer.from("SWITCHED-PARTIAL-2\r\n")), 2500);
      setTimeout(() => {
        latestFullPrefillDone = true;
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
      }, 5000);
    });
  });
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.evaluate(() => localStorage.setItem("wolfpackDebug", "1"));
  await page.reload();
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5000 });

  await page.evaluate(() => {
    const debugWindow = window as unknown as {
      __fullPrefillEarlyReveal?: boolean;
      __wfTrace?: Record<string, {
        readonly _meta: { readonly session: string };
        readonly events: ReadonlyArray<{ readonly kind: string; readonly prefillMode?: string }>;
      }>;
    };
    debugWindow.__fullPrefillEarlyReveal = false;
    const observe = (): void => {
      const trace = Object.values(debugWindow.__wfTrace || {}).find(candidate => candidate._meta.session === "another-project");
      const fullPrefill = trace?.events.some(event => event.kind === "attach.send" && event.prefillMode === "full") ?? false;
      const prefillDone = trace?.events.some(event => event.kind === "prefill_done") ?? false;
      const canvas = document.querySelector("#desktop-terminal-container canvas");
      const style = canvas ? getComputedStyle(canvas) : null;
      if (fullPrefill && !prefillDone && style?.visibility === "visible" && style.opacity === "1") {
        debugWindow.__fullPrefillEarlyReveal = true;
      }
      if (!prefillDone) requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
    // @ts-ignore exposed by the browser bundle
    switchSession("another-project");
  });

  await expect.poll(() => switchedPrefillMode).not.toBe("");
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 7000 });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as unknown as { __fullPrefillEarlyReveal?: boolean }).__fullPrefillEarlyReveal)).toBe(false);

  if (switchedPrefillMode !== "full") return;
  await page.evaluate(() => {
    const controller = (window as unknown as { state: { terminalController?: { reconnect(): void } } }).state.terminalController;
    if (!controller) throw new Error("missing terminal controller");
    controller.reconnect();
  });
  await expect.poll(() => switchedFullAttachCount).toBe(2);
  await page.waitForTimeout(4200);
  expect(latestFullPrefillDone).toBe(false);
  const reconnectVisualState = await page.evaluate(() => {
    const container = document.getElementById("desktop-terminal-container");
    const canvas = container?.querySelector("canvas");
    const style = canvas ? getComputedStyle(canvas) : null;
    return {
      loadState: container?.getAttribute("data-terminal-load-state") || "",
      visibility: style?.visibility || "missing",
      opacity: style?.opacity || "missing",
    };
  });
  expect(reconnectVisualState).toEqual({
    loadState: "hydrating",
    visibility: "hidden",
    opacity: "0",
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 3000 });
});

test("viewer conflict force-finishes hydration without prefill completion", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only conflict overlay path");

  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string };
      if (parsed.type === "attach") ws.send(JSON.stringify({ type: "viewer_conflict" }));
    });
  });
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });

  await expect(page.locator("#desktop-conflict-overlay")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const controller = (window as unknown as {
      state: { terminalController?: { hydration?: { readonly pending: boolean } } };
    }).state.terminalController;
    return controller?.hydration?.pending ?? null;
  })).toBe(false);
});

test("single take-control retries with takeover attach when control_granted stalls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only conflict overlay path");

  const attaches: Array<{ readonly takeControl?: boolean }> = [];
  let takeControlMessages = 0;
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly takeControl?: boolean };
      if (parsed.type === "attach") {
        attaches.push({ takeControl: parsed.takeControl });
        if (!parsed.takeControl) ws.send(JSON.stringify({ type: "viewer_conflict" }));
      } else if (parsed.type === "take_control") {
        takeControlMessages++;
      }
    });
  });
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.clock.install();

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-conflict-overlay")).toBeVisible();
  await page.locator("#desktop-conflict-overlay button").click();
  await expect.poll(() => takeControlMessages).toBe(1);

  await page.clock.fastForward(3_100);
  await expect.poll(() => attaches.some(({ takeControl }) => takeControl === true)).toBe(true);
});

test("full prefill timeout closes the stalled socket instead of revealing partial content", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one browser profile covers the socket deadline");

  const closes: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly prefillMode?: string };
      if (parsed.type !== "attach") return;
      expect(parsed.prefillMode).toBe("full");
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from("PARTIAL-PREFILL-WITHOUT-DONE\r\n"));
    });
    ws.onClose((code, reason) => {
      closes.push({ code, reason });
      void ws.close({ code, reason });
    });
  });
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  await page.clock.install();

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "prefill-loading");

  await page.clock.fastForward(16_000);
  expect(closes).toContainEqual({
    code: CLOSE_CODE_PREFILL_TIMEOUT,
    reason: WS_CLOSE_REASONS.PREFILL_TIMEOUT,
  });
  const visualState = await page.evaluate(() => {
    const container = document.getElementById("desktop-terminal-container");
    const canvas = container?.querySelector("canvas");
    const style = canvas ? getComputedStyle(canvas) : null;
    return {
      visibility: style?.visibility || "missing",
      opacity: style?.opacity || "missing",
    };
  });
  expect(visualState).toEqual({ visibility: "hidden", opacity: "0" });
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

test("mobile first-session restore overrides fast mode with full prefill without showing cached placeholder", async ({ page }, testInfo) => {
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
  await expectSoloAttachPrefillMode(page, "full");
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

test("desktop terminal sends layout_stable after attach ack", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  const messages: Array<{ type?: string; cols?: number; rows?: number }> = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { type?: string; cols?: number; rows?: number };
      try { parsed = JSON.parse(message); } catch { return; }
      messages.push(parsed);
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from("FULL-PREFILL\n"));
      setTimeout(() => ws.send(JSON.stringify({ type: "prefill_done" })), 30);
      setTimeout(() => ws.send(JSON.stringify({ type: "pty_ready" })), 40);
    });
  });
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

  await expect.poll(() => messages.some((message) => message.type === "layout_stable"), { timeout: 5000 }).toBe(true);
  const stableIndex = messages.findIndex((message) => message.type === "layout_stable");
  const stable = messages[stableIndex];
  const latestSizeMessage = messages
    .slice(0, stableIndex)
    .filter((message) => message.type === "attach" || message.type === "resize")
    .at(-1);
  expect(stable).toEqual(expect.objectContaining({ cols: latestSizeMessage?.cols, rows: latestSizeMessage?.rows }));
});

test("desktop sidebar hover does not put live terminal into loading state", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only sidebar path");

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

  const hoverState = await page.evaluate(() => {
    const stateWindow = window as unknown as { state: { sidebarResizeDone: boolean; sidebarCollapsed: boolean; sidebarPinned: boolean; sessionsExpanded: boolean } };
    stateWindow.state.sidebarResizeDone = false;
    stateWindow.state.sidebarCollapsed = true;
    stateWindow.state.sidebarPinned = false;
    stateWindow.state.sessionsExpanded = false;
    const sidebar = document.getElementById("desktop-sidebar");
    sidebar?.classList.add("collapsed");
    document.body.classList.remove("sidebar-pinned", "sessions-expanded");
    document.getElementById("sidebar-hover-edge")?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    const container = document.getElementById("desktop-terminal-container");
    const canvas = container?.querySelector("canvas");
    const canvasStyle = canvas ? getComputedStyle(canvas) : null;
    return {
      className: container?.className || "",
      loadState: container?.getAttribute("data-terminal-load-state") || "",
      canvasVisibility: canvasStyle?.visibility || "missing",
      canvasOpacity: canvasStyle?.opacity || "missing",
    };
  });

  expect(hoverState.className).not.toContain("transitioning");
  expect(hoverState.loadState).toBe("live");
  expect(hoverState.canvasVisibility).toBe("visible");
  expect(hoverState.canvasOpacity).toBe("1");
});

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

test("desktop full prefill records hydration timing after prefill_done", async ({ page }, testInfo) => {
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

  const timing = await page.evaluate(() => {
    const debugWindow = window as unknown as {
      __wfTrace?: Record<string, { _meta: { session: string }; events: Array<{ kind: string; t: number }> }>;
    };
    const trace = Object.values(debugWindow.__wfTrace || {}).find((candidate) => candidate._meta.session === "test-project");
    if (!trace) throw new Error("missing trace");
    const at = (kind: string) => trace.events.find((event) => event.kind === kind)?.t;
    const prefillDone = at("prefill_done");
    const hydrationFinish = at("hydration.finish");
    if (prefillDone === undefined || hydrationFinish === undefined) throw new Error("missing hydration timing events");
    return {
      prefillDone,
      hydrationFinish,
      delta: +(hydrationFinish - prefillDone).toFixed(1),
    };
  });

  expect(timing.hydrationFinish).toBeGreaterThan(timing.prefillDone);
  expect(timing.delta).toBeLessThan(1000);
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

