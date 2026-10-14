import { afterAll, expect } from "bun:test";
import { assertNotificationFixtureHome } from "./run-notification-test.ts";
import "../push-test-route.test.ts";
import "../notifications-ux-relay.test.ts";
import "../peer-notification-observer.test.ts";

// This verifier itself runs under a synthetic HOME, never the operator HOME.
assertNotificationFixtureHome();
const { _testing } = await import("../../../src/server/push.ts");
const { quietAlertPolicyEpoch } = await import("../../../src/quiet-alert-policy-invalidation.ts");
const { __setTestBackend, getBackend } = await import("../../../src/server/backend.ts");
const { MockBackend } = await import("../../../src/server/mock-backend.ts");
// Entry-point suites must not change its process-global delivery/backend state.
const backend = new MockBackend({ sessions: [] });
__setTestBackend(backend);
const timestamps = [123];
_testing.notifyTimestamps = timestamps;
const epoch = quietAlertPolicyEpoch();
const env = { ...process.env };
const fetcher = globalThis.fetch;
afterAll(() => {
  expect(_testing.notifyTimestamps).toBe(timestamps);
  expect(quietAlertPolicyEpoch()).toBe(epoch);
  expect(getBackend()).toBe(backend);
  expect(globalThis.fetch).toBe(fetcher);
  expect({ ...process.env }).toEqual(env);
});
