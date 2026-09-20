#!/usr/bin/env bun
/**
 * Compiled acceptance bootstrap. It composes the production HTTP server with a
 * real BrokerBackend, but has no daemon/service side effects outside its owned
 * environment.
 */
import type { AddressInfo } from "node:net";

process.env.WOLFPACK_TEST = "1";

const socketPath = process.env.WOLFPACK_BROKER_SOCKET;
if (!socketPath) throw new Error("WOLFPACK_BROKER_SOCKET is required");

const { __setTestBackend } = await import("../../../src/server/backend.ts");
const { BrokerClient } = await import("../../../src/broker/client.ts");
const { BrokerBackend } = await import("../../../src/server/broker-backend.ts");

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
let connected = false;
const client = new BrokerClient({
  socketPath,
  requestTimeoutMs: 5_000,
  onConnect: () => { connected = true; },
});
client.start();
const deadline = Date.now() + 5_000;
while (!connected && Date.now() < deadline) await wait(25);
if (!connected) throw new Error("real broker connection timed out");
const ping = await client.request("list_sessions", {});
if (ping.status !== "ok") throw new Error("real broker list_sessions failed");
__setTestBackend(new BrokerBackend(client));

const { createServerInstance } = await import("../../../src/server/index.ts");
const { __resetTaskRelayGatewayForTests } = await import("../../../src/task-relay/gateway.ts");
const { server } = createServerInstance();
server.listen(Number(process.env.WOLFPACK_PORT) || 0, "127.0.0.1", () => {
  process.stdout.write(`READY:${(server.address() as AddressInfo).port}\n`);
});

async function stop(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await __resetTaskRelayGatewayForTests();
  client.close();
}
process.on("SIGTERM", () => { void stop().finally(() => process.exit(0)); });
process.on("SIGINT", () => { void stop().finally(() => process.exit(0)); });
