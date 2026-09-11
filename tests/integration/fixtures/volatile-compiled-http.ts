// Disposable compiled test host. No new production routes or broker/model calls.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { __setTestBackend } from "../../../src/server/backend.ts";
import { MockBackend } from "../../../src/server/mock-backend.ts";
import { createServerInstance } from "../../../src/server/index.ts";
import { getTaskRelayGateway, __resetTaskRelayGatewayForTests } from "../../../src/task-relay/gateway.ts";

const [root, portText, profile, nonce] = process.argv.slice(2);
if (!root || !nonce || !/^[0-9]+$/.test(portText ?? "") || profile !== "volatile-v1"
  || process.env.WOLFPACK_TEST !== "1" || !import.meta.url.includes("/$bunfs/")) throw new Error("compiled private fixture required");
process.env.WOLFPACK_TASK_RELAY_ROOT = join(root, "relay");
process.env.WOLFPACK_TASK_RELAY_PROFILE = profile;
mkdirSync(join(root, "project"), { recursive: true });
class PiBackend extends MockBackend {
  override async listIdentities() {
    return Object.fromEntries(["sender", "receiver"].map(name => [name, {
      wolfpackSessionId: `${name}-id`, wolfpackSessionName: name, projectPath: join(root!, "project"),
      agentKind: "pi" as const, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    }]));
  }
}
__setTestBackend(new PiBackend({ sessions: ["sender", "receiver"] }));
// Durable mode only serves the profile rejection path. It must not open the
// deliberately malformed historical ledger used by this fixture.
if (profile === "volatile-v1") await getTaskRelayGateway().initialize();
const { server, wss } = createServerInstance();
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return; stopping = true;
  void (async () => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections(); await closed; wss.close();
    await __resetTaskRelayGatewayForTests(); process.exit(0);
  })();
});
await new Promise<void>(resolve => server.listen(Number(portText), "127.0.0.1", resolve));
const ready = join(root, "ready.json");
writeFileSync(`${ready}.tmp`, JSON.stringify({ nonce, pid: process.pid, compiled: true, port: (server.address() as AddressInfo).port }), { mode: 0o600 });
renameSync(`${ready}.tmp`, ready);
