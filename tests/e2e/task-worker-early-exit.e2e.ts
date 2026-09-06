import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { start, skipIfNoBroker, type BrokerTestServer } from "./broker-helpers.ts";

async function availablePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("could not allocate loopback port");
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

let server: BrokerTestServer | undefined;
let fixture: string | undefined;

test.beforeAll(async () => {
  if (skipIfNoBroker.condition) return;
  fixture = mkdtempSync(join(tmpdir(), "wp-task-worker-exit-"));
  const project = join(fixture, "project");
  const home = join(fixture, "home");
  const executable = join(fixture, "fake-pi");
  const extension = join(fixture, "extension.ts");
  mkdirSync(project);
  mkdirSync(home);
  writeFileSync(extension, "export {}\n");
  writeFileSync(executable, `#!/bin/sh
curl -fsS -X POST -H 'content-type: application/json' \\
  --data "{\\\"callerSession\\\":\\\"$WOLFPACK_SESSION_NAME\\\",\\\"generation\\\":\\\"fake-exit\\\",\\\"protocolVersions\\\":[2]}" \\
  "http://127.0.0.1:$WOLFPACK_PORT/api/task-relay/v2/connect" >/dev/null
exit 0
`);
  chmodSync(executable, 0o755);
  server = await start({ envOverrides: {
    HOME: home,
    WOLFPACK_DEV_DIR: fixture,
    WOLFPACK_PORT: String(await availablePort()),
    WOLFPACK_TASK_WORKER_PI_EXECUTABLE: executable,
    WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: extension,
  } });
});

test.afterAll(async () => {
  await server?.teardown();
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

test("task-worker readiness rejects a fake Pi process that registers then exits", async () => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  const response = await fetch(`${server!.baseUrl}/api/session-create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectDir: join(fixture!, "project"), harness: "pi", taskWorker: true, readinessTimeoutMs: 1_000 }),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "TASK_WORKER_NOT_READY",
    createdSession: { sessionId: expect.any(String) },
    cleanup: "completed",
  });
});
