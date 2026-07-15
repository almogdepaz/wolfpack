import { beforeEach, describe, expect, test } from "bun:test";
import {
  unsubscribePushNotifications,
  type NotificationUnsubscribeState,
  type PushSubscriptionHandle,
} from "../../src/push-unsubscribe.ts";

let state: NotificationUnsubscribeState;
let localUnsubscribeCalls: number;
let subscription: PushSubscriptionHandle;

beforeEach(() => {
  state = {
    notificationsEnabled: true,
    notificationUnsubscribePending: false,
    notificationUnsubscribeInFlight: false,
  };
  localUnsubscribeCalls = 0;
  subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/retry-cleanup",
    unsubscribe: async () => {
      localUnsubscribeCalls++;
      return true;
    },
  };
});

describe("push notification unsubscribe retry", () => {
  test("retains the local subscription and retry state after server cleanup fails", async () => {
    const outcome = await unsubscribePushNotifications(
      state,
      async () => subscription,
      async () => ({ ok: false, status: 503 }),
    );

    expect(outcome.ok).toBe(false);
    expect(localUnsubscribeCalls).toBe(0);
    expect(state.notificationsEnabled).toBe(true);
    expect(state.notificationUnsubscribePending).toBe(true);
    expect(state.notificationUnsubscribeInFlight).toBe(false);
  });

  test("a retry clears server and browser state in order", async () => {
    state.notificationUnsubscribePending = true;
    const operations: string[] = [];
    subscription = {
      endpoint: subscription.endpoint,
      unsubscribe: async () => {
        operations.push("browser");
        localUnsubscribeCalls++;
        return true;
      },
    };

    const outcome = await unsubscribePushNotifications(
      state,
      async () => subscription,
      async () => {
        operations.push("server");
        return { ok: true, status: 200 };
      },
    );

    expect(outcome).toEqual({ ok: true, removed: true });
    expect(operations).toEqual(["server", "browser"]);
    expect(localUnsubscribeCalls).toBe(1);
    expect(state.notificationsEnabled).toBe(false);
    expect(state.notificationUnsubscribePending).toBe(false);
  });
});
