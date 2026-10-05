import { expect, test } from "bun:test";
import { join } from "node:path";
import { runOwnedBunTest } from "./run-owned-bun-test.ts";

const readinessFixture = join(import.meta.dir, "application-readiness-proxy.fixture.ts");

// This Bun process is deliberately fresh: its first default fetch follows the
// proxy-mutating readiness contract in a separate owned child process.
test("readiness child cannot poison a cold parent's first default fetch", async () => {
  const successDeadline = performance.now() + 15_000;
  await runOwnedBunTest(readinessFixture, 15_000, process.env, { inheritOwnerGroup: true });
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() { requests++; return new Response("REAL_DESTINATION"); },
  });
  try {
    const response = await fetch(server.url);
    expect(await response.text()).toBe("REAL_DESTINATION");
    expect(requests).toBe(1);
  } finally {
    await server.stop(true);
  }
  // This positive check is deliberately after server cleanup: success means
  // the complete verifier return, not merely a pre-cleanup fetch response.
  if (performance.now() > successDeadline) throw new Error("cold verifier exceeded its 15 second success ceiling");
// This runner watchdog permits only bounded failure cleanup after the
// independent 15s success ceiling above; it never accepts late success.
}, 18_000);
