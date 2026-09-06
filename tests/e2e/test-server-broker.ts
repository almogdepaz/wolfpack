#!/usr/bin/env bun
/**
 * Test server harness for broker e2e tests — run via broker-helpers.ts.
 *
 * Like test-server.ts but wires a real BrokerClient + BrokerBackend instead
 * of MockBackend. Requires WOLFPACK_BROKER_SOCKET env var pointing to an
 * already-running broker Unix socket. Prints `READY:<port>` on stdout when
 * listening.
 */
import type { AddressInfo } from "node:net";

process.env.WOLFPACK_TEST = "1";

const { mock: bunMock } = await import("bun:test");
const realHttp = await import("../../src/server/http.ts");
await bunMock.module("../../src/server/http.js", () => ({
  ...realHttp,
  enumerateLocalTailnetCandidates: async () => ({ candidates: [] }),
}));

const socketPath = process.env.WOLFPACK_BROKER_SOCKET;
if (!socketPath) {
  process.stderr.write("WOLFPACK_BROKER_SOCKET is required\n");
  process.exit(1);
}

const { __setTestBackend } = await import("../../src/server/backend.ts");
const { BrokerClient } = await import("../../src/broker/client.ts");
const { BrokerBackend } = await import("../../src/server/broker-backend.ts");

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Connect and wait for broker to be responsive
let resolveConnect!: () => void;
const connected = new Promise<void>((resolve) => {
  resolveConnect = resolve;
});

const brokerClient = new BrokerClient({
  socketPath,
  requestTimeoutMs: 5000,
  onConnect: () => resolveConnect(),
});
brokerClient.start();
await Promise.race([connected, wait(2000)]);

// Belt-and-braces: ping until broker answers
const pingDeadline = Date.now() + 5000;
while (Date.now() < pingDeadline) {
  try {
    const resp = await brokerClient.request("list_sessions", {});
    if (resp.status === "ok") break;
  } catch {
    await wait(50);
  }
}

const backend = new BrokerBackend(brokerClient);
__setTestBackend(backend);

const { server } = await import("../../src/server/index.ts");

const origError = console.error;
console.error = (...args: unknown[]) => {
  const msg = String(args[0] ?? "");
  if (msg.includes("tmux") || msg.includes("WS error") || msg.includes("spawn")) return;
  origError(...args);
};

server.listen(Number(process.env.WOLFPACK_PORT) || 0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  console.log(`READY:${port}`);
});

process.stdin.resume();
process.stdin.on("end", () => {
  brokerClient.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  brokerClient.close();
  process.exit(0);
});
