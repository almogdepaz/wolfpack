import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join } from "node:path";

// Loaded only in owned crash-test children; the parent never patches fs.
const target = process.env.WP_CRASH_AT;
if (target !== undefined) {
  const root = process.env.WP_CRASH_ROOT;
  const killAt = Number(target);
  const recoveryState = process.env.WP_CRASH_RECOVERY_STATE;
  if (recoveryState !== undefined && !["ownerless", "published", "retired"].includes(recoveryState)) {
    throw new Error("unknown recovery crash state");
  }
  if (!root || !isAbsolute(root) || !Number.isSafeInteger(killAt) || killAt < 1) {
    throw new Error("crash injection requires an absolute private root and positive call index");
  }
  const fs = require("node:fs") as typeof import("node:fs");
  const writeEvidence = fs.writeFileSync.bind(fs);
  const lock = join(root, ".registry-lock");
  let calls = 0;
  for (const name of ["mkdirSync", "renameSync", "rmSync", "cpSync", "openSync", "writeFileSync", "fsyncSync", "closeSync"] as const) {
    const original = fs[name];
    Object.defineProperty(fs, name, {
      configurable: true,
      writable: true,
      value: function (this: unknown, ...args: unknown[]) {
        const locked = fs.existsSync(lock);
        if (locked) calls++;
        const recovery = `${lock}.recovery`;
        const recoveryExists = recoveryState !== undefined && fs.existsSync(recovery);
        const ownerPublished = recoveryExists && fs.existsSync(join(recovery, "owner.json"));
        const matchesRecovery = recoveryExists && (recoveryState === "ownerless" ? !ownerPublished
          : recoveryState === "published" ? ownerPublished && locked : !locked);
        if (recoveryState === undefined ? locked && calls === killAt : matchesRecovery) {
          writeEvidence(2, JSON.stringify({ event: "crash", call: calls, name, pid: process.pid }) + "\n");
          process.kill(process.pid, "SIGKILL");
        }
        return Reflect.apply(original, this, args);
      },
    });
  }
  syncBuiltinESMExports();
  process.on("exit", () => writeEvidence(2, JSON.stringify({ event: "exit", calls }) + "\n"));
}
