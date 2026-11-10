// Private loopback fixture exercising the actual server-owned relay worker.
import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { WorkerRelayGateway } from "../../../src/task-relay/worker-client.ts";
const root = process.argv[2]!;
if (!isAbsolute(root) || process.env.HOME !== root || process.env.WOLFPACK_DIR !== join(root, "state") || process.env.WOLFPACK_TEST !== "1") throw new Error("private fixture environment required");
const gateway = new WorkerRelayGateway({ root: join(root, "relay"), storage: "sqlite", inspectSession: async selector => ({ ok: true, session: selector, sessionId: selector, projectPath: root, harness: "pi", alive: true }) });
await gateway.initialize();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const input = await request.json();
  return Response.json(await gateway.volatile(input));
} });
writeFileSync(join(root, "ready.json"), JSON.stringify({ port: server.port, profile: gateway.profile }), { mode: 0o600 });
process.on("SIGTERM", () => { void (async () => { await server.stop(true); await gateway.close(); process.exit(0); })(); });
