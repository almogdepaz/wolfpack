// Child process for server-shutdown.test.ts: a bare WebSocketServer with the
// production shutdown signal handlers installed. Prints its port when ready.
import { WebSocketServer } from "ws";
import { installShutdownSignalHandlers } from "../../../src/server/shutdown";

const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
wss.once("listening", () => {
  installShutdownSignalHandlers(wss);
  process.stdout.write(`PORT ${(wss.address() as { port: number }).port}\n`);
});
