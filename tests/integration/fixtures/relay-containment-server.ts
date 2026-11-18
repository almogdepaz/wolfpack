import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BrokerClient } from "../../../src/broker/client.ts";
import { BrokerBackend } from "../../../src/server/broker-backend.ts";
import { startServer } from "../../../src/server/index.ts";

const root = process.argv[2]!;
const client = new BrokerClient({ socketPath: process.env.WOLFPACK_BROKER_SOCKET!, requestTimeoutMs: 1000 });
client.start();
const deadline = Date.now() + 5000;
while (true) {
  try { if ((await client.request("list_sessions", {})).status === "ok") break; }
  catch (error) { if (Date.now() >= deadline) throw error; }
  if (Date.now() >= deadline) throw new Error("private broker did not become ready");
  await Bun.sleep(20);
}
const backend = new BrokerBackend(client);
if (!await backend.hasSession("containment-shell")) {
  await backend.createSession("containment-shell", root, "shell", () => ({ agentCmd: "shell" }));
}
const { server } = await startServer(0, "127.0.0.1", { backend });
if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
writeFileSync(join(root, "ready.json"), JSON.stringify({ port: (server.address() as AddressInfo).port, compiled: import.meta.url.includes("/$bunfs/") }), { mode: 0o600 });
