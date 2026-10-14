import { test } from "bun:test";
import { runNotificationFixture } from "./fixtures/run-notification-test.ts";

test("peer delivery state regressions in an isolated process", async () => {
  await runNotificationFixture("notifications-ux-relay.fixture.ts");
}, 17_000);
