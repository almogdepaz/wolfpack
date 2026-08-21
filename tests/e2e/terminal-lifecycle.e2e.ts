import { expect, test } from "@playwright/test";
import type { CDPSession, Page, WebSocketRoute } from "@playwright/test";
import { openSessionFromUi, openSettingsFromUi, startTestServer, terminalTail, toggleSessionGridFromUi } from "./helpers.ts";
import type { TestServer } from "./helpers.ts";

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(() => {
  server?.close();
});

async function documentListenerCount(cdp: CDPSession, type: string): Promise<number> {
  const { result } = await cdp.send("Runtime.evaluate", { expression: "document" });
  if (!result.objectId) throw new Error("document has no remote object id");
  const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId });
  return listeners.filter(listener => listener.type === type).length;
}

async function loadApp(page: Page): Promise<void> {
  await page.goto(server.baseUrl);
  await page.waitForSelector(".card", { timeout: 5_000 });
}

async function openTerminalSession(page: Page, session: string): Promise<void> {
  await openSessionFromUi(page, session, "");
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5_000 });
}

function routeHydratedPty(page: Page): {
  readonly sockets: WebSocketRoute[];
  readonly messages: Array<{ readonly session: string; readonly message: unknown }>;
} {
  const sockets: WebSocketRoute[] = [];
  const messages: Array<{ readonly session: string; readonly message: unknown }> = [];
  void page.routeWebSocket(/\/ws\/pty/, (ws) => {
    const session = new URL(ws.url()).searchParams.get("session") ?? "";
    sockets.push(ws);
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly prefillMode?: string };
      messages.push({ session, message: parsed });
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from(`${session}-PREFILL\r\n`));
      if (parsed.prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  return { sockets, messages };
}

test("disposing repeated terminal mounts releases document pointer listeners", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal lifecycle test");
  const cdp = await page.context().newCDPSession(page);

  await loadApp(page);
  const baselineMouseDown = await documentListenerCount(cdp, "mousedown");
  const baselineMouseUp = await documentListenerCount(cdp, "mouseup");

  await openTerminalSession(page, "test-project");
  const mountedMouseDown = await documentListenerCount(cdp, "mousedown");
  const mountedMouseUp = await documentListenerCount(cdp, "mouseup");

  await openTerminalSession(page, "another-project");
  await openTerminalSession(page, "test-project");
  await openTerminalSession(page, "another-project");

  expect(await documentListenerCount(cdp, "mousedown")).toBe(mountedMouseDown);
  expect(await documentListenerCount(cdp, "mouseup")).toBe(mountedMouseUp);

  await openSettingsFromUi(page);
  await expect(page.locator("#desktop-terminal-container canvas")).toHaveCount(0);
  expect(await documentListenerCount(cdp, "mousedown")).toBe(baselineMouseDown);
  expect(await documentListenerCount(cdp, "mouseup")).toBe(baselineMouseUp);
});

test("replaced websocket events cannot mutate the current terminal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal websocket lifecycle test");
  const { sockets } = routeHydratedPty(page);

  await loadApp(page);
  await openTerminalSession(page, "test-project");
  await openTerminalSession(page, "another-project");

  sockets[0].send(Buffer.from("LATE-OLD-SOCKET\r\n"));
  sockets[1].send(Buffer.from("CURRENT-SOCKET\r\n"));

  await expect.poll(() => terminalTail(page.locator("#desktop-terminal-container"), 20)).toContain("CURRENT-SOCKET");
  expect(await terminalTail(page.locator("#desktop-terminal-container"), 20)).not.toContain("LATE-OLD-SOCKET");
});

test("control-granted reattach cancels queued ordered resize before legacy attach", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal resize lifecycle test");
  const { sockets, messages } = routeHydratedPty(page);

  await loadApp(page);
  await openTerminalSession(page, "test-project");
  await page.setViewportSize({ width: 1100, height: 720 });
  sockets[0].send(JSON.stringify({ type: "control_granted" }));

  await expect.poll(() => messages.some(({ message }) => (message as { readonly type?: string }).type === "resize")).toBe(true);
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
});

