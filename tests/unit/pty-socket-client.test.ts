import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { PTY_ATTACH_CAPABILITY } from "../../src/pty-websocket-contract.ts";
import { createPtySocketClient, type PtySocketClientDependencies, type PtySocketClientOpts } from "../../public/pty-socket-client.ts";

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
  test("opens a socket and sends the attach handshake", async () => {
    let attached = 0;
    const client = createPtySocketClient(clientOpts({ onAttach: () => { attached++; } }), dependencies());

    client.connect();
    await flushPromises();
    FakeWebSocket.instances[0]?.open();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(new URL(FakeWebSocket.instances[0].url).href).toBe("ws://localhost:18790/ws/pty?session=alpha");
    expect(FakeWebSocket.instances[0].jsonFrames()[0]).toEqual({ type: "attach", cols: 80, rows: 24, prefillMode: "none" });
    expect(attached).toBe(1);

    client.close();
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
      expect(replacement.jsonFrames()).toEqual([{ type: "attach", cols: 80, rows: 24, prefillMode: "none" }]);
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
