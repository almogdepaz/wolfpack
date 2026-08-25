import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
