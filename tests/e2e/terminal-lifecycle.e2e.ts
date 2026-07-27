import { expect, test } from "@playwright/test";
import type { CDPSession, Page } from "@playwright/test";
import { startTestServer } from "./helpers.ts";
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

async function switchSession(page: Page, session: string): Promise<void> {
  await page.evaluate((nextSession) => {
    // @ts-ignore browser bundle global
    switchSession(nextSession);
  }, session);
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5_000 });
}

async function hydrateFakeSocket(page: Page, index: number, content: string): Promise<void> {
  await page.evaluate(({ socketIndex, terminalContent }) => {
    const sockets = (window as unknown as {
      __fakeSockets: Array<{
        open(): void;
        serverText(data: string): void;
        serverBinary(data: string): void;
      }>;
    }).__fakeSockets;
    const socket = sockets[socketIndex];
    if (!socket) throw new Error(`missing fake socket ${socketIndex}`);
    socket.open();
    socket.serverText(JSON.stringify({ type: "attach_ack" }));
    socket.serverBinary(terminalContent);
    socket.serverText(JSON.stringify({ type: "prefill_done" }));
    socket.serverText(JSON.stringify({ type: "pty_ready" }));
  }, { socketIndex: index, terminalContent: content });
}

test("disposing repeated terminal mounts releases document pointer listeners", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal lifecycle test");
  const cdp = await page.context().newCDPSession(page);

  await page.goto(server.baseUrl);
  await page.waitForSelector(".card", { timeout: 5_000 });
  const baselineMouseDown = await documentListenerCount(cdp, "mousedown");
  const baselineMouseUp = await documentListenerCount(cdp, "mouseup");

  await switchSession(page, "test-project");
  const mountedMouseDown = await documentListenerCount(cdp, "mousedown");
  const mountedMouseUp = await documentListenerCount(cdp, "mouseup");

  await switchSession(page, "another-project");
  await switchSession(page, "test-project");
  await switchSession(page, "another-project");

  expect(await documentListenerCount(cdp, "mousedown")).toBe(mountedMouseDown);
  expect(await documentListenerCount(cdp, "mouseup")).toBe(mountedMouseUp);

  await page.evaluate(() => {
    const app = window as unknown as {
      state: { terminalController?: { dispose(): void } | null };
    };
    app.state.terminalController?.dispose();
    app.state.terminalController = null;
  });
  await expect(page.locator("#desktop-terminal-container canvas")).toHaveCount(0);
  expect(await documentListenerCount(cdp, "mousedown")).toBe(baselineMouseDown);
  expect(await documentListenerCount(cdp, "mouseup")).toBe(baselineMouseUp);
});

test("replaced websocket events cannot mutate the current terminal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop terminal websocket lifecycle test");
  await page.addInitScript(() => {
    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly sent: unknown[] = [];
      readyState = FakeWebSocket.CONNECTING;
      binaryType = "blob";
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(readonly url: string) {
        const testWindow = window as unknown as { __fakeSockets?: FakeWebSocket[] };
        testWindow.__fakeSockets ??= [];
        testWindow.__fakeSockets.push(this);
      }

      send(data: unknown): void {
        this.sent.push(data);
      }

      close(): void {
        // Keep queued callbacks callable to model a replaced zombie transport.
      }

      open(): void {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }

      serverText(data: string): void {
        this.onmessage?.(new MessageEvent("message", { data }));
      }

      serverBinary(data: string): void {
        const bytes = new TextEncoder().encode(data);
        this.onmessage?.(new MessageEvent("message", { data: bytes.buffer }));
      }
    }

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
  });

  await page.goto(server.baseUrl);
  await page.waitForSelector(".card", { timeout: 5_000 });
  await page.evaluate(() => {
    // @ts-ignore browser bundle global
    openSession("test-project", "");
  });
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __fakeSockets?: unknown[] }).__fakeSockets?.length ?? 0,
  )).toBe(1);
  await hydrateFakeSocket(page, 0, "FIRST-SOCKET\r\n");
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5_000 });

  await page.evaluate(() => {
    const controller = (window as unknown as {
      state: { terminalController?: { reconnect(): void } };
    }).state.terminalController;
    controller?.reconnect();
  });
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __fakeSockets?: unknown[] }).__fakeSockets?.length ?? 0,
  )).toBe(2);
  await hydrateFakeSocket(page, 1, "CURRENT-SOCKET\r\n");
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5_000 });

  const evidence = await page.evaluate(() => {
    const app = window as unknown as {
      state: { terminalController?: { term?: { write(data: Uint8Array, callback?: () => void): void } } };
      __fakeSockets: Array<{
        readonly sent: unknown[];
        open(): void;
        serverText(data: string): void;
        serverBinary(data: string): void;
      }>;
    };
    const term = app.state.terminalController?.term;
    const oldSocket = app.__fakeSockets[0];
    const currentSocket = app.__fakeSockets[1];
    if (!term || !oldSocket || !currentSocket) throw new Error("missing terminal websocket state");
    const writes: string[] = [];
    const originalWrite = term.write.bind(term);
    term.write = (data, callback) => {
      writes.push(new TextDecoder().decode(data));
      originalWrite(data, callback);
    };
    oldSocket.serverBinary("STALE-SOCKET\r\n");
    const currentSentBefore = currentSocket.sent.length;
    oldSocket.open();
    oldSocket.serverText(JSON.stringify({ type: "prefill_done" }));
    return {
      writes,
      currentSentBefore,
      currentSentAfter: currentSocket.sent.length,
    };
  });

  expect(evidence.writes).toEqual([]);
  expect(evidence.currentSentAfter).toBe(evidence.currentSentBefore);
});

