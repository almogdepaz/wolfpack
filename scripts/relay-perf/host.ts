// Isolated benchmark host: production HTTP/WS, real BrokerBackend, production relay worker.
// Only Tailnet topology and the HTTPS->loopback transport are synthetic.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { BrokerClient } from "../../src/broker/client.ts";
import { BrokerBackend } from "../../src/server/broker-backend.ts";
import { __setTestBackend } from "../../src/server/backend.ts";
import { record, text, startSampling, waitUntil } from "./measurement.ts";

const root = text(process.argv[2]);
if (process.env.HOME !== root || process.env.WOLFPACK_TEST !== "1"
  || !text(process.env.WOLFPACK_BROKER_SOCKET).startsWith(root + "/")) throw new Error("private host environment required");
const config = record(JSON.parse(readFileSync(join(root, "host.json"), "utf8")));
const peers = new Map<string, string>();
let fault = "none", lost = false;
const faultEvents: unknown[] = [];
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input)), destination = peers.get(url.origin);
  if (!destination || url.protocol !== "https:" || init?.redirect !== "error") throw new Error("benchmark denied external fetch");
  const forward = url.pathname.endsWith("/peer");
  if (forward && fault === "outage") return new Response(null, { status: 503 });
  if (forward && fault === "slow") await Bun.sleep(300);
  const response = await nativeFetch(destination + url.pathname + url.search, init);
  if (forward && fault === "lost-reply" && !lost && response.ok) {
    lost = true;
    faultEvents.push({ at: Date.now(), kind: "dropped-accepted-reply", response: await response.json() });
    return new Response(null, { status: 503 });
  }
  return response;
}, { preconnect: nativeFetch.preconnect });
const client = new BrokerClient({ socketPath: text(process.env.WOLFPACK_BROKER_SOCKET), requestTimeoutMs: 5_000 });
client.start();
await waitUntil(() => client.isConnected(), 5_000, "private broker connection");
const backend = new BrokerBackend(client);
__setTestBackend(backend);
const sessions: unknown[] = [];
for (const name of ["sender", "receiver", "seed", "echo-0", "echo-1"]) {
  const response = await client.request("create_session", {
    name, cwd: root, command: ["/bin/sh", "-c", "stty raw -echo; exec /bin/cat"],
    env: [["HOME", root], ["TERM", "xterm-256color"], ["WOLFPACK_AGENT_KIND", name.startsWith("echo") ? "shell" : "pi"]], cols: 80, rows: 24,
  });
  if (response.status !== "ok") throw new Error(`private session creation: ${JSON.stringify(response.error)}`);
  const session = record(response.payload?.session);
  sessions.push({ id: session.id, pid: session.pid, name });
}
await backend.listSessionFacts();
const { getTaskRelayGateway, __resetTaskRelayGatewayForTests } = await import("../../src/task-relay/gateway.ts");
await getTaskRelayGateway().initialize();
const { createServerInstance } = await import("../../src/server/index.ts");
const { server, wss } = createServerInstance();
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const sampling = startSampling(join(root, "samples.jsonl"));
let closing = false;
async function close(): Promise<void> {
  if (closing) return; closing = true;
  clearTimeout(recoveryTimer);
  writeFileSync(join(root, "host-metrics.json"), JSON.stringify({ ...sampling.stop(), faultEvents }), { mode: 0o600 });
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  wss.close(); await __resetTaskRelayGatewayForTests(); client.close();
  process.exit(0);
}
process.on("SIGTERM", () => { void close(); });
process.on("message", (message: unknown) => {
  const input = record(message);
  if (input.kind === "configure") {
    for (const [origin, base] of Object.entries(record(input.peers))) {
      const url = new URL(text(base));
      if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || url.origin !== base) throw new Error("non-loopback peer");
      peers.set(origin, base);
    }
    fault = text(input.fault);
    faultEvents.push({ at: Date.now(), kind: "configured", fault });
    if (typeof input.recoverAfterMs === "number" && input.recoverAfterMs > 0) {
      recoveryTimer = setTimeout(() => { fault = "none"; faultEvents.push({ at: Date.now(), kind: "recovered" }); }, input.recoverAfterMs);
    }
    process.send?.({ kind: "configured" });
  }
});
writeFileSync(join(root, "ready.json"), JSON.stringify({ pid: process.pid, nonce: config.nonce, port, root: resolve(root), sessions }), { mode: 0o600 });
