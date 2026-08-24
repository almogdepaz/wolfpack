import { expect, test } from "@playwright/test";
import type { CDPSession, Page, WebSocketRoute } from "@playwright/test";
import { openSessionFromUi, openSettingsFromUi, startTestServer, terminalTail } from "./helpers.ts";
import type { TestServer } from "./helpers.ts";
import { CLOSE_CODE_DISPLACED, WS_CLOSE_REASONS } from "../../src/ws-constants.ts";

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

function latestMessage<T extends { readonly type?: string }>(messages: readonly T[], type: string): T | undefined {
  return messages.filter((message) => message.type === type).at(-1);
}

function terminalHiddenBeforeResizeSettlement(page: Page): ReturnType<Page["evaluateHandle"]> {
  return page.evaluateHandle(() => new Promise<boolean>((resolve) => {
    const terminal = document.getElementById("desktop-terminal-container");
    if (!terminal) throw new Error("missing terminal container");
    if (terminal.classList.contains("transitioning")) {
      resolve(true);
      return;
    }
    const observer = new MutationObserver(() => {
      if (!terminal.classList.contains("transitioning")) return;
      observer.disconnect();
      resolve(true);
    });
    observer.observe(terminal, { attributes: true, attributeFilter: ["class"] });
  }));
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
  const messages: Array<{ readonly type?: string; readonly resizeId?: number; readonly cols?: number; readonly rows?: number }> = [];
  const sockets: WebSocketRoute[] = [];
  let withholdNextResizeAck = false;

  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    sockets.push(ws);
    let attachCount = 0;
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly resizeId?: number; readonly cols?: number; readonly rows?: number };
      messages.push(parsed);
      if (parsed.type === "attach") {
        attachCount++;
        ws.send(JSON.stringify(attachCount === 1
          ? { type: "attach_ack", capabilities: ["ordered-resize-ack"] }
          : { type: "attach_ack" }));
        ws.send(Buffer.from(attachCount === 1 ? "INITIAL\r\n" : "LEGACY-ATTACH-OUTPUT\r\n"));
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
        return;
      }
      if (parsed.type === "resize" && typeof parsed.resizeId === "number" && !withholdNextResizeAck) {
        ws.send(JSON.stringify({ ...parsed, type: "resize_ack" }));
      }
    });
  });

  await loadApp(page);
  await openTerminalSession(page, "test-project");
  const resizeBaseline = messages.filter((message) => message.type === "resize").length;
  withholdNextResizeAck = true;
  await page.setViewportSize({ width: 1100, height: 720 });
  await expect.poll(() => messages.filter((message) => message.type === "resize").length).toBe(resizeBaseline + 1);
  const withheldResize = latestMessage(messages, "resize");
  if (!withheldResize?.resizeId) throw new Error("missing withheld ordered resize");

  sockets[0].send(JSON.stringify({ type: "control_granted" }));

  await expect.poll(() => terminalTail(page.locator("#desktop-terminal-container"), 20)).toContain("LEGACY-ATTACH-OUTPUT");
  expect(messages.filter((message) => message.type === "resize")).toHaveLength(resizeBaseline + 1);
  expect(latestMessage(messages, "resize")).toEqual(withheldResize);
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
});

