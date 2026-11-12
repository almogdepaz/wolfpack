import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRecoveryStore } from "../../src/task-relay/recovery-store.ts";
import { createTaskRelayGateway } from "../../src/task-relay/gateway.ts";

test("production HTTP preserves permanent storage-owner failures without blanket retryability", async () => {
  const { createServerContext } = await import("../../src/server/context.ts");
  const { createVolatileRelayRoutes } = await import("../../src/server/volatile-relay-routes.ts");
  const root = mkdtempSync("/tmp/relay-storage-http-");
  const seed = createRecoveryStore({ root }); seed.close();
  const db = new Database(join(root, "restart-safe-v1.sqlite")); db.exec("PRAGMA user_version=99"); db.close();
  const gateway = createTaskRelayGateway({ root, storage: "sqlite" });
  const routes = createVolatileRelayRoutes(createServerContext({ taskRelayGateway: gateway, config: null, startSupervisor: false }));
  const server = createServer((req, res) => { void routes["POST /api/task-relay/volatile-v1"]!(req, res); });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/task-relay/volatile-v1`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "connect", profile: "volatile-v1", callerSession: "caller", generation: "baseline-generation", protocolVersions: [2] }),
    });
    expect(await response.json()).toMatchObject({ ok: false, profile: "volatile-v1", error: { code: "RELAY_STORAGE_INVALID", retryable: false, ownerFatal: true } });
    expect(response.status).not.toBe(503);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await gateway.close(); rmSync(root, { recursive: true, force: true });
  }
});
