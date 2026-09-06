import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { start, skipIfNoBroker, type BrokerTestServer } from "./broker-helpers.ts";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve a loopback port");
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function piExecutable(): string | undefined {
  const result = spawnSync("which", ["pi"], { encoding: "utf8" });
  const path = result.status === 0 ? result.stdout.trim() : "";
  return path && existsSync(path) ? path : undefined;
}

const executable = piExecutable();
const extension = process.env.WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION
  ?? join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"), "npm", "node_modules", "@sgtbeatdown", "pi-tasks", "src", "extension.ts");
const unavailableReason = !executable
  ? "Pi executable not found on PATH"
  : !existsSync(extension)
    ? "Pi Tasks extension not found"
    : undefined;

let server: BrokerTestServer | undefined;
let fixture: string | undefined;
let sessionId: string | undefined;

test.beforeAll(async () => {
  if (skipIfNoBroker.condition || unavailableReason) return;
  fixture = mkdtempSync(join(tmpdir(), "wp-task-worker-"));
  const projectDir = join(fixture, "project");
  const home = join(fixture, "home");
  mkdirSync(projectDir);
  mkdirSync(home);
  const port = await availablePort();
  server = await start({
    envOverrides: {
      HOME: home,
      WOLFPACK_DEV_DIR: fixture,
      WOLFPACK_PORT: String(port),
      WOLFPACK_TASK_WORKER_PI_EXECUTABLE: executable!,
      WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: extension,
    },
  });
});

test.afterAll(async () => {
  await server?.teardown();
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

test("task-worker readiness launches real Pi Tasks against an isolated broker and relay", async () => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  test.skip(unavailableReason !== undefined, unavailableReason);

  try {
    const projectDir = realpathSync(join(fixture!, "project"));
    const response = await fetch(`${server!.baseUrl}/api/session-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectDir,
        harness: "pi",
        taskWorker: true,
        readinessTimeoutMs: 30_000,
      }),
    });
    const body = await response.json() as Record<string, unknown>;
    expect(response.ok, JSON.stringify(body)).toBeTruthy();
    expect(body).toMatchObject({
      ok: true,
      harness: "pi",
      taskEndpoint: { relay: "wolfpack-pi-tasks-v2" },
    });
    expect(body.session).toEqual(expect.any(String));
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect((body.taskEndpoint as Record<string, unknown>).id).toMatch(/^[0-9a-f-]{36}$/i);
    sessionId = body.sessionId as string;

    const status = await fetch(`${server!.baseUrl}/api/session-control/status?session=${encodeURIComponent(sessionId)}`);
    expect(status.ok).toBeTruthy();
    expect(await status.json()).toMatchObject({
      ok: true,
      sessionId,
      projectPath: projectDir,
      harness: "pi",
      terminal: { alive: true },
    });

    const kill = await fetch(`${server!.baseUrl}/api/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionId }),
    });
    expect(kill.ok).toBeTruthy();
    expect(await kill.json()).toMatchObject({ ok: true, sessionId });
    await expect.poll(async () => {
      const activeSessions = await fetch(`${server!.baseUrl}/api/session-control/list`);
      expect(activeSessions.ok).toBeTruthy();
      return (await activeSessions.json()).sessions.find(
        (session: { readonly sessionId: string }) => session.sessionId === sessionId,
      );
    }, { timeout: 3_000 }).toBeUndefined();
    sessionId = undefined;
  } finally {
    await server?.teardown();
    server = undefined;
    if (fixture) {
      rmSync(fixture, { recursive: true, force: true });
      fixture = undefined;
    }
  }
});
