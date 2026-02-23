import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Set WOLFPACK_TEST before importing serve.ts to prevent auto-listen
process.env.WOLFPACK_TEST = "1";

import { server, __setTmuxList } from "../../serve.ts";

// ── Fake tmux list (no real tmux needed) ──

__setTmuxList(async () => []);

// ── Fake peer server (simulates a remote wolfpack instance) ──

const FAKE_PEER_LOOPS = [
  {
    project: "remote-proj",
    active: false,
    completed: true,
    iteration: 3,
    totalIterations: 5,
    agent: "claude",
    machineName: "fake-peer",
    machineUrl: "",
  },
];

let peerServer: ReturnType<typeof createServer>;
let peerPort: number;

function startPeerServer(): Promise<void> {
  return new Promise((resolve) => {
    peerServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api/info") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "fake-peer", version: "1.0.0" }));
      } else if (url.pathname === "/api/ralph") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ loops: FAKE_PEER_LOOPS }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    peerServer.listen(0, "127.0.0.1", () => {
      peerPort = (peerServer.address() as AddressInfo).port;
      resolve();
    });
  });
}

// ── Test server ──

let port: number;
let baseUrl: string;

beforeAll(async () => {
  await startPeerServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
  peerServer.close();
});

// ── Tests ──

describe("GET /api/ralph aggregation", () => {
  test("returns local-only by default (no ?aggregate)", async () => {
    const res = await fetch(`${baseUrl}/api/ralph`);
    expect(res.status).toBe(200);
    const data = await res.json() as { loops: any[] };
    // Should return local loops only (which may be empty in test env)
    // Crucially: should NOT contain remote peer loops
    const remoteLoops = data.loops.filter((l: any) => l.machineName === "fake-peer");
    expect(remoteLoops.length).toBe(0);
  });

  test("returns local-only with ?aggregate=false", async () => {
    const res = await fetch(`${baseUrl}/api/ralph?aggregate=false`);
    expect(res.status).toBe(200);
    const data = await res.json() as { loops: any[] };
    const remoteLoops = data.loops.filter((l: any) => l.machineName === "fake-peer");
    expect(remoteLoops.length).toBe(0);
  });

  test("all loops include machineName field", async () => {
    const res = await fetch(`${baseUrl}/api/ralph`);
    const data = await res.json() as { loops: any[] };
    for (const loop of data.loops) {
      expect(loop.machineName).toBeDefined();
      expect(typeof loop.machineName).toBe("string");
    }
  });
});
