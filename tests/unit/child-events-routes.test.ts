import { test } from "bun:test";
import { runNotificationFixture } from "./fixtures/run-notification-test.ts";

test("child event routes (notify message, send arming, inbox bootId) in an isolated process", async () => {
  await runNotificationFixture("child-events-routes.fixture.ts");
}, 17_000);
