/**
 * BrokerClient transport tests.
 *
 * Uses a tiny mock broker that speaks the wire protocol over a real Unix
 * socket. The cargo `socket_integration.rs` suite covers the broker side;
 * these tests cover the TS client's framing, correlation, demux, and
 * reconnect behavior in isolation.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

import {
  BrokerClient,
  BrokerNotConnectedError,
  BrokerRequestTimeoutError,
} from "../../src/broker/client";
import {
  encodeFrame,
  FrameParser,
  FRAME_KIND_CONTROL_REQUEST,
  FRAME_KIND_CONTROL_RESPONSE,
  FRAME_KIND_EVENT,
  FRAME_KIND_INPUT_BINARY,
  FRAME_KIND_OUTPUT_BINARY,
  type ControlRequest,
  type ControlResponse,
  type EventBody,
  type Frame,
  type InputBinaryFrame,
} from "../../src/broker/codec";

const SAMPLE_UUID = "550e8400-e29b-41d4-a716-446655440000";

interface MockServer {
  socketPath: string;
  server: net.Server;
  connections: net.Socket[];
  /** Fires for each control_request the server receives. */
  onRequest?: (req: ControlRequest, sock: net.Socket) => void;
  /** Fires for each input_binary the server receives. */
  onInput?: (frame: InputBinaryFrame, sock: net.Socket) => void;
  close: () => Promise<void>;
  send: (sock: net.Socket, frame: Frame) => void;
  sendRaw: (sock: net.Socket, bytes: Uint8Array) => void;
  broadcast: (frame: Frame) => void;
}

function makeSocketPath(): string {
  return `/tmp/wp-${randomUUID().slice(0, 8)}.sock`;
}

async function startMockServer(socketPath: string): Promise<MockServer> {
  // Clear any stale socket from a previous bound process.
  try { fs.unlinkSync(socketPath); } catch { /* ignore */ }

  const connections: net.Socket[] = [];
  const ctx: MockServer = {
    socketPath,
    connections,
    server: undefined as unknown as net.Server,
    onRequest: undefined,
    onInput: undefined,
    close: async () => {
      for (const c of connections) c.destroy();
      await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
      try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
    },
    send: (sock: net.Socket, frame: Frame) => {
      sock.write(encodeFrame(frame));
    },
    sendRaw: (sock: net.Socket, bytes: Uint8Array) => {
      sock.write(bytes);
    },
    broadcast: (frame: Frame) => {
      const bytes = encodeFrame(frame);
      for (const c of connections) c.write(bytes);
    },
  };

  const server = net.createServer((sock) => {
    connections.push(sock);
    const parser = new FrameParser();
    sock.on("data", (chunk: Buffer) => {
      try {
        const detached = new Uint8Array(chunk.length);
        detached.set(chunk);
        parser.push(detached);
        for (const f of parser.drain()) {
          if (f.kind === FRAME_KIND_CONTROL_REQUEST) ctx.onRequest?.(f.value, sock);
          else if (f.kind === FRAME_KIND_INPUT_BINARY) ctx.onInput?.(f.value, sock);
        }
      } catch (e) {
        sock.destroy(e instanceof Error ? e : new Error(String(e)));
      }
    });
    sock.on("error", () => { /* ignore */ });
    sock.on("close", () => {
      const i = connections.indexOf(sock);
      if (i >= 0) connections.splice(i, 1);
    });
  });
  ctx.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return ctx;
}

