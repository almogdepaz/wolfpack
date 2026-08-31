import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const taskRelayRoot = mkdtempSync(join(tmpdir(), "wolfpack-test-task-relay-"));
process.env.WOLFPACK_TASK_RELAY_ROOT = taskRelayRoot;

afterAll(() => {
  rmSync(taskRelayRoot, { recursive: true, force: true });
});
