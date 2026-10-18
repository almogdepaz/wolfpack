import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const taskRelayRoot = mkdtempSync(join(tmpdir(), "wolfpack-test-task-relay-"));
// Every ~/.wolfpack store (push keys/subscriptions, settings, runtime state,
// task ledgers) resolves through WOLFPACK_DIR; never touch a live install.
const wolfpackDir = mkdtempSync(join(tmpdir(), "wolfpack-test-state-"));
process.env.WOLFPACK_DIR = wolfpackDir;
process.env.WOLFPACK_TASK_RELAY_ROOT = taskRelayRoot;
// Historical v2 suites exercise the explicit compatibility engine. Tests of the
// production default must delete this setting; new volatile fixtures select their own scope.
process.env.WOLFPACK_TASK_RELAY_PROFILE ??= "volatile-v1";

afterAll(() => {
  rmSync(taskRelayRoot, { recursive: true, force: true });
  rmSync(wolfpackDir, { recursive: true, force: true });
});
