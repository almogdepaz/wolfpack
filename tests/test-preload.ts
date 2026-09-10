import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const taskRelayRoot = mkdtempSync(join(tmpdir(), "wolfpack-test-task-relay-"));
process.env.WOLFPACK_TASK_RELAY_ROOT = taskRelayRoot;
// Historical v2 suites exercise the explicit compatibility engine. Tests of the
// production default must delete this setting; new volatile fixtures select their own scope.
process.env.WOLFPACK_TASK_RELAY_PROFILE ??= "durable-v2";

afterAll(() => {
  rmSync(taskRelayRoot, { recursive: true, force: true });
});
