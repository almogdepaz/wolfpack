import { describe, expect, test } from "bun:test";
import { NOTIFY_UNDELIVERED_REASON, notifyDelivery } from "../../src/notify-contract.ts";

describe("notify delivery contract", () => {
  test("any sent push is delivered, even when other endpoints failed", () => {
    expect(notifyDelivery({ sent: 1, failed: 0 })).toEqual({ delivered: true });
    expect(notifyDelivery({ sent: 2, failed: 3 })).toEqual({ delivered: true });
  });

  test("nothing sent and nothing failed means there was no subscription to deliver to", () => {
    expect(notifyDelivery({ sent: 0, failed: 0 })).toEqual({
      delivered: false,
      reason: NOTIFY_UNDELIVERED_REASON.NO_SUBSCRIPTIONS,
    });
  });

  test("nothing sent with failures means delivery failed", () => {
    expect(notifyDelivery({ sent: 0, failed: 2 })).toEqual({
      delivered: false,
      reason: NOTIFY_UNDELIVERED_REASON.DELIVERY_FAILED,
    });
  });

  test("reasons keep their wire spelling", () => {
    expect(NOTIFY_UNDELIVERED_REASON).toEqual({
      NO_SUBSCRIPTIONS: "no_subscriptions",
      DELIVERY_FAILED: "delivery_failed",
    });
  });
});