async function waitFor(pred: () => boolean, timeoutMs = 2000, intervalMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

let activeServer: MockServer | null = null;
let activeClient: BrokerClient | null = null;

beforeEach(() => {
  activeServer = null;
  activeClient = null;
});

afterEach(async () => {
  if (activeClient) {
    try { activeClient.close(); } catch { /* ignore */ }
    activeClient = null;
  }
  if (activeServer) {
    try { await activeServer.close(); } catch { /* ignore */ }
    activeServer = null;
  }
});

async function bootClientToServer(opts: { onEvent?: (e: EventBody) => void } = {}): Promise<{
  server: MockServer;
  client: BrokerClient;
}> {
  const socketPath = makeSocketPath();
  const server = await startMockServer(socketPath);
  activeServer = server;
  let connected = false;
  const client = new BrokerClient({
    socketPath,
    reconnectInitialDelayMs: 20,
    reconnectMaxDelayMs: 200,
    requestTimeoutMs: 1000,
    onConnect: () => { connected = true; },
    onEvent: opts.onEvent,
  });
  activeClient = client;
  client.start();
  await waitFor(() => connected, 2000);
  return { server, client };
}

describe("BrokerClient: RPC correlation", () => {
  test("request resolves with matching response id", async () => {
    const { server, client } = await bootClientToServer();
    server.onRequest = (req, sock) => {
      server.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: {
          id: req.id,
          status: "ok",
          payload: { kind: "list_sessions", sessions: [] },
        },
      });
    };
    const resp = await client.request("list_sessions", {});
    expect(resp.status).toBe("ok");
    expect(resp.payload?.kind).toBe("list_sessions");
  });

  test("out-of-order responses still correlate", async () => {
    const { server, client } = await bootClientToServer();
    const seen: number[] = [];
    server.onRequest = (req, sock) => {
      seen.push(req.id);
      // delay first request, fast-track second
      const delay = req.id === seen[0] ? 30 : 0;
      setTimeout(() => {
        server.send(sock, {
          kind: FRAME_KIND_CONTROL_RESPONSE,
          value: {
            id: req.id,
            status: "ok",
            payload: { kind: req.method, echoed_id: req.id },
          },
        });
      }, delay);
    };
    const [a, b] = await Promise.all([
      client.request("first", {}),
      client.request("second", {}),
    ]);
    expect(a.payload?.echoed_id).toBe(seen[0]);
    expect(b.payload?.echoed_id).toBe(seen[1]);
    expect(seen[0]).not.toBe(seen[1]);
  });

  test("error responses are propagated to the caller", async () => {
    const { server, client } = await bootClientToServer();
    server.onRequest = (req, sock) => {
      server.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: {
          id: req.id,
          status: "error",
          error: { code: "unknown_session", message: "no such id" },
        },
      });
    };
    const resp = await client.request("session_info", { session_id: SAMPLE_UUID });
    expect(resp.status).toBe("error");
    expect(resp.error?.code).toBe("unknown_session");
  });

  test("request rejects with timeout when broker silent", async () => {
    const { client } = await bootClientToServer();
    // Server has no onRequest handler — request will sit and time out.
    let err: unknown;
    try {
      await client.request("list_sessions", {}, { timeoutMs: 50 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrokerRequestTimeoutError);
  });

  test("request rejects when client is not connected", async () => {
    const client = new BrokerClient({ socketPath: "/nonexistent/never/exists.sock" });
    activeClient = client;
    let err: unknown;
    try {
      await client.request("list_sessions", {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrokerNotConnectedError);
  });
});

describe("BrokerClient: output demux", () => {
  test("output_binary frames route only to matching session subscribers", async () => {
    const { server, client } = await bootClientToServer();
    const otherUuid = "11111111-1111-1111-1111-111111111111";
    const targetChunks: Uint8Array[] = [];
    const otherChunks: Uint8Array[] = [];
    client.subscribeOutput(SAMPLE_UUID, (f) => { targetChunks.push(f.data); });
    client.subscribeOutput(otherUuid, (f) => { otherChunks.push(f.data); });

    server.broadcast({
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: { sessionId: SAMPLE_UUID, seq: 1n, data: new Uint8Array([0xAA]) },
    });
    server.broadcast({
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: { sessionId: otherUuid, seq: 1n, data: new Uint8Array([0xBB]) },
    });
    server.broadcast({
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: { sessionId: SAMPLE_UUID, seq: 2n, data: new Uint8Array([0xCC]) },
    });

    await waitFor(() => targetChunks.length === 2 && otherChunks.length === 1);
    expect(targetChunks[0][0]).toBe(0xAA);
    expect(targetChunks[1][0]).toBe(0xCC);
    expect(otherChunks[0][0]).toBe(0xBB);
  });

  test("multiple subscribers per session each receive every frame", async () => {
    const { server, client } = await bootClientToServer();
    const a: bigint[] = [];
    const b: bigint[] = [];
    client.subscribeOutput(SAMPLE_UUID, (f) => a.push(f.seq));
    client.subscribeOutput(SAMPLE_UUID, (f) => b.push(f.seq));
    server.broadcast({
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: { sessionId: SAMPLE_UUID, seq: 7n, data: new Uint8Array([1]) },
    });
    await waitFor(() => a.length === 1 && b.length === 1);
    expect(a[0]).toBe(7n);
    expect(b[0]).toBe(7n);
  });

  test("unsubscribe removes only that callback", async () => {
    const { server, client } = await bootClientToServer();
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = client.subscribeOutput(SAMPLE_UUID, () => a.push(1));
    client.subscribeOutput(SAMPLE_UUID, () => b.push(1));
    expect(client.outputSubscriptionCount()).toBe(1);
    unsubA();
    server.broadcast({
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: { sessionId: SAMPLE_UUID, seq: 1n, data: new Uint8Array([1]) },
    });
    await waitFor(() => b.length === 1);
    expect(a.length).toBe(0);
    expect(b.length).toBe(1);
  });

  test("subscriber throwing does not break demux for other subscribers", async () => {
    const { server, client } = await bootClientToServer();
    const observed: bigint[] = [];
    client.subscribeOutput(SAMPLE_UUID, () => { throw new Error("boom"); });
    client.subscribeOutput(SAMPLE_UUID, (f) => observed.push(f.seq));
    server.broadcast({
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: { sessionId: SAMPLE_UUID, seq: 9n, data: new Uint8Array([1]) },
    });
    await waitFor(() => observed.length === 1);
    expect(observed[0]).toBe(9n);
  });
});

describe("BrokerClient: events", () => {
  test("event frames hit the global handler", async () => {
    const events: EventBody[] = [];
    const { server } = await bootClientToServer({ onEvent: (e) => events.push(e) });
    server.broadcast({
      kind: FRAME_KIND_EVENT,
      value: { event: "session_resized", session_id: SAMPLE_UUID, cols: 100, rows: 40 },
    });
    server.broadcast({
      kind: FRAME_KIND_EVENT,
      value: { event: "snapshot_invalidated", session_id: SAMPLE_UUID },
    });
    await waitFor(() => events.length === 2);
    expect(events[0].event).toBe("session_resized");
    expect(events[1].event).toBe("snapshot_invalidated");
  });
});

describe("BrokerClient: input_binary", () => {
  test("writeInput emits a properly-framed input_binary on the wire", async () => {
    const { server, client } = await bootClientToServer();
    const received: InputBinaryFrame[] = [];
    server.onInput = (frame) => received.push(frame);
    client.writeInput(SAMPLE_UUID, new Uint8Array([0x03])); // ^C
    client.writeInput(SAMPLE_UUID, new Uint8Array([0x71, 0x0d])); // q\r
    await waitFor(() => received.length === 2);
    expect(received[0].sessionId).toBe(SAMPLE_UUID);
    expect(received[0].data[0]).toBe(0x03);
    expect(received[1].data[0]).toBe(0x71);
    expect(received[1].data[1]).toBe(0x0d);
  });

  test("writeInput throws BrokerNotConnectedError when offline", () => {
    const client = new BrokerClient({ socketPath: "/nonexistent/never/exists.sock" });
    activeClient = client;
    expect(() => client.writeInput(SAMPLE_UUID, new Uint8Array([0x03]))).toThrow(
      BrokerNotConnectedError,
    );
  });
});

describe("BrokerClient: reconnect", () => {
  test("reconnects after server restart and re-fires onConnect", async () => {
    const socketPath = makeSocketPath();
    const server1 = await startMockServer(socketPath);
    activeServer = server1;
    let connectCount = 0;
    let disconnects = 0;
    const client = new BrokerClient({
      socketPath,
      reconnectInitialDelayMs: 20,
      reconnectMaxDelayMs: 100,
      requestTimeoutMs: 500,
      onConnect: () => { connectCount++; },
      onDisconnect: () => { disconnects++; },
    });
    activeClient = client;
    client.start();
    await waitFor(() => connectCount === 1);

    // Drop the server. Client should disconnect, then keep retrying.
    await server1.close();
    activeServer = null;
    await waitFor(() => disconnects === 1);
    expect(client.isConnected()).toBe(false);

    // Bring server back on the same path. Client should reconnect.
    const server2 = await startMockServer(socketPath);
    activeServer = server2;
    await waitFor(() => connectCount === 2, 3000);
    expect(client.isConnected()).toBe(true);

    // RPC works again on the new connection.
    server2.onRequest = (req, sock) => {
      server2.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: { id: req.id, status: "ok", payload: { kind: req.method } },
      });
    };
    const resp = await client.request("ping", {});
    expect(resp.status).toBe("ok");
  });

  test("in-flight RPCs reject with transport error on disconnect", async () => {
    const { server, client } = await bootClientToServer();
    // Server never replies to the request — it'll be in-flight when we kill it.
    server.onRequest = () => { /* intentionally silent */ };
    const pending = client.request("list_sessions", {}, { timeoutMs: 5000 });
    // Give the request a moment to actually be queued.
    await new Promise((r) => setTimeout(r, 30));
    await server.close();
    activeServer = null;
    let err: unknown;
    try { await pending; } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BrokerNotConnectedError);
  });

  test("output subscribers persist across reconnects", async () => {
    const socketPath = makeSocketPath();
    const server1 = await startMockServer(socketPath);
    activeServer = server1;
    let connects = 0;
    const client = new BrokerClient({
      socketPath,
      reconnectInitialDelayMs: 20,
      reconnectMaxDelayMs: 100,
      onConnect: () => { connects++; },
    });
    activeClient = client;
    const seen: bigint[] = [];
    client.subscribeOutput(SAMPLE_UUID, (f) => seen.push(f.seq));
    client.start();
    await waitFor(() => connects === 1);

    await server1.close();
    activeServer = null;
    const server2 = await startMockServer(socketPath);
    activeServer = server2;
    await waitFor(() => connects === 2, 3000);

    server2.broadcast({
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: { sessionId: SAMPLE_UUID, seq: 100n, data: new Uint8Array([1]) },
    });
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toBe(100n);
  });
});

