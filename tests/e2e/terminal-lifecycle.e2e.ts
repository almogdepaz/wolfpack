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

async function installResizeLifecycleSocket(page: Page): Promise<void> {
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
        const testWindow = window as unknown as {
          __resizeLifecycleSockets?: FakeWebSocket[];
        };
        testWindow.__resizeLifecycleSockets ??= [];
        testWindow.__resizeLifecycleSockets.push(this);
      }

      send(data: unknown): void { this.sent.push(data); }
      close(): void {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
      open(): void {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }
      serverText(data: string): void { this.onmessage?.(new MessageEvent("message", { data })); }
      serverBinary(data: string): void {
        const bytes = new TextEncoder().encode(data);
        this.onmessage?.(new MessageEvent("message", { data: bytes.buffer }));
      }
    }

    const debounceTimers = new Map<number, () => void>();
    const nativeSetTimeout = window.setTimeout;
    const nativeClearTimeout = window.clearTimeout;
    let nextDebounceTimerId = -1;
    window.setTimeout = ((handler: TimerHandler, timeout?: number) => {
      if (timeout === 120 && typeof handler === "function") {
        const timerId = nextDebounceTimerId--;
        debounceTimers.set(timerId, () => { handler(); });
        return timerId;
      }
      return nativeSetTimeout(handler, timeout);
    }) as typeof window.setTimeout;
    window.clearTimeout = ((timerId: number | undefined) => {
      if (typeof timerId === "number" && debounceTimers.delete(timerId)) return;
      nativeClearTimeout(timerId);
    }) as typeof window.clearTimeout;

    const testWindow = window as unknown as {
      __runResizeLifecycleDebounceTimers?: () => void;
    };
    testWindow.__runResizeLifecycleDebounceTimers = () => {
      const callbacks = [...debounceTimers.values()];
      debounceTimers.clear();
      for (const callback of callbacks) callback();
    };

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
  });
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

test("control-granted reattach cancels queued ordered resize before legacy attach", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop resize lifecycle test");
  await installResizeLifecycleSocket(page);

  await page.goto(server.baseUrl);
  await page.waitForSelector(".card", { timeout: 5_000 });
  await page.evaluate(() => {
    // @ts-ignore browser bundle global
    openSession("test-project", "");
  });
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __resizeLifecycleSockets?: unknown[] }).__resizeLifecycleSockets?.length ?? 0,
  )).toBe(1);
  await page.evaluate(() => {
    const socket = (window as unknown as {
      __resizeLifecycleSockets: Array<{ open(): void; serverText(data: string): void }>;
    }).__resizeLifecycleSockets[0];
    if (!socket) throw new Error("missing initial socket");
    socket.open();
    socket.serverText(JSON.stringify({ type: "attach_ack", capabilities: ["ordered-resize-ack"] }));
  });
  const readInitialResize = () => page.evaluate(() => {
    const socket = (window as unknown as { __resizeLifecycleSockets: Array<{ sent: unknown[] }> }).__resizeLifecycleSockets[0];
    return socket?.sent.map((message) => {
      try { return JSON.parse(String(message)); } catch { return null; }
    }).find((message): message is { readonly type: string; readonly resizeId: number; readonly cols: number; readonly rows: number } =>
      !!message && message.type === "resize" && typeof message.resizeId === "number",
    ) ?? null;
  });
  await expect.poll(readInitialResize).not.toBeNull();
  const initialResize = await readInitialResize();
  if (!initialResize) throw new Error("missing initial ordered resize");
  await page.evaluate((request) => {
    const socket = (window as unknown as {
      __resizeLifecycleSockets: Array<{ serverText(data: string): void; serverBinary(data: string): void }>;
    }).__resizeLifecycleSockets[0];
    socket?.serverText(JSON.stringify({ ...request, type: "resize_ack" }));
    socket?.serverBinary("INITIAL\r\n");
    socket?.serverText(JSON.stringify({ type: "prefill_done" }));
    socket?.serverText(JSON.stringify({ type: "pty_ready" }));
  }, initialResize);
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5_000 });

  await page.evaluate(() => {
    const app = window as unknown as {
      state: {
        terminalController?: {
          term?: { cols: number; rows: number };
          fitAddon?: { proposeDimensions?: () => { cols: number; rows: number } | undefined };
          sendFitResize(): Promise<"acknowledged" | "cancelled">;
        };
      };
      __queuedResizeSettlement?: "acknowledged" | "cancelled";
    };
    const controller = app.state.terminalController;
    const term = controller?.term;
    const fitAddon = controller?.fitAddon;
    if (!controller || !term || !fitAddon) throw new Error("missing terminal controller");
    fitAddon.proposeDimensions = () => ({ cols: term.cols + 5, rows: term.rows + 2 });
    void controller.sendFitResize().then((settlement) => { app.__queuedResizeSettlement = settlement; });
  });
  await page.evaluate(() => {
    const app = window as unknown as {
      state: { terminalController?: { term?: { write(data: Uint8Array, callback?: () => void): void } } };
      __legacyAttachWrites?: string[];
      __runResizeLifecycleDebounceTimers(): void;
      __resizeLifecycleSockets: Array<{ serverText(data: string): void; serverBinary(data: string): void }>;
    };
    const socket = app.__resizeLifecycleSockets[0];
    const term = app.state.terminalController?.term;
    if (!socket || !term) throw new Error("missing terminal socket");
    app.__legacyAttachWrites = [];
    const write = term.write.bind(term);
    term.write = (data, callback) => {
      app.__legacyAttachWrites?.push(new TextDecoder().decode(data));
      write(data, callback);
    };
    socket.serverText(JSON.stringify({ type: "control_granted" }));
    socket.serverText(JSON.stringify({ type: "attach_ack" }));
    app.__runResizeLifecycleDebounceTimers();
    socket.serverBinary("LEGACY-ATTACH-OUTPUT\r\n");
    socket.serverText(JSON.stringify({ type: "prefill_done" }));
    socket.serverText(JSON.stringify({ type: "pty_ready" }));
  });

  await expect.poll(() => page.evaluate(() => {
    const app = window as unknown as {
      __queuedResizeSettlement?: string;
      __legacyAttachWrites?: string[];
      __resizeLifecycleSockets: Array<{ sent: unknown[] }>;
    };
    const messages = app.__resizeLifecycleSockets[0]?.sent ?? [];
    const orderedResizeCount = messages.filter((message) => {
      try { return typeof JSON.parse(String(message)).resizeId === "number"; } catch { return false; }
    }).length;
    return {
      settlement: app.__queuedResizeSettlement,
      orderedResizeCount,
      writes: app.__legacyAttachWrites,
    };
  })).toEqual({
    settlement: "cancelled",
    orderedResizeCount: 1,
    writes: ["LEGACY-ATTACH-OUTPUT\r\n"],
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
});

