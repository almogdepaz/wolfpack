// Child process for server-shutdown.test.ts: a bare WebSocketServer with the
// production shutdown signal handlers installed. Prints its port when ready.
// With ACTIVITY_DIR set, one buffered journal row must be flushed by the handler.
import { WebSocketServer } from "ws";
import { installShutdownSignalHandlers } from "../../../src/server/shutdown";
import { ActivityJournal } from "../../../src/server/activity-journal";

const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
const journal = process.env.ACTIVITY_DIR ? new ActivityJournal({ dir: process.env.ACTIVITY_DIR, flushMs: 600_000 }) : undefined;
wss.once("listening", () => {
  journal?.append({ kind: "task.updated", taskId: "buffered-at-sigterm", eventType: "task.completed" });
  installShutdownSignalHandlers(wss, journal && (() => journal.flush()));
  process.stdout.write(`PORT ${(wss.address() as { port: number }).port}\n`);
});