describe("BrokerClient: subscribe/unsubscribe RPC", () => {
  test("subscribe issues a subscribe RPC and tracks the active set", async () => {
    const { server, client } = await bootClientToServer();
    const subscribed: string[] = [];
    server.onRequest = (req, sock) => {
      if (req.method === "subscribe") {
        subscribed.push((req.params as { session_id: string }).session_id);
      }
      server.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: { id: req.id, status: "ok", payload: { kind: req.method, ok: true, current_seq: 0 } },
      });
    };
    const resp = await client.subscribe(SAMPLE_UUID);
    expect(resp.status).toBe("ok");
    expect(subscribed).toEqual([SAMPLE_UUID]);
    expect(client.isSubscribed(SAMPLE_UUID)).toBe(true);
    expect(client.activeSubscriptionCount()).toBe(1);
  });

  test("subscribe forwards since_seq when provided", async () => {
    const { server, client } = await bootClientToServer();
    let captured: Record<string, unknown> | null = null;
    server.onRequest = (req, sock) => {
      if (req.method === "subscribe") captured = req.params as Record<string, unknown>;
      server.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: { id: req.id, status: "ok", payload: { kind: req.method, ok: true } },
      });
    };
    await client.subscribe(SAMPLE_UUID, { sinceSeq: 1234n });
    expect(captured).not.toBeNull();
    expect(captured!.session_id).toBe(SAMPLE_UUID);
    expect(captured!.since_seq).toBe(1234);
  });

  test("subscribe clamps since_seq above Number.MAX_SAFE_INTEGER", async () => {
    const { server, client } = await bootClientToServer();
    let captured: Record<string, unknown> | null = null;
    server.onRequest = (req, sock) => {
      if (req.method === "subscribe") captured = req.params as Record<string, unknown>;
      server.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: { id: req.id, status: "ok", payload: { kind: req.method, ok: true } },
      });
    };

    await client.subscribe(SAMPLE_UUID, { sinceSeq: BigInt(Number.MAX_SAFE_INTEGER) + 123n });

    expect(captured).not.toBeNull();
    expect(captured!.since_seq).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("unsubscribe issues an unsubscribe RPC and drops from the active set", async () => {
    const { server, client } = await bootClientToServer();
    const seen: Array<{ method: string; sessionId: string }> = [];
    server.onRequest = (req, sock) => {
      const sid = (req.params as { session_id?: string }).session_id ?? "";
      seen.push({ method: req.method, sessionId: sid });
      server.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: { id: req.id, status: "ok", payload: { kind: req.method, ok: true } },
      });
    };
    await client.subscribe(SAMPLE_UUID);
    expect(client.isSubscribed(SAMPLE_UUID)).toBe(true);
    await client.unsubscribe(SAMPLE_UUID);
    expect(client.isSubscribed(SAMPLE_UUID)).toBe(false);
    expect(seen.map((s) => s.method)).toEqual(["subscribe", "unsubscribe"]);
  });

  test("unsubscribe on a never-subscribed session is a no-op", async () => {
    const { server, client } = await bootClientToServer();
    const calls: string[] = [];
    server.onRequest = (req, sock) => {
      calls.push(req.method);
      server.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: { id: req.id, status: "ok", payload: { kind: req.method } },
      });
    };
    await client.unsubscribe(SAMPLE_UUID);
    expect(calls.length).toBe(0);
  });

  test("re-issues subscribe for every active session on reconnect", async () => {
    const otherUuid = "11111111-1111-1111-1111-111111111111";
    const socketPath = makeSocketPath();
    const server1 = await startMockServer(socketPath);
    activeServer = server1;
    let connects = 0;
    const subscribesByConnection: string[][] = [[]];
    const handler = (req: ControlRequest, sock: net.Socket) => {
      if (req.method === "subscribe") {
        subscribesByConnection[subscribesByConnection.length - 1].push(
          (req.params as { session_id: string }).session_id,
        );
      }
      server1.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: { id: req.id, status: "ok", payload: { kind: req.method, ok: true } },
      });
    };
    server1.onRequest = handler;
    const client = new BrokerClient({
      socketPath,
      reconnectInitialDelayMs: 20,
      reconnectMaxDelayMs: 100,
      requestTimeoutMs: 1000,
      onConnect: () => { connects++; },
    });
    activeClient = client;
    client.start();
    await waitFor(() => connects === 1);
    await client.subscribe(SAMPLE_UUID);
    await client.subscribe(otherUuid);
    expect(subscribesByConnection[0]).toEqual([SAMPLE_UUID, otherUuid]);

    // Drop server. New connection should trigger re-subscribe for both.
    await server1.close();
    activeServer = null;
    subscribesByConnection.push([]);
    const server2 = await startMockServer(socketPath);
    activeServer = server2;
    server2.onRequest = (req, sock) => {
      if (req.method === "subscribe") {
        subscribesByConnection[subscribesByConnection.length - 1].push(
          (req.params as { session_id: string }).session_id,
        );
      }
      server2.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: { id: req.id, status: "ok", payload: { kind: req.method, ok: true } },
      });
    };
    await waitFor(() => connects === 2, 3000);
    await waitFor(() => subscribesByConnection[1].length === 2, 2000);
    expect(new Set(subscribesByConnection[1])).toEqual(new Set([SAMPLE_UUID, otherUuid]));
  });

  test("unsubscribe drops a session so reconnect does not re-subscribe it", async () => {
    const otherUuid = "22222222-2222-2222-2222-222222222222";
    const socketPath = makeSocketPath();
    const server1 = await startMockServer(socketPath);
    activeServer = server1;
    let connects = 0;
    const reissued: string[] = [];
    server1.onRequest = (req, sock) => {
      server1.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: { id: req.id, status: "ok", payload: { kind: req.method, ok: true } },
      });
    };
    const client = new BrokerClient({
      socketPath,
      reconnectInitialDelayMs: 20,
      reconnectMaxDelayMs: 100,
      onConnect: () => { connects++; },
    });
    activeClient = client;
    client.start();
    await waitFor(() => connects === 1);
    await client.subscribe(SAMPLE_UUID);
    await client.subscribe(otherUuid);
    await client.unsubscribe(SAMPLE_UUID);
    expect(client.isSubscribed(SAMPLE_UUID)).toBe(false);
    expect(client.isSubscribed(otherUuid)).toBe(true);

    await server1.close();
    activeServer = null;
    const server2 = await startMockServer(socketPath);
    activeServer = server2;
    server2.onRequest = (req, sock) => {
      if (req.method === "subscribe") {
        reissued.push((req.params as { session_id: string }).session_id);
      }
      server2.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: { id: req.id, status: "ok", payload: { kind: req.method, ok: true } },
      });
    };
    await waitFor(() => connects === 2, 3000);
    await waitFor(() => reissued.length >= 1, 2000);
    // Wait a beat to ensure no extra re-issue lands for the dropped session.
    await new Promise((r) => setTimeout(r, 50));
    expect(reissued).toEqual([otherUuid]);
  });

  test("subscribe while disconnected adds to active set and rejects", async () => {
    const client = new BrokerClient({ socketPath: "/nonexistent/never/exists.sock" });
    activeClient = client;
    let err: unknown;
    try {
      await client.subscribe(SAMPLE_UUID);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrokerNotConnectedError);
    expect(client.isSubscribed(SAMPLE_UUID)).toBe(true);
  });
});

