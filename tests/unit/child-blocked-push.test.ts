import { test } from "bun:test";
import { runNotificationFixture } from "./fixtures/run-notification-test.ts";

test("a blocked child event creates one needs-input push through the quiet-alert policy", async () => {
  await runNotificationFixture("child-blocked-push.fixture.ts");
}, 17_000);
