import { writeFileSync } from "node:fs";
import { createRecoveryStore } from "../../../src/task-relay/recovery-store.ts";
const [root, ready] = process.argv.slice(2);
if (!root || !ready || process.env.WOLFPACK_TEST !== "1") throw new Error("private test owner requires root, ready path and WOLFPACK_TEST");
const owner = createRecoveryStore({ root });
writeFileSync(ready, JSON.stringify({ epoch: owner.store.epoch }), { mode: 0o600 });
const timer = setInterval(() => {}, 1000);
process.once("SIGTERM", () => { clearInterval(timer); owner.close(); process.exit(0); });
