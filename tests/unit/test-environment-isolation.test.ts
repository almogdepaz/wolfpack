import { expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { getTaskRelayGateway } from "../../src/task-relay/gateway.ts";

test("sandboxes the task relay before test modules load", () => {
  const configuredRoot = process.env.WOLFPACK_TASK_RELAY_ROOT;
  expect(configuredRoot).toBeDefined();
  if (configuredRoot === undefined) return;

  const relayRoot = resolve(configuredRoot);
  expect(getTaskRelayGateway().root).toBe(relayRoot);
  expect(relative(resolve(tmpdir()), relayRoot).startsWith("..")).toBe(false);
  expect(relayRoot).not.toBe(resolve(join(homedir(), ".wolfpack", "pi-tasks-relay-v2")));
});
