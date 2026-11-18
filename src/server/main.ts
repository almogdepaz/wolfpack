import { createLogger } from "../log.js";
import { startServer } from "./index.js";

const log = createLogger("server");

startServer().catch((err: unknown) => {
  log.error("server start failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
