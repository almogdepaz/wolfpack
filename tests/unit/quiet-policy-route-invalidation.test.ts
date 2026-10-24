import { test } from "bun:test";
import { runNotificationFixture } from "./fixtures/run-notification-test.ts";

test("restrictive settings POST fences local push ownership without gating peers", async () => {
  await runNotificationFixture("quiet-policy-route-invalidation.fixture.ts");
}, 17_000);
