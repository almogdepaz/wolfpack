import { test } from "bun:test";
import { runNotificationFixture } from "./fixtures/run-notification-test.ts";

test("push test route contracts in an isolated process", async () => {
  await runNotificationFixture("push-test-route.fixture.ts");
}, 17_000);
