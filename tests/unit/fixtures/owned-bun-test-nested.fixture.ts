import { test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runOwnedBunTest } from "./run-owned-bun-test.ts";

const actor = join(import.meta.dir, "owned-bun-test-actor.fixture.ts");

// The actor inherits this verifier's top-owned process group. If this verifier
// exits, is signalled, or times out, its outer owner must reap actor descendants.
test("nested owned Bun actor", async () => {
  const running = runOwnedBunTest(actor, 15_000, process.env, { inheritOwnerGroup: true });
  if (process.env.OWNED_NESTED_VERIFIER_SIGNAL === "1") {
    const marker = process.env.OWNED_BUN_TEST_MARKER!;
    const deadline = performance.now() + 1_000;
    while (!existsSync(marker) && performance.now() < deadline) await Bun.sleep(10);
    if (!existsSync(marker)) throw new Error("nested actor did not bind before verifier signal");
    process.kill(process.pid, "SIGTERM");
  }
  await running;
}, 17_000);
