import { closeSync } from "node:fs";

const mode = process.argv[2];
const marker = "server-fatal-probe-" + mode;
const events = ["unhandledRejection", "uncaughtException"] as const;
const before = events.map(event => process.listenerCount(event));
const { server, startServer } = await import("../../../src/server/index.ts");
if (mode === "import-only") {
  console.log(JSON.stringify({ before, after: events.map(event => process.listenerCount(event)) }));
  process.exit(0);
}
if (mode !== "unhandledRejection" && mode !== "uncaughtException") throw new Error("unknown failure mode");
const { MockBackend } = await import("../../../src/server/mock-backend.ts");
await startServer(0, "127.0.0.1", { backend: new MockBackend({ sessions: [] }) });
if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
console.log("SERVER_FATAL_PROBE_READY");
setImmediate(function triggerUnhandledFailure() {
  const error = process.argv[3] === "null" ? null
    : process.argv[3] === "undefined" ? undefined : new Error(marker);
  if (error && process.argv[3] === "large") {
    error.stack = "large-stack-start\n" + "é".repeat(1024 * 1024) + "\nlarge-stack-end";
  }
  if (process.argv[3] === "closed-stderr") closeSync(2);
  if (mode === "unhandledRejection") void Promise.reject(error);
  else throw error;
});
// A handler must not keep a process with an unknown failure running.
setTimeout(() => { console.log("SERVER_FATAL_PROBE_CONTINUED"); process.exit(0); }, 1000);
