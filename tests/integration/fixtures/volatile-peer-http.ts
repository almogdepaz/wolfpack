// Private process fixture: production HTTP/auth/worker, synthetic broker and TLS network mapping.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { __setTestBackend } from "../../../src/server/backend.ts";
import { MockBackend } from "../../../src/server/mock-backend.ts";
import { createServerInstance } from "../../../src/server/index.ts";
import { getTaskRelayGateway, __resetTaskRelayGatewayForTests } from "../../../src/task-relay/gateway.ts";

const [root, mapping, nonce] = process.argv.slice(2);
if (!root || !mapping || !nonce || process.env.WOLFPACK_TEST !== "1" || process.env.HOME !== root) throw new Error("private fixture required");
const actualFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const peers = JSON.parse(readFileSync(mapping, "utf8")) as Record<string, string>;
  const loopback = peers[url.origin];
  if (!loopback || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(loopback) || url.protocol !== "https:" || init?.redirect !== "error") throw new Error("fixture network denied");
  let outgoing = init;
  const forward = url.pathname === "/api/task-relay/volatile-v1/peer";
  const modePath = join(root, "network-mode"), mode = existsSync(modePath) ? readFileSync(modePath, "utf8") : "";
  if (forward) {
    writeFileSync(join(root, "last-forward.json"), JSON.stringify({ raw: init?.body, signature: new Headers(init?.headers).get("x-wolfpack-relay-signature") }), { mode: 0o600 });
    if (mode === "tamper") outgoing = { ...init, body: String(init?.body).replace("tamper-me", "tampered!") };
  }
  const response = await actualFetch(loopback + url.pathname + url.search, outgoing);
  if (forward && mode === "drop-next" && response.ok) {
    unlinkSync(modePath); await response.text(); return new Response("lost acceptance confirmation", { status: 503 });
  }
  return response;
}, { preconnect: actualFetch.preconnect }) as typeof fetch;
class PiBackend extends MockBackend {
  override async listIdentities() {
    return Object.fromEntries(["sender", "receiver"].map(name => [name, { wolfpackSessionId: `${name}-id`, wolfpackSessionName: name,
      projectPath: root, agentKind: "pi" as const, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]));
  }
}
__setTestBackend(new PiBackend({ sessions: ["sender", "receiver"] }));
await getTaskRelayGateway().initialize();
const { server, wss } = createServerInstance();
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return; stopping = true;
  void (async () => {
    const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closed;
    wss.close(); await __resetTaskRelayGatewayForTests(); process.exit(0);
  })();
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
writeFileSync(join(root, "ready.tmp"), JSON.stringify({ nonce, pid: process.pid, port: (server.address() as AddressInfo).port }), { mode: 0o600 });
renameSync(join(root, "ready.tmp"), join(root, "ready.json"));
