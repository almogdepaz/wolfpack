import { describe, expect, test } from "bun:test";
import { applyNotificationPreference } from "../../src/notification-preference.ts";

describe("notification preference", () => {
  test("keeps notifications disabled and preserves the subscribe failure reason", async () => {
    const committed: boolean[] = [];
    const change = { ok: false as const, reason: "permission-denied" as const };

    const outcome = await applyNotificationPreference({
      current: false,
      requested: true,
      changeSubscription: async () => change,
      commit: (value) => { committed.push(value); },
    });

    expect(outcome).toEqual({ enabled: false, change });
    expect(committed).toEqual([false]);
  });

  test("keeps notifications enabled and preserves the unsubscribe failure reason", async () => {
    const committed: boolean[] = [];
    const change = { ok: false as const, reason: "unsubscribe-failed" as const };

    const outcome = await applyNotificationPreference({
      current: true,
      requested: false,
      changeSubscription: async () => change,
      commit: (value) => { committed.push(value); },
    });

    expect(outcome).toEqual({ enabled: true, change });
    expect(committed).toEqual([true]);
  });

  test("commits the requested preference only after subscription state changes", async () => {
    const operations: string[] = [];
    const change = { ok: true as const };

    const outcome = await applyNotificationPreference({
      current: false,
      requested: true,
      changeSubscription: async () => {
        operations.push("subscription");
        return change;
      },
      commit: (value) => { operations.push(`commit:${value}`); },
    });

    expect(outcome).toEqual({ enabled: true, change });
    expect(operations).toEqual(["subscription", "commit:true"]);
  });
});