test("opening from expanded sessions attaches at the final pinned-sidebar width", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop initial terminal layout test");
  await page.addInitScript(() => {
    localStorage.setItem("wolfpack-sidebar-pinned", "1");
  });
  const geometryMessages: Array<{ readonly type?: string; readonly cols?: number; readonly rows?: number }> = [];
  await page.routeWebSocket(/\/ws\/pty/, (socket) => {
    socket.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: { readonly type?: string; readonly cols?: number; readonly rows?: number };
      try { parsed = JSON.parse(message); } catch { return; }
      geometryMessages.push(parsed);
      if (parsed.type !== "attach") return;
      socket.send(JSON.stringify({ type: "attach_ack" }));
      socket.send(Buffer.from("FINAL-WIDTH\r\n"));
      socket.send(JSON.stringify({ type: "prefill_done" }));
      socket.send(JSON.stringify({ type: "pty_ready" }));
    });
  });

  await page.goto(server.baseUrl);
  await page.waitForSelector(".card", { timeout: 5_000 });
  await page.evaluate(() => {
    // @ts-ignore browser bundle global
    openSession("test-project", "");
  });
  await expect.poll(() => geometryMessages.some(message => message.type === "layout_stable")).toBe(true);

  const attach = geometryMessages.find(message => message.type === "attach");
  const stable = geometryMessages.find(message => message.type === "layout_stable");
  expect(attach).toEqual(expect.objectContaining({ cols: stable?.cols, rows: stable?.rows }));
});

test("every pinned sidebar transition hides the canvas and performs one settled resize", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop sidebar transition test");
  await page.addInitScript(() => {
    localStorage.setItem("wolfpack-sidebar-pinned", "1");
  });
  await page.goto(server.baseUrl);
  await page.waitForSelector(".card", { timeout: 5_000 });
  await page.evaluate(() => {
    const app = window as unknown as {
      state: {
        sidebarCollapsed: boolean;
        sidebarPinned: boolean;
        sidebarLayoutTransitioning: boolean;
        sessionsExpanded: boolean;
      };
    };
    const sidebar = document.getElementById("desktop-sidebar");
    if (!sidebar) throw new Error("missing sidebar");
    sidebar.style.transition = "none";
    app.state.sidebarCollapsed = false;
    app.state.sidebarPinned = true;
    app.state.sidebarLayoutTransitioning = false;
    app.state.sessionsExpanded = false;
    document.body.classList.add("sidebar-pinned");
    document.body.classList.remove("sessions-expanded");
    sidebar.classList.remove("collapsed");
    void sidebar.offsetHeight;
    sidebar.style.transition = "";
  });
  await switchSession(page, "test-project");
  await page.evaluate(() => {
    const app = window as unknown as {
      state: { terminalController?: { term?: { resize(cols: number, rows: number): void } } };
      __terminalResizeCount?: number;
    };
    const term = app.state.terminalController?.term;
    if (!term) throw new Error("missing terminal");
    const originalResize = term.resize.bind(term);
    app.__terminalResizeCount = 0;
    term.resize = (cols, rows) => {
      app.__terminalResizeCount = (app.__terminalResizeCount ?? 0) + 1;
      originalResize(cols, rows);
    };
  });

  const transitionState = async (): Promise<{ readonly hidden: boolean; readonly resizeCount: number }> => page.evaluate(() => ({
    hidden: document.getElementById("desktop-terminal-container")?.classList.contains("transitioning") ?? false,
    resizeCount: (window as unknown as { __terminalResizeCount?: number }).__terminalResizeCount ?? 0,
  }));

  await page.evaluate(() => document.getElementById("sidebar-collapse-btn")?.click());
  expect((await transitionState()).hidden).toBe(true);
  await page.waitForTimeout(80);
  expect(await transitionState()).toEqual({ hidden: true, resizeCount: 0 });
  await page.waitForTimeout(220);
  expect(await transitionState()).toEqual({ hidden: false, resizeCount: 1 });

  await page.evaluate(() => document.getElementById("sidebar-collapse-btn")?.click());
  expect((await transitionState()).hidden).toBe(true);
  await page.waitForTimeout(80);
  expect(await transitionState()).toEqual({ hidden: true, resizeCount: 1 });
  await page.waitForTimeout(220);
  expect(await transitionState()).toEqual({ hidden: false, resizeCount: 2 });
});

