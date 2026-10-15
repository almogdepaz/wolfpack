import { test } from "bun:test";
import { runNotificationFixture } from "./fixtures/run-notification-test.ts";

test("notify route delivery contracts in an isolated process", async () => {
  await runNotificationFixture("notify-route.fixture.ts");
}, 17_000);
