import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { PTY_ATTACH_CAPABILITY } from "../../src/pty-websocket-contract.ts";
import { syncTerminalLayout } from "../../public/terminal-layout.ts";
import { createPtySocketClient, type PtySocketClientDependencies, type PtySocketClientOpts } from "../../public/pty-socket-client.ts";

import { mountAndConnectTerminal } from "../../public/terminal-bootstrap.ts";
import { resumeMobileTerminal } from "../../src/mobile-foreground.ts";
import { CLOSE_CODE_DISPLACED, CLOSE_CODE_SESSION_UNAVAILABLE, WS_CLOSE_REASONS } from "../../src/ws-constants.ts";

const ORIGINAL_WEBSOCKET = globalThis.WebSocket;
const ORIGINAL_LOCATION = globalThis.location;
const ORIGINAL_REQUEST_ANIMATION_FRAME = globalThis.requestAnimationFrame;

type FakeWebSocketEvent = { readonly code: number; readonly reason: string };
type FakeWebSocketMessage = { readonly data: string | ArrayBuffer };

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  binaryType = "blob";
  bufferedAmount = 0;
  readyState = FakeWebSocket.CONNECTING;
  sent: Array<string | ArrayBuffer | Blob> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: FakeWebSocketMessage) => void) | null = null;
  onclose: ((event: FakeWebSocketEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer | Blob): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(data: string | ArrayBuffer): void {
    this.onmessage?.({ data });
  }

  jsonFrames(): unknown[] {
    return this.sent
      .filter((frame): frame is string => typeof frame === "string")
      .map((frame) => JSON.parse(frame) as unknown);
  }
}

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

interface ResizeFrame {
  readonly type: "resize";
  readonly resizeId?: number;
  readonly cols: number;
  readonly rows: number;
}

function resizeFrames(socket: FakeWebSocket): ResizeFrame[] {
  return socket.jsonFrames().filter((frame): frame is ResizeFrame =>
    typeof frame === "object" && frame !== null && "type" in frame && frame.type === "resize");
}

interface OutputAckFrame {
  readonly type: "ack";
  readonly bytes: number;
}

function outputAckFrames(socket: FakeWebSocket): OutputAckFrame[] {
  return socket.jsonFrames().filter((frame): frame is OutputAckFrame =>
    typeof frame === "object" && frame !== null && "type" in frame && frame.type === "ack");
}

function acknowledge(socket: FakeWebSocket, frame: ResizeFrame): void {
  socket.message(JSON.stringify({ ...frame, type: "resize_ack" }));
}

function installBrowserStubs(): void {
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "http://localhost:18790" },
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback): number => {
      callback(0);
      return 1;
    },
  });
}

function restoreBrowserStubs(): void {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: ORIGINAL_WEBSOCKET,
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: ORIGINAL_LOCATION,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: ORIGINAL_REQUEST_ANIMATION_FRAME,
  });
}

function dependencies(overrides: Partial<PtySocketClientDependencies> = {}): PtySocketClientDependencies {
  return {
    resolveReadyMachineOrigin: () => "https://phone.example.ts.net",
    requestWebSocketTicket: async () => "ticket-1",
    getBrowserAuthToken: () => null,
    getDebugStorage: () => null,
    ...overrides,
  };
}

function clientOpts(overrides: Partial<PtySocketClientOpts> = {}): PtySocketClientOpts {
  return {
    session: "alpha",
    prefillMode: "none",
    getTermDimensions: () => ({ cols: 80, rows: 24 }),
    fitTerminal: () => {},
    ...overrides,
  };
}

beforeEach(() => installBrowserStubs());
afterEach(() => restoreBrowserStubs());