test("pinned sidebar transitions settle delegation grid cells before reveal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation grid transition test");
  await page.goto(server.baseUrl);
  await page.waitForSelector(".card", { timeout: 5_000 });
  await page.evaluate(() => {
    type FakeController = { resize(): void; forceRepaint(): void };
    type FakeGridSession = {
      session: string;
      machine: string;
      controller: FakeController;
      _cellElement: HTMLDivElement;
    };
    const app = window as unknown as {
      state: {
        activeDelegationRoot: string | null;
        focusedDelegationSession: string | null;
        delegationGridSessions: FakeGridSession[];
        sidebarAutoExpanded: boolean;
        sidebarCollapsed: boolean;
        sidebarLayoutTransitioning: boolean;
        sidebarPinned: boolean;
        sessionsExpanded: boolean;
      };
      __delegationResizeCounts?: number[];
    };
    const sidebar = document.getElementById("desktop-sidebar");
    const grid = document.getElementById("delegation-grid-container");
    if (!sidebar || !grid) throw new Error("missing delegation layout elements");
    sidebar.style.transition = "none";
    app.state.sidebarAutoExpanded = false;
    app.state.sidebarCollapsed = false;
    app.state.sidebarLayoutTransitioning = false;
    app.state.sidebarPinned = true;
    app.state.sessionsExpanded = false;
    document.body.classList.add("sidebar-pinned");
    document.body.classList.remove("sessions-expanded");
    sidebar.classList.remove("collapsed");
    void sidebar.offsetHeight;
    sidebar.style.transition = "";

    app.__delegationResizeCounts = [0, 0];
    app.state.activeDelegationRoot = "delegation-root";
    app.state.focusedDelegationSession = null;
    app.state.delegationGridSessions = [0, 1].map((index) => {
      const cell = document.createElement("div");
      cell.className = "grid-cell";
      grid.appendChild(cell);
      return {
        session: `delegation-${index}`,
        machine: "",
        _cellElement: cell,
        controller: {
          resize: () => {
            if (app.__delegationResizeCounts) app.__delegationResizeCounts[index] += 1;
          },
          forceRepaint: () => {},
        },
      };
    });
  });

  await page.evaluate(() => document.getElementById("sidebar-collapse-btn")?.click());
  expect(await page.locator("#delegation-grid-container .grid-cell.transitioning").count()).toBe(2);
  await page.waitForTimeout(80);
  expect(await page.evaluate(() =>
    (window as unknown as { __delegationResizeCounts?: number[] }).__delegationResizeCounts,
  )).toEqual([0, 0]);
  await page.waitForTimeout(270);
  expect(await page.evaluate(() =>
    (window as unknown as { __delegationResizeCounts?: number[] }).__delegationResizeCounts,
  )).toEqual([1, 1]);
  expect(await page.locator("#delegation-grid-container .grid-cell.transitioning").count()).toBe(0);
});
