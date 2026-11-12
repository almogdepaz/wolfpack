// Private process fixture: a production wolfpack HTTP server with a mock backend and a small activity journal.
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ACTIVITY_KIND } from "../../../src/activity-journal.ts";
import { loadConfig } from "../../../src/config.ts";
import { ActivityJournal } from "../../../src/server/activity-journal.ts";
import { createServerContext } from "../../../src/server/context.ts";
import { createServerInstance } from "../../../src/server/index.ts";
import { MockBackend } from "../../../src/server/mock-backend.ts";

const [root, nonce] = process.argv.slice(2);
if (!root || !nonce || process.env.WOLFPACK_TEST !== "1" || process.env.HOME !== root) throw new Error("private fixture required");
const journal = new ActivityJournal({ dir: join(root, ".wolfpack", "activity") });
for (const id of ["a", "b", "c"]) journal.append({ kind: ACTIVITY_KIND.TASK_UPDATED, taskId: id, eventType: "task.completed" });
const ctx = createServerContext({ backend: new MockBackend(), readTailscaleStatus: async () => JSON.parse(process.env.WOLFPACK_TAILSCALE_STATUS_JSON!), config: loadConfig(), activityJournal: journal, taskRelayRoot: join(root, "relay") });
const { server, wss } = createServerInstance(ctx);
process.on("SIGTERM", () => {
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections();
  void closed.then(() => { wss.close(); journal.close(); process.exit(0); });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
writeFileSync(join(root, "ready.tmp"), JSON.stringify({ nonce, port: (server.address() as AddressInfo).port }), { mode: 0o600 });
renameSync(join(root, "ready.tmp"), join(root, "ready.json"));