test("legacy return to sent geometry cancels a conflicting debounced resize", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal resize lifecycle test");
  const messages: Array<{ readonly type?: string; readonly resizeId?: number; readonly cols?: number; readonly rows?: number }> = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly resizeId?: number; readonly cols?: number; readonly rows?: number };
      messages.push(parsed);
      if (parsed.type === "attach") {
        ws.send(JSON.stringify({ type: "attach_ack", capabilities: ["ordered-resize-ack"] }));
        ws.send(Buffer.from("INITIAL\r\n"));
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
      } else if (parsed.type === "resize" && typeof parsed.resizeId === "number") {
        ws.send(JSON.stringify({ ...parsed, type: "resize_ack" }));
      }
    });
  });

  await loadApp(page);
  await openTerminalSession(page, "test-project");
  const attach = messages.find((message) => message.type === "attach");
  if (!attach?.cols || !attach.rows) throw new Error("missing initial attach geometry");
  const resizeBaseline = messages.filter((message) => message.type === "resize").length;
  await page.setViewportSize({ width: 1180, height: 720 });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(250);

  const resizeMessages = messages.filter((message) => message.type === "resize").slice(resizeBaseline);
  expect(resizeMessages).toEqual([]);
  expect(latestMessage(messages, "layout_stable")).toEqual(expect.objectContaining({ cols: attach.cols, rows: attach.rows }));
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
  const messages: Array<{ readonly type?: string; readonly resizeId?: number; readonly cols?: number; readonly rows?: number; readonly takeControl?: boolean }> = [];
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    sockets.push(ws);
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly resizeId?: number; readonly cols?: number; readonly rows?: number; readonly takeControl?: boolean };
      messages.push(parsed);
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify(parsed.takeControl
        ? { type: "attach_ack", capabilities: ["ordered-resize-ack"] }
        : { type: "attach_ack" }));
      if (!parsed.takeControl) {
        ws.send(Buffer.from("INITIAL\r\n"));
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
      }
    });
  });

  await loadApp(page);
  await openTerminalSession(page, "test-project");
  await sockets[0].close({ code: CLOSE_CODE_DISPLACED, reason: WS_CLOSE_REASONS.DISPLACED });
  await page.locator("#desktop-conflict-overlay .conflict-btn").click();
  await expect.poll(() => sockets.length).toBe(2);

  await expect.poll(() => messages.some((message) => message.type === "attach" && message.takeControl === true)).toBe(true);
  const takeoverAttach = messages.find((message) => message.type === "attach" && message.takeControl === true);
  if (!takeoverAttach?.cols || !takeoverAttach.rows) throw new Error("missing takeover attach geometry");
  sockets[1].send(Buffer.from("PRE-ACK-REDRAW\r\n"));
  sockets[1].send(JSON.stringify({ type: "prefill_done" }));
  sockets[1].send(JSON.stringify({ type: "pty_ready" }));

  await expect.poll(() => latestMessage(messages, "resize")?.resizeId).not.toBeUndefined();
  const resizeRequest = latestMessage(messages, "resize");
  if (!resizeRequest?.resizeId) throw new Error("missing takeover ordered resize");
  expect(resizeRequest).toEqual(expect.objectContaining({ cols: takeoverAttach.cols, rows: takeoverAttach.rows }));
  await page.waitForTimeout(50);
  expect(await terminalTail(page.locator("#desktop-terminal-container"), 20)).not.toContain("PRE-ACK-REDRAW");

  sockets[1].send(JSON.stringify({ type: "resize_ack", resizeId: resizeRequest.resizeId + 1, cols: resizeRequest.cols, rows: resizeRequest.rows }));
  await page.waitForTimeout(50);
  expect(await terminalTail(page.locator("#desktop-terminal-container"), 20)).not.toContain("PRE-ACK-REDRAW");

  sockets[1].send(JSON.stringify({ ...resizeRequest, type: "resize_ack" }));
  await expect.poll(() => terminalTail(page.locator("#desktop-terminal-container"), 20)).toContain("PRE-ACK-REDRAW");
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
});

test("opening from expanded sessions attaches at the final pinned-sidebar width", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal resize lifecycle test");
  const messages: Array<{ readonly type?: string; readonly cols?: number; readonly rows?: number }> = [];
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly cols?: number; readonly rows?: number };
      messages.push(parsed);
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      ws.send(Buffer.from("FINAL-WIDTH\r\n"));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });

  await loadApp(page);
  await openSessionFromUi(page, "test-project", "");
  await expect.poll(() => messages.some((message) => message.type === "layout_stable")).toBe(true);

  const attach = messages.find((message) => message.type === "attach");
  const stable = messages.find((message) => message.type === "layout_stable");
  expect(attach).toEqual(expect.objectContaining({ cols: stable?.cols, rows: stable?.rows }));
});