test("legacy return to sent geometry cancels a conflicting debounced resize", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop resize lifecycle test");
  await installResizeLifecycleSocket(page);

  await page.goto(server.baseUrl);
  await page.waitForSelector(".card", { timeout: 5_000 });
  await page.evaluate(() => {
    // @ts-ignore browser bundle global
    openSession("test-project", "");
  });
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __resizeLifecycleSockets?: unknown[] }).__resizeLifecycleSockets?.length ?? 0,
  )).toBe(1);
  await page.evaluate(() => {
    const socket = (window as unknown as {
      __resizeLifecycleSockets: Array<{ open(): void; serverText(data: string): void; serverBinary(data: string): void }>;
    }).__resizeLifecycleSockets[0];
    if (!socket) throw new Error("missing initial socket");
    socket.open();
    socket.serverText(JSON.stringify({ type: "attach_ack" }));
    socket.serverBinary("INITIAL\r\n");
    socket.serverText(JSON.stringify({ type: "prefill_done" }));
    socket.serverText(JSON.stringify({ type: "pty_ready" }));
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5_000 });

  const result = await page.evaluate(async () => {
    const app = window as unknown as {
      state: {
        terminalController?: {
          term?: { cols: number; rows: number; resize(cols: number, rows: number): void };
          fitAddon?: { fit(): void };
          sendFitResize(): Promise<"acknowledged" | "cancelled">;
        };
      };
      __runResizeLifecycleDebounceTimers(): void;
      __resizeLifecycleSockets: Array<{ sent: unknown[] }>;
    };
    const controller = app.state.terminalController;
    const term = controller?.term;
    const fitAddon = controller?.fitAddon;
    if (!controller || !term || !fitAddon) throw new Error("missing terminal controller");
    const sentGeometry = { cols: term.cols, rows: term.rows };
    const queuedGeometry = { cols: term.cols + 5, rows: term.rows + 2 };
    let nextGeometry = queuedGeometry;
    fitAddon.fit = () => { term.resize(nextGeometry.cols, nextGeometry.rows); };
    const queuedSettlement = controller.sendFitResize();
    nextGeometry = sentGeometry;
    const returnedSettlement = controller.sendFitResize();
    app.__runResizeLifecycleDebounceTimers();
    const resizeMessages = app.__resizeLifecycleSockets[0]?.sent.map((message) => {
      try { return JSON.parse(String(message)); } catch { return null; }
    }).filter((message): message is { readonly type: string; readonly cols: number; readonly rows: number } =>
      !!message && message.type === "resize",
    ) ?? [];
    return {
      settlements: await Promise.all([queuedSettlement, returnedSettlement]),
      resizeMessages,
      queuedGeometry,
    };
  });

  expect(result.settlements).toEqual(["acknowledged", "acknowledged"]);
  expect(result.resizeMessages).not.toContainEqual(expect.objectContaining(result.queuedGeometry));
});

