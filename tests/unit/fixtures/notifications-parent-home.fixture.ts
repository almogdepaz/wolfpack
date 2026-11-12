import { afterAll, expect } from "bun:test";
import { assertNotificationFixtureHome } from "./run-notification-test.ts";
import "../push-test-route.test.ts";
import "../notifications-ux-relay.test.ts";
import "../peer-notification-observer.test.ts";

// This verifier itself runs under a synthetic HOME, never the operator HOME.
assertNotificationFixtureHome();
const { createPushService } = await import("../../../src/server/push.ts");
const { quietAlertPolicyEpoch } = await import("../../../src/quiet-alert-policy-invalidation.ts");
const { createServerContext, getDefaultServerContext, setDefaultServerContext } = await import("../../../src/server/context.ts");
const { MockBackend } = await import("../../../src/server/mock-backend.ts");
// Entry-point suites must not change its process-global delivery/backend state.
const backend = new MockBackend({ sessions: [] });
const context = createServerContext({ backend, push: createPushService({ now: () => 123 }) });
setDefaultServerContext(context);
expect(context.push.checkNotifyRateLimit()).toBeNull();
const epoch = quietAlertPolicyEpoch();
const env = { ...process.env };
const fetcher = globalThis.fetch;
afterAll(async () => {
  for (let i = 0; i < 9; i++) expect(context.push.checkNotifyRateLimit()).toBeNull();
  expect(context.push.checkNotifyRateLimit()).toBe("rate limit exceeded (10/min)");
  expect(quietAlertPolicyEpoch()).toBe(epoch);
  expect(getDefaultServerContext()).toBe(context);
  expect(context.backend).toBe(backend);
  expect(globalThis.fetch).toBe(fetcher);
  expect({ ...process.env }).toEqual(env);
  await context.close();
});
