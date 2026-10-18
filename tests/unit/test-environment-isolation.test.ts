import { expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createServerContext } from "../../src/server/context.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";

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
