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

  test("writeInput rejects additional input while the broker socket is backpressured", async () => {
    const { server, client } = await bootClientToServer();
    await waitFor(() => server.connections.length === 1);
    server.connections[0].pause();

    let failure: unknown;
    for (let i = 0; i < 1024 && failure === undefined; i++) {
      try {
        client.writeInput(SAMPLE_UUID, new Uint8Array(16 * 1024));
      } catch (error) {
        failure = error;
      }
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("broker input backpressure");

    server.connections[0].resume();
    await waitFor(() => {
      try {
        client.writeInput(SAMPLE_UUID, new Uint8Array([0x03]));
        return true;
      } catch {
        return false;
      }
    });
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
    expect(client.outputSequence(SAMPLE_UUID)).toBeUndefined();
  });

  test("subscribe rejects broker error responses without tracking reconnect state", async () => {
    const { server, client } = await bootClientToServer();
    server.onRequest = (req, sock) => {
      server.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: {
          id: req.id,
          status: "error",
          error: { code: "session_not_alive", message: "session exited" },
        },
      });
    };

    await expect(client.subscribe(SAMPLE_UUID)).rejects.toThrow("session_not_alive");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.isSubscribed(SAMPLE_UUID)).toBe(false);
    expect(client.activeSubscriptionCount()).toBe(0);
  });

  test("subscribe transport failure does not leave reconnect state active", async () => {
    const { server, client } = await bootClientToServer();
    server.onRequest = (_req, sock) => sock.destroy();

    await expect(client.subscribe(SAMPLE_UUID)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.isSubscribed(SAMPLE_UUID)).toBe(false);
    expect(client.activeSubscriptionCount()).toBe(0);
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

  test("atomic snapshot subscription buffers live output until the renderer attaches", async () => {
    const { server, client } = await bootClientToServer();
    server.onRequest = (req, sock) => {
      server.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: {
          id: req.id,
          status: "ok",
          payload: { kind: "snapshot_subscribe", snapshot: { seq: 5 }, current_seq: 5, replay_truncated: false },
        },
      });
      server.send(sock, {
        kind: FRAME_KIND_OUTPUT_BINARY,
        value: { sessionId: SAMPLE_UUID, seq: 6n, data: new Uint8Array([6]) },
      });
    };

    await client.snapshotSubscribe(SAMPLE_UUID);
    const received: bigint[] = [];
    client.subscribeOutput(SAMPLE_UUID, (frame) => received.push(frame.seq));

    expect(client.isSubscribed(SAMPLE_UUID)).toBe(true);
    expect(client.outputSequence(SAMPLE_UUID)).toBe(6n);
    expect(received).toEqual([6n]);
  });

  test("subscription_dropped resumes after the last output delivered before the barrier", async () => {
    const { server, client } = await bootClientToServer();
    const sinceSeqs: Array<number | undefined> = [];
    server.onRequest = (req, sock) => {
      if (req.method === "subscribe") {
        sinceSeqs.push((req.params as { since_seq?: number }).since_seq);
      }
      server.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: { id: req.id, status: "ok", payload: { kind: req.method, ok: true, current_seq: 42 } },
      });
    };
    await client.subscribe(SAMPLE_UUID);

    server.broadcast({
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: { sessionId: SAMPLE_UUID, seq: 42n, data: new Uint8Array([1]) },
    });
    server.broadcast({
      kind: FRAME_KIND_EVENT,
      value: { event: "subscription_dropped", session_id: SAMPLE_UUID, lagged: 7 },
    });

    await waitFor(() => sinceSeqs.length === 2);
    expect(sinceSeqs).toEqual([undefined, 42]);
  });

  test("session exit waits for its final output sequence barrier", async () => {
    const observed: string[] = [];
    const { server, client } = await bootClientToServer({
      onEvent: (event) => observed.push(event.event),
    });
    server.onRequest = (req, sock) => server.send(sock, {
      kind: FRAME_KIND_CONTROL_RESPONSE,
      value: { id: req.id, status: "ok", payload: { kind: req.method, ok: true, current_seq: 0 } },
    });
    await client.subscribe(SAMPLE_UUID);
    client.subscribeOutput(SAMPLE_UUID, (frame) => observed.push(`output:${frame.seq}`));

    // Control/event traffic may overtake the output queue on the broker writer.
    server.broadcast({
      kind: FRAME_KIND_EVENT,
      value: { event: "session_exited", session_id: SAMPLE_UUID, final_seq: "2", exit_code: 0 },
    });
    server.broadcast({
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: { sessionId: SAMPLE_UUID, seq: 1n, data: new Uint8Array([1]) },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(observed).toEqual(["output:1"]);

    server.broadcast({
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: { sessionId: SAMPLE_UUID, seq: 2n, data: new Uint8Array([2]) },
    });
    await waitFor(() => observed.includes("session_exited"));
    expect(observed).toEqual(["output:1", "output:2", "session_exited"]);
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

  test("reconnect resumes after the last delivered frame, not the subscribe watermark", async () => {
    const socketPath = makeSocketPath();
    const server1 = await startMockServer(socketPath);
    activeServer = server1;
    let connects = 0;
    const reissuedSinceSeq: Array<number | undefined> = [];

    server1.onRequest = (req, sock) => {
      server1.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: {
          id: req.id,
          status: "ok",
          payload: { kind: req.method, ok: true, current_seq: 99 },
        },
      });
    };

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
    await client.subscribe(SAMPLE_UUID, { sinceSeq: 10n });
    const unsub = client.subscribeOutput(SAMPLE_UUID, () => {});
    // Simulate live output advancing seq before disconnect.
    server1.broadcast({
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: { sessionId: SAMPLE_UUID, seq: 42n, data: new Uint8Array([1]) },
    });
    await new Promise((r) => setTimeout(r, 10));

    await server1.close();
    activeServer = null;

    const server2 = await startMockServer(socketPath);
    activeServer = server2;
    server2.onRequest = (req, sock) => {
      if (req.method === "subscribe") {
        reissuedSinceSeq.push((req.params as { since_seq?: number }).since_seq);
      }
      server2.send(sock, {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: { id: req.id, status: "ok", payload: { kind: req.method, ok: true } },
      });
    };

    await waitFor(() => connects === 2, 3000);
    await waitFor(() => reissuedSinceSeq.length >= 1, 2000);
    expect(reissuedSinceSeq[0]).toBe(42);
    unsub();
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

  test("subscribe while disconnected rejects without adding reconnect state", async () => {
    const client = new BrokerClient({ socketPath: "/nonexistent/never/exists.sock" });
    activeClient = client;
    let err: unknown;
    try {
      await client.subscribe(SAMPLE_UUID);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrokerNotConnectedError);
    expect(client.isSubscribed(SAMPLE_UUID)).toBe(false);
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

describe("BrokerClient: request-timeout circuit breaker", () => {
  test("force-disconnects after N consecutive request timeouts", async () => {
    const socketPath = makeSocketPath();
    const server = await startMockServer(socketPath);
    activeServer = server;
    // Silent server: every request will hit its timeout.
    server.onRequest = () => { /* never reply */ };

    let connects = 0;
    let disconnects = 0;
    let trips = 0;
    const client = new BrokerClient({
      socketPath,
      reconnectInitialDelayMs: 20,
      reconnectMaxDelayMs: 100,
      requestTimeoutMs: 30,
      requestTimeoutCircuitBreakerThreshold: 3,
      onConnect: () => { connects++; },
      onDisconnect: () => { disconnects++; },
      onCircuitBreak: () => { trips++; },
    });
    activeClient = client;
    client.start();
    await waitFor(() => connects === 1);

    // Fire three back-to-back requests; each will time out, the third
    // should trip the breaker and force a disconnect.
    const results = await Promise.allSettled([
      client.request("a", {}),
      client.request("b", {}),
      client.request("c", {}),
    ]);
    for (const r of results) expect(r.status).toBe("rejected");

    await waitFor(() => trips === 1, 2000);
    await waitFor(() => disconnects >= 1, 2000);
    // Reconnect runs against the same (still-silent) server.
    await waitFor(() => connects >= 2, 3000);
  });

  test("a successful response resets the breaker counter", async () => {
    const socketPath = makeSocketPath();
    const server = await startMockServer(socketPath);
    activeServer = server;

    let connects = 0;
    let trips = 0;
    // First two requests are dropped; third gets a reply; fourth + fifth
    // dropped. With threshold=3, we expect NO trip — the successful reply
    // resets the counter so the new run-up is only length 2.
    let req = 0;
    server.onRequest = (r, sock) => {
      req++;
      if (req === 3) {
        server.send(sock, {
          kind: FRAME_KIND_CONTROL_RESPONSE,
          value: { id: r.id, status: "ok", payload: { kind: r.method } },
        });
      }
    };

    const client = new BrokerClient({
      socketPath,
      reconnectInitialDelayMs: 20,
      reconnectMaxDelayMs: 100,
      requestTimeoutMs: 30,
      requestTimeoutCircuitBreakerThreshold: 3,
      onConnect: () => { connects++; },
      onCircuitBreak: () => { trips++; },
    });
    activeClient = client;
    client.start();
    await waitFor(() => connects === 1);

    // Issue sequentially so the reply on r3 is observed AFTER r1/r2 have
    // already incremented the counter. Concurrent issue would let r3's
    // reset race ahead of the timeouts and defeat the point of the test.
    await expect(client.request("a", {})).rejects.toBeInstanceOf(BrokerRequestTimeoutError);
    await expect(client.request("b", {})).rejects.toBeInstanceOf(BrokerRequestTimeoutError);
    const ok = await client.request("c", {});
    expect(ok.status).toBe("ok");

    // Two more timeouts (4 + 5). Counter reset by r3 reply, so consecutive
    // run is only 2 < threshold(3) — breaker must NOT trip.
    await expect(client.request("d", {})).rejects.toBeInstanceOf(BrokerRequestTimeoutError);
    await expect(client.request("e", {})).rejects.toBeInstanceOf(BrokerRequestTimeoutError);
    // Deterministic proof the breaker won't trip: counter is at 2 (< threshold 3)
    // because r3's successful reply reset it. The reset path in
    // handleControlResponse is synchronous, so by the time we get here every
    // increment/reset has already happened — no need to wait on a fixed sleep.
    expect((client as unknown as { consecutiveRequestTimeouts: number }).consecutiveRequestTimeouts).toBe(2);
    expect(trips).toBe(0);
    expect(connects).toBe(1);
  });

  test("threshold=0 disables the breaker entirely", async () => {
    const socketPath = makeSocketPath();
    const server = await startMockServer(socketPath);
    activeServer = server;
    server.onRequest = () => { /* never reply */ };

    let connects = 0;
    let trips = 0;
    const client = new BrokerClient({
      socketPath,
      reconnectInitialDelayMs: 20,
      reconnectMaxDelayMs: 100,
      requestTimeoutMs: 25,
      requestTimeoutCircuitBreakerThreshold: 0,
      onConnect: () => { connects++; },
      onCircuitBreak: () => { trips++; },
    });
    activeClient = client;
    client.start();
    await waitFor(() => connects === 1);

    for (let i = 0; i < 5; i++) {
      await client.request("x", {}).catch(() => {});
    }
    expect(trips).toBe(0);
    expect(connects).toBe(1);
    expect(client.isConnected()).toBe(true);
  });
});
