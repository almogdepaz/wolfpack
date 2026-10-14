import { test } from "bun:test";
import { runNotificationFixture } from "./fixtures/run-notification-test.ts";

test("local observer liveness regression in an isolated process", async () => {
  await runNotificationFixture("peer-notification-observer.fixture.ts");
}, 17_000);