describe("BrokerClient: protocol violation handling", () => {
  test("server-sent unknown kind drops the connection (and client retries)", async () => {
    const socketPath = makeSocketPath();
    const server = await startMockServer(socketPath);
    activeServer = server;
    let connects = 0;
    let protocolErrors = 0;
    const client = new BrokerClient({
      socketPath,
      reconnectInitialDelayMs: 20,
      reconnectMaxDelayMs: 50,
      requestTimeoutMs: 500,
      onConnect: () => { connects++; },
      onProtocolError: () => { protocolErrors++; },
    });
    activeClient = client;
    client.start();
    await waitFor(() => connects === 1);

    // Send a frame with an invalid kind. Length=0 keeps it parseable as a frame.
    const badFrame = new Uint8Array([0x7f, 0x00, 0x00, 0x00, 0x00]);
    for (const c of server.connections) c.write(badFrame);

    await waitFor(() => protocolErrors >= 1);
    // Client should auto-reconnect to the same server and re-fire onConnect.
    await waitFor(() => connects >= 2, 3000);
  });

  test("close() prevents further reconnect attempts", async () => {
    const socketPath = makeSocketPath();
    const server = await startMockServer(socketPath);
    activeServer = server;
    let connects = 0;
    const client = new BrokerClient({
      socketPath,
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 50,
      onConnect: () => { connects++; },
    });
    activeClient = client;
    client.start();
    await waitFor(() => connects === 1);
    client.close();
    activeClient = null;
    await server.close();
    activeServer = null;
    // Wait a beat — even with the server gone, no new connect should happen.
    await new Promise((r) => setTimeout(r, 100));
    expect(connects).toBe(1);
    expect(client.isConnected()).toBe(false);
    expect(() => client.start()).toThrow();
  });
});
