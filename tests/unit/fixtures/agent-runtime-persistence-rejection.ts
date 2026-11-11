import { strict as assert } from "node:assert";
import { existsSync, readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { mock } from "bun:test";

const crypto = await import("node:crypto");
const randomBytes = crypto.randomBytes;
let failNext = false;
mock.module("node:crypto", () => ({
  ...crypto,
  randomBytes: (...args: Parameters<typeof randomBytes>) => {
    if (failNext) {
      failNext = false;
      throw new Error("injected random source failure");
    }
    return Reflect.apply(randomBytes, crypto, args);
  },
}));
const { AgentRuntimeStateStore, getAgentRuntimeStateStore } = await import("../../../src/server/agent-status.ts");
const { stopSessionNotificationObserver } = await import("../../../src/server/session-observation.ts");

const path = process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH;
assert.ok(path);
const mode = process.argv[2];
assert.ok(mode === "timer" || mode === "shutdown");

let watcher: ReturnType<typeof watch> | undefined;
const persisted = new Promise<void>(resolve => {
  watcher = watch(dirname(path), (_event, filename) => {
    if (filename?.toString() === basename(path) && existsSync(path)) resolve();
  });
});
const deadline = setTimeout(() => {
  console.error("persistence retry did not complete");
  process.exit(2);
}, 8_000);
const store = mode === "timer" ? new AgentRuntimeStateStore(path) : getAgentRuntimeStateStore();
try {
  failNext = true;
  store.flush();
  // Deliberately reproduce the entry's floating shutdown call, without a
  // process-level handler that would conceal an escaping rejection.
  if (mode === "shutdown") stopSessionNotificationObserver();
  await persisted;
  await store.flushForShutdown();
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schemaVersion: 1, sessions: {} });
  console.log("persistence recovered");
} finally {
  clearTimeout(deadline);
  watcher?.close();
  store.cancelScheduledPersist();
  mock.restore();
}