test("every pinned sidebar transition hides the canvas and performs one settled resize", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal resize lifecycle test");
  const messages: Array<{ readonly type?: string; readonly resizeId?: number; readonly cols?: number; readonly rows?: number }> = [];
  const sockets: WebSocketRoute[] = [];
  let autoAckResize = true;

  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    sockets.push(ws);
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly resizeId?: number; readonly cols?: number; readonly rows?: number };
      messages.push(parsed);
      if (parsed.type === "attach") {
        ws.send(JSON.stringify({ type: "attach_ack", capabilities: ["ordered-resize-ack"] }));
        ws.send(Buffer.from("PINNED\r\n"));
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
      } else if (parsed.type === "resize" && typeof parsed.resizeId === "number" && autoAckResize) {
        ws.send(JSON.stringify({ ...parsed, type: "resize_ack" }));
      }
    });
  });

  await loadApp(page);
  await openTerminalSession(page, "test-project");
  const resizeBaseline = messages.filter((message) => message.type === "resize").length;
  autoAckResize = false;
  const hiddenPromise = terminalHiddenBeforeResizeSettlement(page);
  await page.locator("#sidebar-collapse-btn").click();
  const hiddenHandle = await hiddenPromise;
  expect(await hiddenHandle.jsonValue()).toBe(true);
  await hiddenHandle.dispose();
  await expect.poll(() => messages.filter((message) => message.type === "resize").length).toBe(resizeBaseline + 1);
  const resize = latestMessage(messages, "resize");
  if (!resize?.resizeId) throw new Error("missing sidebar ordered resize");
  await expect(page.locator("#desktop-terminal-container")).toHaveClass(/transitioning/);

  sockets[0].send(JSON.stringify({ ...resize, type: "resize_ack" }));
  await expect.poll(() => page.locator("#desktop-terminal-container").evaluate((terminal) => terminal.classList.contains("transitioning"))).toBe(false);
});

test("pinned sidebar transitions settle delegation grid cells before reveal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation resize lifecycle test");
  const parent = { wolfpackSessionId: "parent-id", wolfpackSessionName: "parent" };
  const messages: Array<{ readonly session: string; readonly type?: string; readonly resizeId?: number; readonly cols?: number; readonly rows?: number }> = [];
  const sockets = new Map<string, WebSocketRoute>();
  let autoAckResize = true;

  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    const session = new URL(ws.url()).searchParams.get("session") ?? "";
    sockets.set(session, ws);
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const parsed = JSON.parse(message) as { readonly type?: string; readonly resizeId?: number; readonly cols?: number; readonly rows?: number; readonly prefillMode?: string };
      messages.push({ session, ...parsed });
      if (parsed.type === "attach") {
        ws.send(JSON.stringify({ type: "attach_ack", capabilities: ["ordered-resize-ack"] }));
        ws.send(Buffer.from(`${session}-GRID\r\n`));
        if (parsed.prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
        ws.send(JSON.stringify({ type: "prefill_done" }));
        ws.send(JSON.stringify({ type: "pty_ready" }));
      } else if (parsed.type === "resize" && typeof parsed.resizeId === "number" && autoAckResize) {
        ws.send(JSON.stringify({ ...parsed, type: "resize_ack" }));
      }
    });
  });
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

  await loadApp(page);
  await openSessionFromUi(page, "parent", "");
  await expect(page.locator("#delegation-grid-container .grid-cell.hydrated")).toHaveCount(3, { timeout: 5_000 });
  const resizeBaseline = messages.filter((message) => message.type === "resize").length;
  autoAckResize = false;

  await page.locator("#sidebar-collapse-btn").click();
  await expect.poll(() => messages.filter((message) => message.type === "resize").length).toBe(resizeBaseline + 3);
  await expect(page.locator("#delegation-grid-container .grid-cell.transitioning")).toHaveCount(3);
  await page.locator("#desktop-sidebar").evaluate((sidebar) => {
    sidebar.dispatchEvent(new TransitionEvent("transitionend", { propertyName: "margin-left" }));
  });
  await page.waitForTimeout(0);
  expect(messages.filter((message) => message.type === "resize")).toHaveLength(resizeBaseline + 3);
  await expect(page.locator("#delegation-grid-container .grid-cell.transitioning")).toHaveCount(3);

  const resizeRequests = messages.filter((message) => message.type === "resize").slice(-3);
  const firstResize = resizeRequests[0];
  const firstSocket = sockets.get(firstResize.session);
  if (!firstSocket || !firstResize.resizeId) throw new Error("missing first delegation resize");
  firstSocket.send(JSON.stringify({ ...firstResize, type: "resize_ack" }));
  await page.waitForTimeout(0);
  await expect(page.locator("#delegation-grid-container .grid-cell.transitioning")).toHaveCount(3);

  for (const request of resizeRequests.slice(1)) {
    const socket = sockets.get(request.session);
    if (!socket || !request.resizeId) throw new Error("missing delegation resize acknowledgement target");
    socket.send(JSON.stringify({ ...request, type: "resize_ack" }));
  }
  await expect.poll(() => page.locator("#delegation-grid-container .grid-cell.transitioning").count()).toBe(0);
});
