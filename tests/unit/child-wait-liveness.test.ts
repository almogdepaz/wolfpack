import { test } from "bun:test";
import { join } from "node:path";
import { runOwnedBunTest } from "./fixtures/run-owned-bun-test.ts";

test("child waits stay bounded by their timeout and abort under a fast event stream (owned process watchdog)", async () => {
  const result = await runOwnedBunTest(join(import.meta.dir, "fixtures/child-wait-liveness.fixture.ts"), 5_000, { ...process.env, WOLFPACK_TEST: "1" });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}, 8_000);
