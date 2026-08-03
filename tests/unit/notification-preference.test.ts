import { describe, expect, test } from "bun:test";
import { applyNotificationPreference } from "../../src/notification-preference.ts";

describe("notification preference", () => {
  test("keeps notifications disabled when subscribe fails", async () => {
    const committed: boolean[] = [];

    const enabled = await applyNotificationPreference({
      current: false,
      requested: true,
      changeSubscription: async () => false,
      commit: (value) => { committed.push(value); },
    });

    expect(enabled).toBe(false);
    expect(committed).toEqual([false]);
  });

  test("keeps notifications enabled when unsubscribe fails", async () => {
    const committed: boolean[] = [];

    const enabled = await applyNotificationPreference({
      current: true,
      requested: false,
      changeSubscription: async () => false,
      commit: (value) => { committed.push(value); },
    });

    expect(enabled).toBe(true);
    expect(committed).toEqual([true]);
  });

  test("commits the requested preference only after subscription state changes", async () => {
    const operations: string[] = [];

    const enabled = await applyNotificationPreference({
      current: false,
      requested: true,
      changeSubscription: async () => {
        operations.push("subscription");
        return true;
      },
      commit: (value) => { operations.push(`commit:${value}`); },
    });

    expect(enabled).toBe(true);
    expect(operations).toEqual(["subscription", "commit:true"]);
  });
});
