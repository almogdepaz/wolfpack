import { describe, expect, test } from "bun:test";
import { appendParentNotification, clearParentInbox, listParentNotifications } from "../../src/server/parent-inbox.ts";

describe("parent inbox", () => {
  test("sequences are per parent and timestamps and sender survive listing", () => {
    clearParentInbox("one"); clearParentInbox("two");
    const first = appendParentNotification("one", { message: "ready", from: "child" });
    expect(first.seq).toBe(1);
    expect(Number.isNaN(Date.parse(first.at))).toBe(false);
    expect(appendParentNotification("one", { message: "blocked" }).seq).toBe(2);
    expect(appendParentNotification("two", { message: "other" }).seq).toBe(1);
    expect(listParentNotifications("one", 1)).toEqual([{ seq: 2, at: expect.any(String), message: "blocked" }]);
    expect(listParentNotifications("one")[0]).toEqual({ ...first, message: "ready", from: "child" });
    expect(listParentNotifications("missing")).toEqual([]);
  });

  test("keeps the newest 100 without resetting sequence, and clear drops the inbox", () => {
    clearParentInbox("bounded");
    for (let i = 1; i <= 105; i++) appendParentNotification("bounded", { message: String(i) });
    const entries = listParentNotifications("bounded");
    expect(entries).toHaveLength(100);
    expect(entries[0]?.seq).toBe(6);
    expect(entries[99]?.seq).toBe(105);
    expect(listParentNotifications("bounded", 104)).toEqual([entries[99]!]);
    clearParentInbox("bounded");
    expect(listParentNotifications("bounded")).toEqual([]);
    expect(appendParentNotification("bounded", { message: "new" }).seq).toBe(1);
  });

  test("listing cannot mutate stored entries", () => {
    clearParentInbox("copies");
    appendParentNotification("copies", { message: "original" });
    const entries = listParentNotifications("copies");
    Object.assign(entries[0]!, { message: "changed" });
    entries.pop();
    expect(listParentNotifications("copies")[0]?.message).toBe("original");
  });
});