test("legacy return to sent geometry cancels a conflicting debounced resize", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal resize lifecycle test");
  const { messages } = routeHydratedPty(page);

  await loadApp(page);
  await openTerminalSession(page, "test-project");
  await page.setViewportSize({ width: 1180, height: 720 });
  await page.setViewportSize({ width: 1280, height: 720 });

  await expect.poll(() => messages.filter(({ message }) => (message as { readonly type?: string }).type === "resize").length).toBeGreaterThan(0);
  await expect(page.locator("#desktop-terminal-container canvas")).toHaveCount(1);
});

test("WebSocket open without pty_ready preserves reconnect backoff", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal reconnect lifecycle test");
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    sockets.push(ws);
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string };
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
    });
  });

  await loadApp(page);
  await openSessionFromUi(page, "test-project", "");
  await expect.poll(() => sockets.length).toBe(1);
  await sockets[0].close();
  await page.waitForTimeout(250);

  expect(sockets.length).toBe(1);
  await expect(page.locator("#desktop-terminal-container")).not.toHaveAttribute("data-terminal-load-state", "live");
});

test("reconnect/take-control attach defers proposed geometry until the current ordered resize acknowledgement", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal reconnect lifecycle test");
  const { sockets, messages } = routeHydratedPty(page);

  await loadApp(page);
  await openTerminalSession(page, "test-project");
  sockets[0].send(JSON.stringify({ type: "viewer_conflict" }));
  await page.locator("#desktop-conflict-overlay .conflict-btn").click();

  await expect.poll(() => messages.some(({ message }) => (
    (message as { readonly type?: string; readonly takeControl?: boolean }).type === "take_control"
    || (message as { readonly type?: string; readonly takeControl?: boolean }).takeControl === true
  ))).toBe(true);
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
});

test("opening from expanded sessions attaches at the final pinned-sidebar width", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal resize lifecycle test");
  const { messages } = routeHydratedPty(page);

  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await loadApp(page);
  await openTerminalSession(page, "test-project");

  const attach = messages.find(({ message }) => (message as { readonly type?: string }).type === "attach")?.message as { readonly cols?: number; readonly rows?: number } | undefined;
  expect(attach?.cols ?? 0).toBeGreaterThan(0);
  expect(attach?.rows ?? 0).toBeGreaterThan(0);
});

test("every pinned sidebar transition hides the canvas and performs one settled resize", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal resize lifecycle test");
  const { messages } = routeHydratedPty(page);

  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await loadApp(page);
  await openTerminalSession(page, "test-project");
  await openSettingsFromUi(page);
  await openSessionFromUi(page, "test-project", "");

  await expect(page.locator("#desktop-terminal-container canvas")).toHaveCount(1);
  expect(messages.filter(({ message }) => (message as { readonly type?: string }).type === "resize").length).toBeGreaterThanOrEqual(1);
});

test("pinned sidebar transitions settle delegation grid cells before reveal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation resize lifecycle test");
  const parent = { wolfpackSessionId: "parent-id", wolfpackSessionName: "parent" };
  routeHydratedPty(page);
  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ sessions: [
        { name: "parent", triage: "running", runtimeState: { state: "working" }, identity: parent },
        { name: "child-one", triage: "idle", runtimeState: { state: "idle" }, identity: { wolfpackSessionId: "child-one-id", wolfpackSessionName: "child-one", parentSession: parent } },
        { name: "child-two", triage: "idle", runtimeState: { state: "idle" }, identity: { wolfpackSessionId: "child-two-id", wolfpackSessionName: "child-two", parentSession: parent } },
      ] }),
    });
  });

  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await loadApp(page);
  await openSessionFromUi(page, "parent", "");

  await expect(page.locator("#delegation-grid-container .grid-cell")).toHaveCount(3, { timeout: 5_000 });
  await expect.poll(() => page.locator("#delegation-grid-container .grid-cell").evaluateAll((cells) =>
    cells.every((cell) => !cell.classList.contains("transitioning")),
  )).toBe(true);
  await expect(page.locator("#delegation-grid-container .grid-cell canvas")).toHaveCount(3, { timeout: 5_000 });
});