test("reconnect/take-control attach defers proposed geometry until the current ordered resize acknowledgement", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop reconnect geometry test");
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
      closeCode: number | undefined;
      closeReason: string | undefined;

      constructor(readonly url: string) {
        const testWindow = window as unknown as { __reconnectSockets?: FakeWebSocket[] };
        testWindow.__reconnectSockets ??= [];
        testWindow.__reconnectSockets.push(this);
      }

      send(data: unknown): void { this.sent.push(data); }
      close(code?: number, reason?: string): void {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.closeCode = code;
        this.closeReason = reason;
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close", { code, reason }));
      }
      open(): void {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }
      serverText(data: string): void { this.onmessage?.(new MessageEvent("message", { data })); }
      serverClose(code: number, reason: string): void { this.close(code, reason); }
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
    (window as unknown as { __reconnectSockets?: unknown[] }).__reconnectSockets?.length ?? 0,
  )).toBe(1);
  await page.evaluate(() => {
    const socket = (window as unknown as {
      __reconnectSockets: Array<{ open(): void; serverText(data: string): void; serverBinary(data: string): void }>;
    }).__reconnectSockets[0];
    if (!socket) throw new Error("missing initial socket");
    socket.open();
    socket.serverText(JSON.stringify({ type: "attach_ack" }));
    socket.serverBinary("INITIAL\r\n");
    socket.serverText(JSON.stringify({ type: "prefill_done" }));
    socket.serverText(JSON.stringify({ type: "pty_ready" }));
  });
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live", { timeout: 5_000 });
  await expect.poll(() => page.evaluate(() => {
    const socket = (window as unknown as { __reconnectSockets: Array<{ sent: unknown[] }> }).__reconnectSockets[0];
    return socket?.sent.some((message) => {
      try { return JSON.parse(String(message)).type === "layout_stable"; } catch { return false; }
    }) ?? false;
  })).toBe(true);

  const reconnectGeometry = await page.evaluate(async () => {
    const app = window as unknown as {
      state: {
        terminalController?: {
          term?: { cols: number; rows: number; resize(cols: number, rows: number): void; write(data: Uint8Array, callback?: () => void): void };
          fitAddon?: { proposeDimensions?: () => { cols: number; rows: number } | undefined };
          reconnect(options?: { takeControl?: boolean }): void;
        };
      };
      __reconnectResizeCount?: number;
      __reconnectWrites?: string[];
      __reconnectContainerWidth?: number;
    };
    const terminal = document.getElementById("desktop-terminal-container");
    const controller = app.state.terminalController;
    const term = controller?.term;
    const fitAddon = controller?.fitAddon;
    if (!terminal || !term || !fitAddon) throw new Error("missing terminal controller");
    app.__reconnectContainerWidth = terminal.clientWidth;
    terminal.style.width = `${Math.max(240, terminal.clientWidth - 240)}px`;
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    const dimensions = { cols: term.cols + 7, rows: term.rows + 3 };
    fitAddon.proposeDimensions = () => dimensions;
    controller.reconnect({ takeControl: true });
    const originalResize = term.resize.bind(term);
    app.__reconnectResizeCount = 0;
    term.resize = (cols, rows) => {
      app.__reconnectResizeCount = (app.__reconnectResizeCount ?? 0) + 1;
      originalResize(cols, rows);
    };
    const originalWrite = term.write.bind(term);
    app.__reconnectWrites = [];
    term.write = (data, callback) => {
      app.__reconnectWrites?.push(new TextDecoder().decode(data));
      originalWrite(data, callback);
    };
    return { dimensions, beforeWidth: app.__reconnectContainerWidth, afterWidth: terminal.clientWidth };
  });
  expect(reconnectGeometry.afterWidth).toBeLessThan(reconnectGeometry.beforeWidth);
  const proposed = reconnectGeometry.dimensions;

  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __reconnectSockets?: unknown[] }).__reconnectSockets?.length ?? 0,
  )).toBe(2);
  // Let the test's container-width mutation drain ResizeObserver before the
  // baseline. The following assertions cover only the reconnect transaction.
  await page.waitForTimeout(250);
  const reconnectResizeBaseline = await page.evaluate(() =>
    (window as unknown as { __reconnectResizeCount?: number }).__reconnectResizeCount ?? 0,
  );
  await page.evaluate(() => {
    const socket = (window as unknown as { __reconnectSockets: Array<{ open(): void }> }).__reconnectSockets[1];
    if (!socket) throw new Error("missing reconnect socket");
    socket.open();
  });
  const readAttach = () => page.evaluate(() => {
    const socket = (window as unknown as { __reconnectSockets: Array<{ sent: unknown[] }> }).__reconnectSockets[1];
    if (!socket) return null;
    return socket.sent.map((message) => {
      try { return JSON.parse(String(message)); } catch { return null; }
    }).find((message): message is { readonly type: string; readonly cols: number; readonly rows: number; readonly takeControl?: true } =>
      !!message && message.type === "attach",
    ) ?? null;
  });
  await expect.poll(readAttach).not.toBeNull();
  expect(await readAttach()).toEqual(expect.objectContaining({ ...proposed, takeControl: true }));
  expect(await page.evaluate(() =>
    (window as unknown as { __reconnectResizeCount?: number }).__reconnectResizeCount,
  )).toBe(reconnectResizeBaseline);

  await page.evaluate(() => {
    const socket = (window as unknown as {
      __reconnectSockets: Array<{ serverText(data: string): void; serverBinary(data: string): void }>;
    }).__reconnectSockets[1];
    socket?.serverText(JSON.stringify({ type: "attach_ack", capabilities: ["ordered-resize-ack"] }));
    socket?.serverBinary("PRE-ACK-REDRAW\\r\\n");
    socket?.serverText(JSON.stringify({ type: "prefill_done" }));
    socket?.serverText(JSON.stringify({ type: "pty_ready" }));
  });
  const readResizeRequestAt = (socketIndex: number) => page.evaluate((index) => {
    const socket = (window as unknown as { __reconnectSockets: Array<{ sent: unknown[] }> }).__reconnectSockets[index];
    if (!socket) return null;
    return socket.sent.map((message) => {
      try { return JSON.parse(String(message)); } catch { return null; }
    }).filter((message): message is { readonly type: string; readonly resizeId: number; readonly cols: number; readonly rows: number } =>
      !!message && message.type === "resize" && typeof message.resizeId === "number",
    ).at(-1) ?? null;
  }, socketIndex);
  const readResizeRequest = () => readResizeRequestAt(1);
  await expect.poll(readResizeRequest).not.toBeNull();
  const resizeRequest = await readResizeRequest();
  if (!resizeRequest) throw new Error("missing ordered resize request");
  expect(resizeRequest).toEqual(expect.objectContaining(proposed));
  expect(await page.evaluate(() =>
    (window as unknown as { __reconnectWrites?: string[] }).__reconnectWrites,
  )).toEqual([]);

  await page.evaluate((request) => {
    const socket = (window as unknown as { __reconnectSockets: Array<{ serverText(data: string): void }> }).__reconnectSockets[1];
    socket?.serverText(JSON.stringify({ type: "resize_ack", resizeId: request.resizeId + 1, cols: request.cols, rows: request.rows }));
  }, resizeRequest);
  expect(await page.evaluate(() =>
    (window as unknown as { __reconnectResizeCount?: number }).__reconnectResizeCount,
  )).toBe(reconnectResizeBaseline);
  expect(await page.evaluate(() =>
    (window as unknown as { __reconnectWrites?: string[] }).__reconnectWrites,
  )).toEqual([]);

  await page.evaluate((request) => {
    const socket = (window as unknown as { __reconnectSockets: Array<{ serverText(data: string): void }> }).__reconnectSockets[1];
    const acknowledgement = {
      type: "resize_ack",
      resizeId: request.resizeId,
      cols: request.cols,
      rows: request.rows,
    };
    socket?.serverText(JSON.stringify(acknowledgement));
    socket?.serverText(JSON.stringify(acknowledgement));
  }, resizeRequest);
  await expect.poll(() => page.evaluate(() => {
    const app = window as unknown as {
      state: { terminalController?: { term?: { cols: number; rows: number } } };
      __reconnectResizeCount?: number;
      __reconnectWrites?: string[];
    };
    return {
      resizeCount: app.__reconnectResizeCount,
      writes: app.__reconnectWrites,

      dimensions: app.state.terminalController?.term
        ? { cols: app.state.terminalController.term.cols, rows: app.state.terminalController.term.rows }
        : null,
    };
  })).toEqual({ resizeCount: reconnectResizeBaseline + 1, writes: ["PRE-ACK-REDRAW\\r\\n"], dimensions: proposed });

  const ordinaryProposed = await page.evaluate(() => {
    const app = window as unknown as {
      state: {
        terminalController?: {
          term?: { cols: number; rows: number };
          fitAddon?: { proposeDimensions?: () => { cols: number; rows: number } | undefined };
          resize(): Promise<void>;
        };
      };
    };
    const controller = app.state.terminalController;
    const term = controller?.term;
    const fitAddon = controller?.fitAddon;
    if (!controller || !term || !fitAddon) throw new Error("missing terminal controller");
    const dimensions = { cols: term.cols + 4, rows: term.rows + 2 };
    fitAddon.proposeDimensions = () => dimensions;
    void controller.resize();
    return dimensions;
  });
  await expect.poll(readResizeRequest).toEqual(expect.objectContaining(ordinaryProposed));
  const ordinaryResize = await readResizeRequest();
  if (!ordinaryResize) throw new Error("missing ordinary ordered resize request");

  await page.evaluate(() => {
    const socket = (window as unknown as {
      __reconnectSockets: Array<{ serverText(data: string): void; serverBinary(data: string): void }>;
    }).__reconnectSockets[1];
    socket?.serverBinary("POST-ATTACH-REDRAW\\r\\n");
    socket?.serverText(JSON.stringify({ type: "prefill_done" }));
    socket?.serverText(JSON.stringify({ type: "pty_ready" }));
  });
  expect(await page.evaluate(() => {
    const app = window as unknown as {
      state: { terminalController?: { term?: { cols: number; rows: number } } };
      __reconnectResizeCount?: number;
      __reconnectWrites?: string[];
    };
    return {
      resizeCount: app.__reconnectResizeCount,
      writes: app.__reconnectWrites,
      dimensions: app.state.terminalController?.term
        ? { cols: app.state.terminalController.term.cols, rows: app.state.terminalController.term.rows }
        : null,
    };
  })).toEqual({ resizeCount: reconnectResizeBaseline + 1, writes: ["PRE-ACK-REDRAW\\r\\n"], dimensions: proposed });

  await page.evaluate((request) => {
    const socket = (window as unknown as { __reconnectSockets: Array<{ serverText(data: string): void }> }).__reconnectSockets[1];
    socket?.serverText(JSON.stringify({ type: "resize_ack", resizeId: request.resizeId + 1, cols: request.cols, rows: request.rows }));
  }, ordinaryResize);
  expect(await page.evaluate(() =>
    (window as unknown as { __reconnectWrites?: string[] }).__reconnectWrites,
  )).toEqual(["PRE-ACK-REDRAW\\r\\n"]);

  await page.evaluate((request) => {
    const socket = (window as unknown as { __reconnectSockets: Array<{ serverText(data: string): void }> }).__reconnectSockets[1];
    socket?.serverText(JSON.stringify({ type: "resize_ack", resizeId: request.resizeId, cols: request.cols, rows: request.rows }));
  }, ordinaryResize);
  await expect.poll(() => page.evaluate(() => {
    const app = window as unknown as {
      state: { terminalController?: { term?: { cols: number; rows: number } } };
      __reconnectResizeCount?: number;
      __reconnectWrites?: string[];
    };
    return {
      resizeCount: app.__reconnectResizeCount,
      writes: app.__reconnectWrites,
      dimensions: app.state.terminalController?.term
        ? { cols: app.state.terminalController.term.cols, rows: app.state.terminalController.term.rows }
        : null,
    };
  })).toEqual({
    resizeCount: reconnectResizeBaseline + 2,
    writes: ["PRE-ACK-REDRAW\\r\\n", "POST-ATTACH-REDRAW\\r\\n"],
    dimensions: ordinaryProposed,
  });

  await page.evaluate(() => {
    const app = window as unknown as {
      state: {
        sidebarCollapsed: boolean;
        sidebarPinned: boolean;
        sidebarLayoutTransitioning: boolean;
        sessionsExpanded: boolean;
        terminalController?: { resize(): Promise<"acknowledged" | "cancelled"> };
      };
      __sidebarResizeSettlements?: Array<"acknowledged" | "cancelled">;
      __unhandledRejections?: string[];
    };
    app.__unhandledRejections = [];
    window.addEventListener("unhandledrejection", (event) => {
      app.__unhandledRejections?.push(String(event.reason));
      event.preventDefault();
    });
    const sidebar = document.getElementById("desktop-sidebar");
    const controller = app.state.terminalController;
    if (!sidebar || !controller) throw new Error("missing sidebar terminal controller");
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
    const resize = controller.resize.bind(controller);
    app.__sidebarResizeSettlements = [];
    controller.resize = () => resize().then((settlement) => {
      app.__sidebarResizeSettlements?.push(settlement);
      return settlement;
    });
  });
  await page.evaluate(() => document.getElementById("sidebar-collapse-btn")?.click());
  await expect.poll(readResizeRequest).not.toEqual(ordinaryResize);
  const cancelledResize = await readResizeRequest();
  if (!cancelledResize) throw new Error("missing cancelled ordered resize request");
  await page.evaluate(() => {
    const socket = (window as unknown as {
      __reconnectSockets: Array<{ serverText(data: string): void; serverBinary(data: string): void; close(code: number, reason: string): void }>;
    }).__reconnectSockets[1];
    socket?.serverBinary("CANCELLED-REDRAW\\r\\n");
    socket?.serverText(JSON.stringify({ type: "pty_ready" }));
    socket?.close(1011, "resize failed");
  });
  await expect.poll(() => page.evaluate(() => {
    const app = window as unknown as {
      state: { sidebarLayoutTransitioning: boolean };
      __sidebarResizeSettlements?: string[];
      __reconnectResizeCount?: number;
      __reconnectWrites?: string[];
      __unhandledRejections?: string[];
    };
    return {
      covered: document.getElementById("desktop-terminal-container")?.classList.contains("transitioning") ?? false,
      transitioning: app.state.sidebarLayoutTransitioning,
      settlements: app.__sidebarResizeSettlements,
      resizeCount: app.__reconnectResizeCount,
      writes: app.__reconnectWrites,
      unhandled: app.__unhandledRejections,
    };
  })).toEqual({
    covered: true,
    transitioning: false,
    settlements: ["cancelled"],
    resizeCount: reconnectResizeBaseline + 2,
    writes: ["PRE-ACK-REDRAW\\r\\n", "POST-ATTACH-REDRAW\\r\\n"],
    unhandled: [],
  });

  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __reconnectSockets?: unknown[] }).__reconnectSockets?.length ?? 0,
  )).toBe(3);
  await page.evaluate(() => {
    const socket = (window as unknown as {
      __reconnectSockets: Array<{ open(): void; serverText(data: string): void; serverBinary(data: string): void }>;
    }).__reconnectSockets[2];
    if (!socket) throw new Error("missing recovery socket");
    socket.open();
    socket.serverText(JSON.stringify({ type: "attach_ack", capabilities: ["ordered-resize-ack"] }));
    socket.serverBinary("RECOVERY-REDRAW\\r\\n");
    socket.serverText(JSON.stringify({ type: "prefill_done" }));
    socket.serverText(JSON.stringify({ type: "pty_ready" }));
  });
  await expect.poll(() => readResizeRequestAt(2)).not.toBeNull();
  const recoveryAttachResize = await readResizeRequestAt(2);
  if (!recoveryAttachResize) throw new Error("missing recovery attach resize request");
  await page.evaluate((request) => {
    const socket = (window as unknown as { __reconnectSockets: Array<{ serverText(data: string): void }> }).__reconnectSockets[2];
    socket?.serverText(JSON.stringify({ ...request, type: "resize_ack" }));
  }, recoveryAttachResize);

  await page.evaluate(() => document.getElementById("sidebar-collapse-btn")?.click());
  await expect.poll(() => readResizeRequestAt(2)).not.toEqual(recoveryAttachResize);
  const recoveryResize = await readResizeRequestAt(2);
  if (!recoveryResize) throw new Error("missing recovery ordered resize request");
  await page.evaluate((request) => {
    const socket = (window as unknown as { __reconnectSockets: Array<{ serverText(data: string): void }> }).__reconnectSockets[2];
    socket?.serverText(JSON.stringify({ ...request, type: "resize_ack" }));
  }, recoveryResize);
  await expect.poll(() => page.evaluate(() => ({
    covered: document.getElementById("desktop-terminal-container")?.classList.contains("transitioning") ?? false,
    settlements: (window as unknown as { __sidebarResizeSettlements?: string[] }).__sidebarResizeSettlements,
  }))).toEqual({ covered: false, settlements: ["cancelled", "acknowledged"] });

  await page.evaluate(() => {
    const app = window as unknown as {
      state: { terminalController?: { resize(): Promise<"acknowledged" | "cancelled">; dispose(): void } };
      __disposeSettlement?: "acknowledged" | "cancelled";
    };
    const controller = app.state.terminalController;
    if (!controller) throw new Error("missing recovery controller");
    void controller.resize().then((settlement) => { app.__disposeSettlement = settlement; });
    controller.dispose();
  });
  await expect.poll(() => page.evaluate(() => ({
    settlement: (window as unknown as { __disposeSettlement?: string }).__disposeSettlement,
    unhandled: (window as unknown as { __unhandledRejections?: string[] }).__unhandledRejections,
  }))).toEqual({ settlement: "cancelled", unhandled: [] });
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
      __terminalTransitionEvents?: string[];
    };
    const terminal = document.getElementById("desktop-terminal-container");
    const term = app.state.terminalController?.term;
    if (!terminal || !term) throw new Error("missing terminal");
    const originalResize = term.resize.bind(term);
    app.__terminalResizeCount = 0;
    app.__terminalTransitionEvents = [];
    new MutationObserver(() => {
      if (!terminal.classList.contains("transitioning")) {
        app.__terminalTransitionEvents?.push(`reveal:${app.__terminalResizeCount ?? 0}`);
      }
    }).observe(terminal, { attributes: true, attributeFilter: ["class"] });
    term.resize = (cols, rows) => {
      app.__terminalResizeCount = (app.__terminalResizeCount ?? 0) + 1;
      app.__terminalTransitionEvents?.push(`resize:${app.__terminalResizeCount}`);
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
  await expect.poll(transitionState, { timeout: 1_000 }).toEqual({ hidden: false, resizeCount: 1 });
  expect(await page.evaluate(() =>
    (window as unknown as { __terminalTransitionEvents?: string[] }).__terminalTransitionEvents,
  )).toEqual(["resize:1", "reveal:1"]);

  await page.evaluate(() => document.getElementById("sidebar-collapse-btn")?.click());
  expect((await transitionState()).hidden).toBe(true);
  await page.waitForTimeout(80);
  expect(await transitionState()).toEqual({ hidden: true, resizeCount: 1 });
  await expect.poll(transitionState, { timeout: 1_000 }).toEqual({ hidden: false, resizeCount: 2 });
  expect(await page.evaluate(() =>
    (window as unknown as { __terminalTransitionEvents?: string[] }).__terminalTransitionEvents,
  )).toEqual(["resize:1", "reveal:1", "resize:2", "reveal:2"]);

  await page.evaluate(() => {
    const app = window as unknown as {
      state: { terminalController?: { resize(): Promise<unknown> } };
      __cancelResize?: (settlement: "acknowledged" | "cancelled") => void;
    };
    const controller = app.state.terminalController;
    if (!controller) throw new Error("missing terminal controller");
    controller.resize = () => new Promise((resolve) => { app.__cancelResize = resolve; });
  });
  await page.evaluate(() => document.getElementById("sidebar-collapse-btn")?.click());
  expect((await transitionState()).hidden).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    !!(window as unknown as { __cancelResize?: unknown }).__cancelResize,
  )).toBe(true);
  await page.evaluate(() =>
    (window as unknown as { __cancelResize?: (settlement: "acknowledged" | "cancelled") => void })
      .__cancelResize?.("cancelled"),
  );
  await expect.poll(() => page.evaluate(() => ({
    hidden: document.getElementById("desktop-terminal-container")?.classList.contains("transitioning") ?? false,
    transitioning: (window as unknown as { state: { sidebarLayoutTransitioning: boolean } }).state.sidebarLayoutTransitioning,
  }))).toEqual({ hidden: true, transitioning: false });

  await page.evaluate(() => {
    const controller = (window as unknown as {
      state: { terminalController?: { resize(): Promise<unknown> } };
    }).state.terminalController;
    if (!controller) throw new Error("missing terminal controller");
    controller.resize = () => Promise.resolve("acknowledged");
  });
  await page.evaluate(() => document.getElementById("sidebar-collapse-btn")?.click());
  await expect.poll(transitionState).toEqual({ hidden: false, resizeCount: 2 });

  await page.evaluate(() => {
    const controller = (window as unknown as {
      state: { terminalController?: { resize(): Promise<unknown> } };
    }).state.terminalController;
    if (!controller) throw new Error("missing terminal controller");
    controller.resize = () => { throw new Error("synchronous resize failure"); };
  });
  await page.evaluate(() => document.getElementById("sidebar-collapse-btn")?.click());
  await expect.poll(() => page.evaluate(() => ({
    hidden: document.getElementById("desktop-terminal-container")?.classList.contains("transitioning") ?? false,
    transitioning: (window as unknown as { state: { sidebarLayoutTransitioning: boolean } }).state.sidebarLayoutTransitioning,
  }))).toEqual({ hidden: true, transitioning: false });
});

