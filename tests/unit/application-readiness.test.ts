import { expect, test } from "bun:test";
import { join } from "node:path";
import { runOwnedBunTest } from "./fixtures/run-owned-bun-test.ts";

const proxyKeys = ["http_proxy", "HTTP_PROXY", "NO_PROXY", "no_proxy"] as const;
const coldOrderFixture = join(import.meta.dir, "fixtures/application-readiness-cold-order.fixture.ts");

test("real readiness proxy contract is process-isolated with a cold-process fetch regression", async () => {
  const previous: Array<[typeof proxyKeys[number], string | undefined]> = proxyKeys.map(key => [key, process.env[key]]);
  const successDeadline = performance.now() + 15_000;
  await runOwnedBunTest(coldOrderFixture, 15_000);
  expect(proxyKeys.map(key => [key, process.env[key]])).toEqual(previous);
  if (performance.now() > successDeadline) throw new Error("cold readiness regression exceeded its 15 second success ceiling");
// The 18s runner watchdog is failure-only containment headroom: the 15s
// success ceiling above remains binding, then root/group cleanup is bounded.
}, 18_000);
