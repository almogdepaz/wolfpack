import { expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createServerContext } from "../../src/server/context.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";
import { WOLFPACK_DIR } from "../../src/config.ts";
import { agentRuntimeStatePath } from "../../src/server/agent-status.ts";
import { defaultBrokerSocketPath } from "../../src/broker/client.ts";
import { taskStorePaths } from "../../src/tasks/store.ts";
import { taskWorkerPolicyPath } from "../../src/server/task-worker-policy.ts";

test("sandboxes the task relay before test modules load", async () => {
  const configuredRoot = process.env.WOLFPACK_TASK_RELAY_ROOT;
  expect(configuredRoot).toBeDefined();
  if (configuredRoot === undefined) return;

  const relayRoot = resolve(configuredRoot);
  const gateway = createServerContext({ backend: new MockBackend() }).taskRelayGateway;
  try {
    expect(gateway.root).toBe(relayRoot);
    expect(relative(resolve(tmpdir()), relayRoot).startsWith("..")).toBe(false);
    expect(relayRoot).not.toBe(resolve(join(homedir(), ".wolfpack", "pi-tasks-relay-v2")));
  } finally {
    await gateway.close();
  }
});

test("sandboxes every ~/.wolfpack store before test modules load", () => {
  const configured = process.env.WOLFPACK_DIR;
  expect(configured).toBeDefined();
  if (configured === undefined) return;

  expect(relative(resolve(tmpdir()), configured).startsWith("..")).toBe(false);
  expect(configured).not.toBe(join(homedir(), ".wolfpack"));
  expect(WOLFPACK_DIR).toBe(configured);
  const { WOLFPACK_AGENT_RUNTIME_STATE_PATH, XDG_RUNTIME_DIR } = process.env;
  try {
    delete process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH;
    delete process.env.XDG_RUNTIME_DIR;
    expect(agentRuntimeStatePath()).toBe(join(configured, "agent-runtime-state.json"));
    expect(defaultBrokerSocketPath()).toBe(join(configured, "broker.sock"));
  } finally {
    if (WOLFPACK_AGENT_RUNTIME_STATE_PATH !== undefined) process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH = WOLFPACK_AGENT_RUNTIME_STATE_PATH;
    if (XDG_RUNTIME_DIR !== undefined) process.env.XDG_RUNTIME_DIR = XDG_RUNTIME_DIR;
  }
  expect(taskStorePaths().root).toBe(join(configured, "tasks"));
  expect(taskWorkerPolicyPath({ WOLFPACK_DIR: configured })).toBe(join(configured, "task-worker-policy.json"));
});