test("pinned sidebar transitions settle delegation grid cells before reveal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation grid transition test");
  await page.goto(server.baseUrl);
  await page.waitForSelector(".card", { timeout: 5_000 });
  await page.evaluate(() => {
    type FakeController = {
      readonly supportsOrderedResize: true;
      resize(): Promise<"acknowledged" | "cancelled">;
      forceRepaint(): void;
    };
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
      __delegationResizeResolvers?: Array<(settlement: "acknowledged" | "cancelled") => void>;
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
    app.__delegationResizeResolvers = [];
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
          supportsOrderedResize: true,
          resize: () => new Promise<"acknowledged" | "cancelled">((resolve) => {
            if (app.__delegationResizeCounts) app.__delegationResizeCounts[index] += 1;
            app.__delegationResizeResolvers?.push(resolve);
          }),
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
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __delegationResizeCounts?: number[] }).__delegationResizeCounts,
  ), { timeout: 1_000 }).toEqual([1, 1]);

  // The fallback has entered finish while both acknowledgements are pending.
  // A near-simultaneous transitionend must not schedule a second cell resize.
  await page.evaluate(async () => {
    const sidebar = document.getElementById("desktop-sidebar");
    sidebar?.dispatchEvent(new TransitionEvent("transitionend", { propertyName: "margin-left" }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(await page.evaluate(() =>
    (window as unknown as { __delegationResizeCounts?: number[] }).__delegationResizeCounts,
  )).toEqual([1, 1]);
  expect(await page.locator("#delegation-grid-container .grid-cell.transitioning").count()).toBe(2);

  await page.evaluate(() => {
    (window as unknown as { __delegationResizeResolvers?: Array<(settlement: "acknowledged" | "cancelled") => void> })
      .__delegationResizeResolvers?.[0]?.("acknowledged");
  });
  await page.waitForTimeout(0);
  expect(await page.locator("#delegation-grid-container .grid-cell.transitioning").count()).toBe(2);

  await page.evaluate(() => {
    (window as unknown as { __delegationResizeResolvers?: Array<(settlement: "acknowledged" | "cancelled") => void> })
      .__delegationResizeResolvers?.[1]?.("acknowledged");
  });
  await expect.poll(() => page.locator("#delegation-grid-container .grid-cell.transitioning").count(), {
    timeout: 1_000,
  }).toBe(0);

  await page.evaluate(() => document.getElementById("sidebar-collapse-btn")?.click());
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __delegationResizeCounts?: number[] }).__delegationResizeCounts,
  )).toEqual([2, 2]);
  await page.evaluate(() => {
    const app = window as unknown as {
      __delegationResizeResolvers?: Array<(settlement: "acknowledged" | "cancelled") => void>;
    };
    app.__delegationResizeResolvers?.[2]?.("cancelled");
    app.__delegationResizeResolvers?.[3]?.("cancelled");
  });
  await expect.poll(() => page.evaluate(() => ({
    transitioning: (window as unknown as { state: { sidebarLayoutTransitioning: boolean } }).state.sidebarLayoutTransitioning,
    covered: document.querySelectorAll("#delegation-grid-container .grid-cell.transitioning").length,
  }))).toEqual({ transitioning: false, covered: 2 });

  await page.evaluate(() => document.getElementById("sidebar-collapse-btn")?.click());
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __delegationResizeCounts?: number[] }).__delegationResizeCounts,
  )).toEqual([3, 3]);
  await page.evaluate(() => {
    const app = window as unknown as {
      __delegationResizeResolvers?: Array<(settlement: "acknowledged" | "cancelled") => void>;
    };
    app.__delegationResizeResolvers?.[4]?.("acknowledged");
    app.__delegationResizeResolvers?.[5]?.("acknowledged");
  });
  await expect.poll(() => page.locator("#delegation-grid-container .grid-cell.transitioning").count()).toBe(0);
});
