import { test } from "bun:test";
import { runNotificationFixture } from "./fixtures/run-notification-test.ts";

test("child events reach the parent inbox through the observer in an isolated process", async () => {
  await runNotificationFixture("child-events-observer.fixture.ts");
}, 17_000);
