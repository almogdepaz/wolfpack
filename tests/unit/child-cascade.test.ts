import { test } from "bun:test";
import { runNotificationFixture } from "./fixtures/run-notification-test.ts";

test("child cleanup cascade (kill route, parent death, policy, children listing) in an isolated process", async () => {
  await runNotificationFixture("child-cascade.fixture.ts");
}, 17_000);