describe("PTY socket client", () => {
  test("sends cumulative output acks at the 64KiB cadence and 50ms deadline", async () => {
    jest.useFakeTimers();
    const client = createPtySocketClient(clientOpts(), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: ["output-ack"] }));
      jest.advanceTimersByTime(100);
      expect(outputAckFrames(socket)).toEqual([]);
      socket.message(new ArrayBuffer(64 * 1024));
      expect(outputAckFrames(socket)).toEqual([{ type: "ack", bytes: 64 * 1024 }]);
      socket.message(new ArrayBuffer(10));
      jest.advanceTimersByTime(40);
      socket.message(new ArrayBuffer(20));
      jest.advanceTimersByTime(9);
      expect(outputAckFrames(socket)).toHaveLength(1);
      jest.advanceTimersByTime(1);
      expect(outputAckFrames(socket)).toEqual([
        { type: "ack", bytes: 64 * 1024 }, { type: "ack", bytes: 64 * 1024 + 30 },
      ]);
      jest.advanceTimersByTime(200);
      expect(outputAckFrames(socket)).toHaveLength(2);
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test("retries a potentially full quiet window's last ack four times, then stops", async () => {
    jest.useFakeTimers();
    const client = createPtySocketClient(clientOpts(), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: ["output-ack"] }));
      // Real server output is sliced: each transmitted ack is below the
      // potential-window threshold, but the quiet burst fills the window.
      for (let index = 0; index < 4; index++) socket.message(new ArrayBuffer(128 * 1024));
      expect(outputAckFrames(socket).at(-1)).toEqual({ type: "ack", bytes: 512 * 1024 });
      const initialAcks = outputAckFrames(socket).length;
      jest.advanceTimersByTime(249);
      expect(outputAckFrames(socket)).toHaveLength(initialAcks);
      for (let attempt = 1; attempt <= 4; attempt++) {
        jest.advanceTimersByTime(attempt === 1 ? 1 : 250);
        expect(outputAckFrames(socket)).toHaveLength(initialAcks + attempt);
        expect(outputAckFrames(socket).at(-1)).toEqual({ type: "ack", bytes: 512 * 1024 });
      }
      jest.advanceTimersByTime(2000);
      expect(outputAckFrames(socket)).toHaveLength(initialAcks + 4);
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test("new output cancels stale quiet retry and retries only the latest cumulative ack", async () => {
    jest.useFakeTimers();
    const client = createPtySocketClient(clientOpts(), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: ["output-ack"] }));
      socket.message(new ArrayBuffer(512 * 1024));
      jest.advanceTimersByTime(200);
      socket.message(new ArrayBuffer(10));
      jest.advanceTimersByTime(50);
      expect(outputAckFrames(socket)).toEqual([
        { type: "ack", bytes: 512 * 1024 }, { type: "ack", bytes: 512 * 1024 + 10 },
      ]);
      jest.advanceTimersByTime(250);
      expect(outputAckFrames(socket).at(-1)).toEqual({ type: "ack", bytes: 512 * 1024 + 10 });
      expect(outputAckFrames(socket)).toHaveLength(3);
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test.each(["close", "disconnect", "reconnect"] as const)("cancels full-window ack retry on %s", async (action) => {
    jest.useFakeTimers();
    const client = createPtySocketClient(clientOpts(), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: ["output-ack"] }));
      socket.message(new ArrayBuffer(512 * 1024));
      if (action === "disconnect") socket.close();
      else client[action]();
      await flushPromises();
      jest.advanceTimersByTime(2000);
      expect(outputAckFrames(socket)).toEqual([{ type: "ack", bytes: 512 * 1024 }]);
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test("acks received prefill before resize barrier release, without recounting on replay", async () => {
    jest.useFakeTimers();
    const chunks: number[] = [];
    const client = createPtySocketClient(clientOpts({
      prefillMode: "viewport", onBinaryData: (data) => chunks.push(data.length),
    }), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: ["output-ack", PTY_ATTACH_CAPABILITY.ORDERED_RESIZE_ACK] }));
      socket.message(new ArrayBuffer(64 * 1024));
      expect(chunks).toEqual([]);
      expect(outputAckFrames(socket)).toEqual([{ type: "ack", bytes: 64 * 1024 }]);
      socket.message(JSON.stringify({ type: "prefill_done" }));
      acknowledge(socket, resizeFrames(socket)[0]);
      expect(chunks).toEqual([64 * 1024]);
      jest.advanceTimersByTime(50);
      expect(outputAckFrames(socket)).toHaveLength(1);
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test.each(["close", "disconnect", "reconnect"] as const)("cancels pending output ack on %s and resets only for a new socket", async (action) => {
    jest.useFakeTimers();
    const client = createPtySocketClient(clientOpts(), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: ["output-ack"] }));
      socket.message(new ArrayBuffer(64 * 1024));
      socket.message(new ArrayBuffer(10));
      const staleMessage = socket.onmessage;
      if (action === "disconnect") socket.close();
      else client[action]();
      await flushPromises();
      staleMessage?.({ data: new ArrayBuffer(64 * 1024) });
      jest.advanceTimersByTime(100);
      expect(outputAckFrames(socket)).toEqual([{ type: "ack", bytes: 64 * 1024 }]);
      if (action === "reconnect") {
        const replacement = FakeWebSocket.instances[1];
        replacement.open();
        replacement.message(JSON.stringify({ type: "attach_ack", capabilities: ["output-ack"] }));
        replacement.message(new ArrayBuffer(64 * 1024));
        expect(outputAckFrames(replacement)).toEqual([{ type: "ack", bytes: 64 * 1024 }]);
      }
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test("keeps cumulative byte counters across same-socket take-control reattach", async () => {
    jest.useFakeTimers();
    const client = createPtySocketClient(clientOpts(), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: ["output-ack"] }));
      socket.message(new ArrayBuffer(64 * 1024));
      socket.message(JSON.stringify({ type: "control_granted" }));
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: ["output-ack"] }));
      socket.message(new ArrayBuffer(64 * 1024));
      expect(outputAckFrames(socket)).toEqual([
        { type: "ack", bytes: 64 * 1024 }, { type: "ack", bytes: 128 * 1024 },
      ]);
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test("does not ack output from a server without output-ack support", async () => {
    jest.useFakeTimers();
    const client = createPtySocketClient(clientOpts(), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack" }));
      socket.message(new ArrayBuffer(128 * 1024));
      jest.advanceTimersByTime(100);
      expect(outputAckFrames(socket)).toEqual([]);
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test("opens a socket and sends the attach handshake", async () => {
    let attached = 0;
    const client = createPtySocketClient(clientOpts({ onAttach: () => { attached++; } }), dependencies());

    client.connect();
    await flushPromises();
    FakeWebSocket.instances[0]?.open();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(new URL(FakeWebSocket.instances[0].url).href).toBe("ws://localhost:18790/ws/pty?session=alpha");
    expect(FakeWebSocket.instances[0].jsonFrames()[0]).toEqual({ type: "attach", cols: 80, rows: 24, prefillMode: "none", capabilities: ["output-ack"] });
    expect(attached).toBe(1);

    client.close();
  });

  test("opens ticket and socket before mount, but attaches only after the fitted terminal is ready", async () => {
    let mounted = false;
    let fitted = false;
    let tickets = 0;
    const options = {
      ...clientOpts({ fitTerminal: () => { fitted = true; } }),
      isTerminalReady: () => mounted,
    };
    const client = createPtySocketClient(options, dependencies({
      getBrowserAuthToken: () => "token",
      requestWebSocketTicket: async () => { tickets++; return "ticket"; },
    }));
    try {
      client.connect();
      expect(tickets).toBe(1);
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      expect(socket.jsonFrames()).toEqual([]);
      expect(fitted).toBe(false);
      mounted = true;
      client.notifyTerminalReady();
      expect(fitted).toBe(true);
      expect(socket.jsonFrames()[0]).toEqual({ type: "attach", cols: 80, rows: 24, prefillMode: "none", capabilities: ["output-ack"] });
    } finally {
      client.close();
    }
  });

  for (const failure of ["ticket", "socket"] as const) {
    test(`deferred mount recovers an early ${failure} failure and attaches exactly once`, async () => {
      let mounted = false;
      let tickets = 0;
      let release!: () => void;
      const pendingMount = new Promise<void>((resolve) => { release = resolve; });
      const client = createPtySocketClient(clientOpts({
        isTerminalReady: () => mounted,
        shouldReconnect: () => mounted,
        onDisconnected: () => client.scheduleReconnect(),
      }), dependencies({
        getBrowserAuthToken: () => "token",
        requestWebSocketTicket: async () => {
          tickets++;
          if (failure === "ticket" && tickets === 1) throw new Error("early ticket failure");
          return "ticket";
        },
      }));
      const mounting = mountAndConnectTerminal({
        mount: async () => { await pendingMount; mounted = true; client.notifyTerminalReady(); },
        connect: () => client.connect(),
        dispose: () => client.close(),
      }, {} as HTMLElement);
      try {
        for (let i = 0; i < 5; i++) await flushPromises();
        if (failure === "socket") {
          FakeWebSocket.instances[0].open();
          FakeWebSocket.instances[0].close(1006);
        }
        release();
        await mounting;
        for (let i = 0; i < 5; i++) await flushPromises();
        const socket = FakeWebSocket.instances.at(-1);
        expect(socket?.readyState).toBe(FakeWebSocket.CONNECTING);
        socket?.open();
        client.notifyTerminalReady();
        expect(socket?.jsonFrames().filter((frame) => (frame as { type: string }).type === "attach")).toHaveLength(1);
        expect(tickets).toBe(2);
      } finally { release(); client.close(); }
    });
  }

  for (let ticks = 0; ticks < 10; ticks++) {
    test(`ticket rejection and deferred mount readiness interleave, ticks=${ticks}`, async () => {
      let mounted = false;
      let tickets = 0;
      let retries = 0;
      let release!: () => void;
      let rejectTicket!: (error: Error) => void;
      const pendingMount = new Promise<void>((resolve) => { release = resolve; });
      const firstTicket = new Promise<string>((_resolve, reject) => { rejectTicket = reject; });
      const client = createPtySocketClient(clientOpts({
        isTerminalReady: () => mounted,
        shouldReconnect: () => mounted,
        onReconnecting: () => { retries++; },
      }), dependencies({
        getBrowserAuthToken: () => "token",
        requestWebSocketTicket: () => {
          tickets++;
          return tickets === 1 ? firstTicket : Promise.resolve("ticket");
        },
      }));
      const timers = spyOn(globalThis, "setTimeout");
      const mounting = mountAndConnectTerminal({
        mount: async () => { await pendingMount; mounted = true; client.notifyTerminalReady(); },
        connect: () => client.connect(),
        dispose: () => client.close(),
      }, {} as HTMLElement);
      try {
        rejectTicket(new Error("interleaved ticket failure"));
        for (let i = 0; i < ticks; i++) await Promise.resolve();
        release();
        await mounting;
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(FakeWebSocket.instances.length === 1 || retries === 1).toBe(true);
        expect(retries).toBeLessThanOrEqual(1);
        if (FakeWebSocket.instances.length === 0) {
          const callback = timers.mock.calls.at(-1)?.[0];
          const handle = timers.mock.results.at(-1)?.value as ReturnType<typeof setTimeout> | undefined;
          // Fire the real retry callback without leaving its native timer alive.
          clearTimeout(handle);
          if (typeof callback !== "function") throw new Error("missing scheduled retry");
          callback();
          for (let i = 0; i < 10; i++) await Promise.resolve();
        }
        expect(FakeWebSocket.instances).toHaveLength(1);
        const socket = FakeWebSocket.instances[0];
        socket.open();
        client.notifyTerminalReady();
        expect(socket.jsonFrames().filter((frame) => (frame as { type: string }).type === "attach")).toHaveLength(1);
        expect(tickets).toBe(2);
      } finally { release(); client.close(); timers.mockRestore(); }
    });
  }

  test("mount rejection after early open closes transport and cannot reconnect", async () => {
    let reject!: (error: Error) => void;
    const mount = new Promise<void>((_resolve, fail) => { reject = fail; });
    const client = createPtySocketClient(clientOpts({ isTerminalReady: () => false }), dependencies());
    const mounting = mountAndConnectTerminal({ mount: () => mount, connect: () => client.connect(), dispose: () => client.close() }, {} as HTMLElement);
    const failed = mounting.catch(() => {});
    try {
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      reject(new Error("mount failed"));
      await failed;
      expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
      expect(client.retryBlocked).toBe(true);
      client.scheduleReconnect();
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally { client.close(); }
  });

  for (const [code, reason] of [[CLOSE_CODE_DISPLACED, "displaced"], [CLOSE_CODE_SESSION_UNAVAILABLE, "unavailable"], [1000, WS_CLOSE_REASONS.PTY_EXITED], [1000, WS_CLOSE_REASONS.PTY_TEARDOWN]] as const) {
    test(`mount readiness does not revive terminal-blocked close ${code} ${reason}`, async () => {
      let mounted = false;
      const client = createPtySocketClient(clientOpts({ isTerminalReady: () => mounted }), dependencies());
      try {
        client.connect();
        await flushPromises();
        const socket = FakeWebSocket.instances[0];
        socket.open();
        socket.close(code, reason);
        mounted = true;
        client.notifyTerminalReady();
        await flushPromises();
        expect(client.retryBlocked).toBe(true);
        expect(FakeWebSocket.instances).toHaveLength(1);
      } finally { client.close(); }
    });
  }

  test("explicit takeover retry may recover after a terminal-blocked close", async () => {
    let rejectTicket = false;
    let retries = 0;
    const client = createPtySocketClient(clientOpts({ onReconnecting: () => { retries++; } }), dependencies({
      getBrowserAuthToken: () => "token",
      requestWebSocketTicket: async () => { if (rejectTicket) throw new Error("takeover ticket failed"); return "ticket"; },
    }));
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.close(CLOSE_CODE_DISPLACED);
      rejectTicket = true;
      client.reconnect({ takeControl: true });
      for (let i = 0; i < 5; i++) await flushPromises();
      expect(retries).toBe(1);
    } finally { client.close(); }
  });

  test("blocks reconnect when a remote machine has no ready route", async () => {
    let unavailable = 0;
    const client = createPtySocketClient(
      clientOpts({ machine: "phone", onRouteUnavailable: () => { unavailable++; } }),
      dependencies({ resolveReadyMachineOrigin: () => undefined }),
    );

    client.connect();
    await flushPromises();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(unavailable).toBe(1);
    expect(client.retryBlocked).toBe(true);
    client.notifyTerminalReady();
    await flushPromises();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(unavailable).toBe(1);

    client.close();
  });

  test("schedules reconnect when ticket acquisition fails", async () => {
    let reconnecting = 0;
    const client = createPtySocketClient(
      clientOpts({ machine: "phone", onReconnecting: () => { reconnecting++; } }),
      dependencies({
        getBrowserAuthToken: () => "token",
        requestWebSocketTicket: async () => { throw new Error("ticket failed"); },
      }),
    );

    client.connect();
    await flushPromises();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(reconnecting).toBe(1);

    client.close();
  });

  test.each([false, true])("returns to committed geometry when the real layout caller reverses a resize (in-flight: %s)", async (inFlight) => {
    jest.useFakeTimers();
    const term = { cols: 80, rows: 24, scrollToLine: () => {} };
    let proposed = { cols: 80, rows: 24 };
    const client = createPtySocketClient(clientOpts({
      getTermDimensions: () => term,
      getProposedDimensions: () => proposed,
      onResizeAck: (cols, rows) => { Object.assign(term, { cols, rows }); },
    }), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: [PTY_ATTACH_CAPABILITY.ORDERED_RESIZE_ACK] }));
      acknowledge(socket, resizeFrames(socket)[0]);
      const sync = () => syncTerminalLayout({
        term,
        fitAddon: { fit: () => {}, proposeDimensions: () => proposed },
        ptyClient: {
          supportsOrderedResize: true,
          sendResize: async (cols, rows) => { await client.sendResize(cols, rows); },
        },
        forceSend: false,
        repaint: true,
      });
      proposed = { cols: 90, rows: 24 };
      const pending = sync();
      jest.advanceTimersByTime(inFlight ? 120 : 20);
      proposed = { cols: 80, rows: 24 };
      const reversed = sync();
      jest.advanceTimersByTime(120);
      acknowledge(socket, resizeFrames(socket).at(-1)!);
      if (inFlight) {
        await flushPromises();
        jest.advanceTimersByTime(120);
        acknowledge(socket, resizeFrames(socket).at(-1)!);
      }
      await Promise.all([pending, reversed]);
      expect(term.cols).toBe(proposed.cols);
      expect(resizeFrames(socket)).toHaveLength(inFlight ? 3 : 1);
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test("makes acknowledged resize progress while geometry keeps changing", async () => {
    jest.useFakeTimers();
    const committed: number[] = [];
    const client = createPtySocketClient(
      clientOpts({ onResizeAck: (cols) => committed.push(cols) }),
      dependencies(),
    );
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      if (!socket) throw new Error("missing socket");
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: [PTY_ATTACH_CAPABILITY.ORDERED_RESIZE_ACK] }));
      let consumedFrames = 0;
      const acknowledgeSentResizes = (): void => {
        const frames = socket.jsonFrames();
        for (const frame of frames.slice(consumedFrames)) {
          if (typeof frame === "object" && frame !== null && "type" in frame && frame.type === "resize") {
            socket.message(JSON.stringify({ ...frame, type: "resize_ack" }));
          }
        }
        consumedFrames = frames.length;
      };
      acknowledgeSentResizes();
      committed.length = 0;

      // A drag never gives the old 120ms trailing debounce time to settle.
      for (let step = 1; step <= 20; step++) {
        void client.sendResize(80 + step, 24);
        jest.advanceTimersByTime(20);
        acknowledgeSentResizes();
      }

      expect(committed.length).toBeGreaterThanOrEqual(2);
      jest.advanceTimersByTime(500);
      acknowledgeSentResizes();
      expect(committed.at(-1)).toBe(100);
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test.each([80, 300])("converges during continuous output with %sms acknowledgment latency", async (ackDelay) => {
    jest.useFakeTimers();
    const committed: number[] = [];
    const output: number[] = [];
    const outstanding = new Set<number>();
    let maxOutstanding = 0;
    const client = createPtySocketClient(clientOpts({
      onResizeAck: (cols) => committed.push(cols),
      onBinaryData: (bytes) => output.push(bytes[0]),
    }), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        send(data);
        if (typeof data !== "string") return;
        const frame = JSON.parse(data) as ResizeFrame;
        if (frame.type !== "resize" || frame.resizeId === undefined) return;
        const id = frame.resizeId;
        outstanding.add(id);
        maxOutstanding = Math.max(maxOutstanding, outstanding.size);
        setTimeout(() => {
          outstanding.delete(id);
          acknowledge(socket, frame);
        }, ackDelay);
      };
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: [PTY_ATTACH_CAPABILITY.ORDERED_RESIZE_ACK] }));
      jest.advanceTimersByTime(ackDelay);
      committed.length = 0;
      for (let step = 1; step <= 90; step++) {
        void client.sendResize(80 + step, 24);
        socket.message(new Uint8Array([step]).buffer);
        jest.advanceTimersByTime(20);
      }
      expect(committed.length).toBeGreaterThanOrEqual(3); // before proposals stop
      jest.advanceTimersByTime(ackDelay + 120);
      expect(committed.at(-1)).toBe(170);
      expect(output).toEqual(Array.from({ length: 90 }, (_, index) => index + 1));
      expect(maxOutstanding).toBe(1);
      expect(outstanding.size).toBe(0);
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test("serializes delayed acknowledgments and drains FIFO output before the latest queued barrier", async () => {
    jest.useFakeTimers();
    const events: string[] = [];
    let proposed = { cols: 80, rows: 24 };
    const client = createPtySocketClient(clientOpts({
      getProposedDimensions: () => proposed,
      onResizeAck: (cols) => events.push(`ack:${cols}`),
      onBinaryData: (bytes) => events.push(`data:${bytes[0]}`),
      onPtyReady: () => events.push("ready"),
    }), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: [PTY_ATTACH_CAPABILITY.ORDERED_RESIZE_ACK] }));
      acknowledge(socket, resizeFrames(socket)[0]);
      events.length = 0;

      const firstSettlement = client.sendResize(90, 24);
      jest.advanceTimersByTime(120);
      const first = resizeFrames(socket).at(-1)!;
      expect(first.cols).toBe(90);
      let settled = false;
      for (let step = 1; step <= 50; step++) {
        proposed = { cols: 90 + step, rows: 24 };
        void client.sendResize(proposed.cols, proposed.rows).then(() => { settled = true; });
        socket.message(new Uint8Array([step]).buffer);
        if (step === 25) socket.message(JSON.stringify({ type: "pty_ready" }));
        jest.advanceTimersByTime(20);
      }
      // RTT exceeds many send periods; transport still has only one active resize.
      expect(resizeFrames(socket)).toHaveLength(2);
      expect(events).toEqual([]);
      await flushPromises();
      expect(settled).toBe(false);
      acknowledge(socket, first);
      expect(events).toEqual([
        "ack:90",
        ...Array.from({ length: 25 }, (_, index) => `data:${index + 1}`),
        "ready",
        ...Array.from({ length: 25 }, (_, index) => `data:${index + 26}`),
      ]);
      const latest = resizeFrames(socket).at(-1)!;
      expect(resizeFrames(socket)).toHaveLength(3);
      expect(latest.cols).toBe(140);
      await flushPromises();
      expect(settled).toBe(false);
      socket.message(new Uint8Array([99]).buffer);
      acknowledge(socket, first); // old ack cannot commit or release the newer barrier
      expect(events.at(-1)).toBe("data:50");
      acknowledge(socket, latest);
      expect(events.slice(-2)).toEqual(["ack:140", "data:99"]);
      expect(await firstSettlement).toBe("acknowledged");
      await flushPromises();
      expect(settled).toBe(true);
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test.each(["close", "reconnect", "disconnect"] as const)("cancels active and queued resizes on %s", async (action) => {
    jest.useFakeTimers();
    const committed: number[] = [];
    const client = createPtySocketClient(clientOpts({ onResizeAck: (cols) => committed.push(cols) }), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: [PTY_ATTACH_CAPABILITY.ORDERED_RESIZE_ACK] }));
      acknowledge(socket, resizeFrames(socket)[0]);
      committed.length = 0;
      const active = client.sendResize(90, 24);
      jest.advanceTimersByTime(120);
      const queued = client.sendResize(100, 24);
      const staleHandler = socket.onmessage;
      const framesBefore = resizeFrames(socket).length;
      if (action === "disconnect") socket.close();
      else client[action]();
      expect(await active).toBe("cancelled");
      expect(await queued).toBe("cancelled");
      await flushPromises();
      staleHandler?.({ data: JSON.stringify({ ...resizeFrames(socket).at(-1), type: "resize_ack" }) });
      jest.advanceTimersByTime(1000);
      expect(resizeFrames(socket)).toHaveLength(framesBefore);
      expect(committed).toEqual([]);
      if (action === "reconnect") {
        const replacement = FakeWebSocket.instances[1];
        replacement.open();
        replacement.message(JSON.stringify({ type: "attach_ack", capabilities: [PTY_ATTACH_CAPABILITY.ORDERED_RESIZE_ACK] }));
        acknowledge(replacement, resizeFrames(replacement)[0]);
        expect(committed).toEqual([80]);
      }
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test("handles same-size, reversion, forced and immediate proposals without superseding an active ack", async () => {
    jest.useFakeTimers();
    let proposed = { cols: 80, rows: 24 };
    const committed: number[] = [];
    const client = createPtySocketClient(clientOpts({
      getProposedDimensions: () => proposed,
      onResizeAck: (cols) => committed.push(cols),
    }), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: [PTY_ATTACH_CAPABILITY.ORDERED_RESIZE_ACK] }));
      acknowledge(socket, resizeFrames(socket)[0]);
      expect(await client.sendResize(80, 24)).toBe("acknowledged");
      const abandoned = client.sendResize(90, 24);
      expect(await client.sendResize(80, 24)).toBe("acknowledged");
      expect(await abandoned).toBe("acknowledged");
      jest.advanceTimersByTime(200);
      expect(resizeFrames(socket)).toHaveLength(1);

      proposed = { cols: 90, rows: 24 };
      const active = client.sendFitResize({ immediate: true });
      expect(resizeFrames(socket)).toHaveLength(2);
      const first = resizeFrames(socket).at(-1)!;
      void client.sendResize(100, 24);
      const sameSize = client.sendResize(90, 24); // discard queued 100, await active 90
      acknowledge(socket, first);
      expect(await active).toBe("acknowledged");
      expect(await sameSize).toBe("acknowledged");
      jest.advanceTimersByTime(200);
      expect(resizeFrames(socket)).toHaveLength(2);

      const forced = client.sendFitResize({ force: true, immediate: true });
      const second = resizeFrames(socket).at(-1)!;
      expect(second.cols).toBe(90);
      expect(second.resizeId).not.toBe(first.resizeId);
      proposed = { cols: 110, rows: 24 };
      const immediate = client.sendFitResize({ immediate: true });
      expect(resizeFrames(socket)).toHaveLength(3); // immediate still serializes
      acknowledge(socket, second);
      const third = resizeFrames(socket).at(-1)!;
      expect(third.cols).toBe(110); // no extra timer after active ack
      expect(resizeFrames(socket)).toHaveLength(4);
      acknowledge(socket, third);
      expect(await forced).toBe("acknowledged");
      expect(await immediate).toBe("acknowledged");
      expect(committed).toEqual([80, 90, 90, 110]);
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test("drains prior output before an immediate resize requested by an ack callback", async () => {
    let proposed = { cols: 80, rows: 24 };
    const events: number[] = [];
    let resizeOnAck = false;
    const client = createPtySocketClient(clientOpts({
      getProposedDimensions: () => proposed,
      onResizeAck: () => {
        if (resizeOnAck) {
          resizeOnAck = false;
          proposed = { cols: 100, rows: 24 };
          void client.sendFitResize({ immediate: true });
        }
      },
      onBinaryData: (bytes) => events.push(bytes[0]),
    }), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: [PTY_ATTACH_CAPABILITY.ORDERED_RESIZE_ACK] }));
      socket.message(new Uint8Array([1]).buffer);
      socket.message(new Uint8Array([2]).buffer);
      resizeOnAck = true;
      acknowledge(socket, resizeFrames(socket)[0]);
      expect(events).toEqual([1, 2]);
      expect(resizeFrames(socket).at(-1)?.cols).toBe(100);
      socket.message(new Uint8Array([3]).buffer);
      expect(events).toEqual([1, 2]);
      acknowledge(socket, resizeFrames(socket).at(-1)!);
      expect(events).toEqual([1, 2, 3]);
    } finally {
      client.close();
    }
  });

  test("supports latest-value delivery and immediate resize for legacy peers", async () => {
    jest.useFakeTimers();
    let proposed = { cols: 80, rows: 24 };
    const chunks: number[] = [];
    const client = createPtySocketClient(clientOpts({
      getTermDimensions: () => proposed,
      onBinaryData: (bytes) => chunks.push(bytes[0]),
    }), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack" }));
      for (let step = 1; step <= 20; step++) {
        expect(await client.sendResize(80 + step, 24)).toBe("acknowledged");
        jest.advanceTimersByTime(20);
      }
      expect(resizeFrames(socket).length).toBeGreaterThanOrEqual(2);
      jest.advanceTimersByTime(120);
      expect(resizeFrames(socket).at(-1)).toEqual({ type: "resize", cols: 100, rows: 24 });
      socket.message(new Uint8Array([1]).buffer);
      expect(chunks).toEqual([1]); // legacy has no ordered output barrier
      proposed = { cols: 110, rows: 24 };
      expect(await client.sendFitResize({ immediate: true })).toBe("acknowledged");
      expect(resizeFrames(socket).at(-1)).toEqual({ type: "resize", cols: 110, rows: 24 });
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test.each(["reconnect", "take-control"] as const)("ignores retired attach paint callbacks after %s", async (action) => {
    const paintCallbacks: FrameRequestCallback[] = [];
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback): number => paintCallbacks.push(callback),
    });
    const client = createPtySocketClient(clientOpts(), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: [PTY_ATTACH_CAPABILITY.ORDERED_RESIZE_ACK] }));
      if (action === "reconnect") {
        client.reconnect();
        await flushPromises();
      } else {
        socket.sent = [];
        socket.message(JSON.stringify({ type: "control_granted" }));
      }
      const replacement = action === "reconnect" ? FakeWebSocket.instances[1] : socket;
      if (action === "reconnect") replacement.open();
      while (paintCallbacks.length) paintCallbacks.shift()!(0);
      expect(replacement.jsonFrames()).toEqual([{ type: "attach", cols: 80, rows: 24, prefillMode: "none", capabilities: ["output-ack"] }]);
    } finally {
      client.close();
    }
  });

  test.each(["full", "viewport"] as const)("preserves %s attach finalization before a callback-requested resize", async (prefillMode) => {
    const events: string[] = [];
    let proposed = { cols: 80, rows: 24 };
    const client = createPtySocketClient(clientOpts({
      prefillMode,
      getProposedDimensions: () => proposed,
      onResizeAck: (cols) => events.push(`ack:${cols}`),
      onBinaryData: (bytes) => events.push(`data:${bytes[0]}`),
      onReplacePrefill: () => events.push("replace"),
      onPrefillDone: () => {
        events.push("prefill");
        proposed = { cols: 90, rows: 24 };
        void client.sendFitResize({ immediate: true });
      },
      onPtyReady: () => events.push("ready"),
    }), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: [PTY_ATTACH_CAPABILITY.ORDERED_RESIZE_ACK] }));
      socket.message(new Uint8Array([1]).buffer);
      if (prefillMode === "viewport") socket.message(JSON.stringify({ type: "prefill_viewport" }));
      socket.message(new Uint8Array([2]).buffer);
      socket.message(JSON.stringify({ type: "prefill_done" }));
      socket.message(JSON.stringify({ type: "pty_ready" }));
      expect(events).toEqual([]);
      acknowledge(socket, resizeFrames(socket)[0]);
      expect(events).toEqual([
        "ack:80", "data:1", ...(prefillMode === "viewport" ? ["replace"] : []), "data:2", "prefill", "ready",
      ]);
      expect(resizeFrames(socket).at(-1)?.cols).toBe(90);
      socket.message(new Uint8Array([3]).buffer);
      expect(events.at(-1)).toBe("ready");
      acknowledge(socket, resizeFrames(socket).at(-1)!);
      expect(events.slice(-2)).toEqual(["ack:90", "data:3"]);
    } finally {
      client.close();
    }
  });

  test("bounds ordered output buffering and cancels queued geometry on overflow", async () => {
    const client = createPtySocketClient(clientOpts(), dependencies());
    try {
      client.connect();
      await flushPromises();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message(JSON.stringify({ type: "attach_ack", capabilities: [PTY_ATTACH_CAPABILITY.ORDERED_RESIZE_ACK] }));
      const pending = client.sendResize(90, 24);
      socket.message(new ArrayBuffer(1_048_576));
      expect(client.isOpen).toBe(true);
      socket.message(new ArrayBuffer(1));
      expect(client.isOpen).toBe(false);
      expect(await pending).toBe("cancelled");
    } finally {
      client.close();
    }
  });

  test("foreground orchestration ignores the old epoch timeout and arms a fresh deadline", async () => {
    const client = createPtySocketClient(clientOpts(), dependencies());
    client.connect();
    await flushPromises();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    let visible = true;
    let epoch = 1;
    let reconnects = 0;
    const controller = { ptyClient: client, isConnected: true, forceRepaint: () => {}, resetRetry: () => {}, reconnect: () => { reconnects++; } };
    const environment = { isVisible: () => visible, visibilityEpoch: () => epoch };
    const timers = spyOn(globalThis, "setTimeout");
    try {
      const first = resumeMobileTerminal(controller, 1_000, environment);
      const oldTimeout = timers.mock.calls.at(-1)?.[0];
      visible = false; epoch++;
      visible = true; epoch++;
      const second = resumeMobileTerminal(controller, 1_000, environment);
      if (typeof oldTimeout !== "function") throw new Error("missing old probe timer");
      oldTimeout();
      await flushPromises();
      expect(reconnects).toBe(0);
      expect(timers.mock.calls.filter(([, delay]) => delay === 400)).toHaveLength(2);
      socket.message(JSON.stringify({ type: "pong" }));
      await Promise.all([first, second]);
      expect(reconnects).toBe(0);
    } finally { client.close(); timers.mockRestore(); }
  });

  test("foreground probe resolves on pong without reattaching", async () => {
    const client = createPtySocketClient(clientOpts(), dependencies());
    client.connect();
    await flushPromises();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    const before = socket.jsonFrames().length;
    try {
      const probe = client.probe();
      expect(socket.jsonFrames().slice(before)).toEqual([{ type: "ping" }]);
      socket.message(JSON.stringify({ type: "pong" }));
      expect(await probe).toBe(true);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      client.close();
    }
  });

  test("a foreground probe send failure reports a dead socket rather than throwing", async () => {
    const client = createPtySocketClient(clientOpts(), dependencies());
    client.connect();
    await flushPromises();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.send = () => { throw new Error("network unavailable"); };
    try { expect(await client.probe()).toBe(false); }
    finally { client.close(); }
  });

  test("foreground probe times out at 400ms and retiring a socket cancels a pending probe", async () => {
    const client = createPtySocketClient(clientOpts(), dependencies());
    client.connect();
    await flushPromises();
    FakeWebSocket.instances[0].open();
    const timers = spyOn(globalThis, "setTimeout");
    try {
      const pending = client.probe();
      expect(client.probe()).toBe(pending);
      const timer = timers.mock.calls.at(-1);
      expect(timer?.[1]).toBe(400);
      const callback = timer?.[0];
      if (typeof callback !== "function") throw new Error("missing probe timeout");
      callback(); // Advance this real boundary callback without any wall-clock sleep.
      expect(await pending).toBe(false);
      const cancelled = client.probe();
      client.close();
      expect(await cancelled).toBe(false);
      expect(await client.probe()).toBe(false);
    } finally { client.close(); timers.mockRestore(); }
  });

  test("buffers terminal output behind ordered resize until resize_ack", async () => {
    const chunks: number[][] = [];
    const client = createPtySocketClient(
      clientOpts({ onBinaryData: (data) => chunks.push([...data]) }),
      dependencies(),
    );

    client.connect();
    await flushPromises();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message(JSON.stringify({ type: "attach_ack", capabilities: [PTY_ATTACH_CAPABILITY.ORDERED_RESIZE_ACK] }));
    const resizeFrame = socket.jsonFrames().find((frame): frame is { readonly type: "resize"; readonly resizeId: number; readonly cols: number; readonly rows: number } => {
      return typeof frame === "object" && frame !== null && (frame as { readonly type?: unknown }).type === "resize";
    });
    if (!resizeFrame) throw new Error("missing ordered resize frame");
    expect(resizeFrame).toEqual({ type: "resize", resizeId: 1, cols: 80, rows: 24 });

    socket.message(new Uint8Array([1, 2, 3]).buffer);
    expect(chunks).toEqual([]);

    socket.message(JSON.stringify({ type: "resize_ack", resizeId: resizeFrame.resizeId, cols: 80, rows: 24 }));
    expect(chunks).toEqual([[1, 2, 3]]);

    client.close();
  });
});
