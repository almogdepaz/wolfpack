import { test } from "bun:test";
import { runNotificationFixture } from "./fixtures/run-notification-test.ts";

test("child list and child wait routes in an isolated process", async () => {
  await runNotificationFixture("child-wait-routes.fixture.ts");
}, 17_000);
