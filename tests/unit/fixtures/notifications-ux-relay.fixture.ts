import { beforeEach, afterEach, expect, test } from "bun:test";
import { assertNotificationFixtureHome } from "./run-notification-test.ts";
import type { PushPayload } from "../../../src/server/push.ts";
assertNotificationFixtureHome();
const { addSubscription, removeSubscription, checkSessionTransitions, recordQuietAlertEmission, _testing } = await import("../../../src/server/push.ts");
const endpoint = "https://fcm.googleapis.com/ux-relay";
const machine = { identity: "n123:12345678-1234-4234-8234-123456789abc", name: "laptop" };
const fact = { name: "agent", identity: { wolfpackSessionId: "same" }, quietAlert: { kind: "quiet" as const, sessionId: "same", episodeId: "episode", eligibleAtMs: 100, observedAtMs: 150 } };
let payloads: PushPayload[];
beforeEach(() => { _testing.resetDebounce(); addSubscription({ endpoint, keys: { p256dh: "x", auth: "x" } }); payloads = []; _testing.sessionPushSender = async payload => { payloads.push(payload); return { sent: 1, failed: 0, pruned: 0 }; }; });
afterEach(() => { removeSubscription(endpoint); _testing.resetDebounce(); });
test("peer episodes dedupe independently of local ids and route on home origin", async () => {
  recordQuietAlertEmission("same", "episode");
  await checkSessionTransitions([fact]);
  await checkSessionTransitions([fact], undefined, undefined, machine);
  await checkSessionTransitions([fact], undefined, undefined, machine);
  await checkSessionTransitions([fact]);
  expect(payloads).toHaveLength(2);
  expect(payloads[1].title).toContain("laptop");
  expect(new URL(payloads[1].url!, "https://home.example").searchParams.get("machine")).toBe(machine.identity);
});

test("peer retry preserves the original recipients across local pruning and new enrollments", async () => {
  const late = "https://fcm.googleapis.com/ux-relay-late";
  const originalNow = Date.now;
  let now = 100_000;
  Date.now = () => now;
  const targets: string[][] = [];
  _testing.sessionPushSender = async (_payload, endpoints) => {
    targets.push([...endpoints]);
    return targets.length === 1
      ? { sent: 0, failed: 1, pruned: 0, failedEndpoints: [endpoint] }
      : { sent: 1, failed: 0, pruned: 0, successfulEndpoints: [endpoint] };
  };
  try {
    await checkSessionTransitions([fact], undefined, undefined, machine);
    await checkSessionTransitions([]); // Local observation must not prune peer state.
    addSubscription({ endpoint: late, keys: { p256dh: "x", auth: "x" } });
    await checkSessionTransitions([fact], undefined, undefined, machine);
    expect(targets).toEqual([[endpoint]]);
    now += 30_000;
    await checkSessionTransitions([fact], undefined, undefined, machine);
    expect(targets).toEqual([[endpoint], [endpoint]]);
    await checkSessionTransitions([fact], undefined, undefined, machine);
    expect(targets).toHaveLength(2);
  } finally { Date.now = originalNow; removeSubscription(late); }
});

test("changing local quiet policy does not re-deliver a peer-owned episode", async () => {
  const { invalidateQuietAlertPolicy } = await import("../../../src/quiet-alert-policy-invalidation.ts");
  await checkSessionTransitions([fact], undefined, undefined, machine);
  invalidateQuietAlertPolicy();
  await checkSessionTransitions([fact], undefined, undefined, machine);
  expect(payloads).toHaveLength(1);
});

test("peer policies are not synthesized and ids on two peers cannot collide", async () => {
  await checkSessionTransitions([{ name: "agent", identity: fact.identity }], undefined, undefined, machine);
  expect(payloads).toEqual([]);
  await checkSessionTransitions([fact], undefined, undefined, machine);
  await checkSessionTransitions([fact], undefined, undefined, { ...machine, identity: "n456:12345678-1234-4234-8234-123456789abc" });
  expect(payloads).toHaveLength(2);
});

test("an already-old peer episode seen for the first time is a baseline, not a notification", async () => {
  const stale = { ...fact, quietAlert: { ...fact.quietAlert, episodeId: "old", eligibleAtMs: 1_000, observedAtMs: 3_601_000 } };
  await checkSessionTransitions([stale], undefined, undefined, machine);
  await checkSessionTransitions([stale], undefined, undefined, machine);
  expect(payloads).toEqual([]);
  const fresh = { ...fact, quietAlert: { ...fact.quietAlert, episodeId: "new", eligibleAtMs: 3_700_000, observedAtMs: 3_705_000 } };
  await checkSessionTransitions([fresh], undefined, undefined, machine);
  expect(payloads).toHaveLength(1);
});
