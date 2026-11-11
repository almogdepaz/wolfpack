import { expect, test } from "bun:test";
import { createFocusReceipts, focusSuggestionKey, focusReplyKey } from "../../public/focus-receipts";
import type { FocusTriage } from "../../src/focus-contract";
const row: FocusTriage = { ref: { machine: "home", sessionId: "session" }, stoppedAt: "2026-11-09T12:00:00.000Z", verdict: "suggest", reason: "Continue", suggestion: "Continue the plan." };
const receipt = { label: "sent to session", state: "sent" as const, at: "2026-11-09T12:00:00.000Z" };
function storage() { let value: string | null = null; return { getItem: (_key: string) => value, setItem: (_key: string, next: string) => { value = next; } }; }
test("empty-box replies fence the physical ref and episode, independently of edited text", () => {
  const ref = { machine: "home", sessionId: "session" };
  const key = focusReplyKey(ref, row.stoppedAt!);
  expect(JSON.parse(key)).toEqual([JSON.parse(focusSuggestionKey(row))[0], Date.parse(row.stoppedAt!), "reply"]);
  expect(focusReplyKey({ sessionId: "session", machine: "home" }, "2026-11-09T14:00:00+02:00")).toBe(key);
  expect(focusReplyKey(ref, "2026-11-09T12:01:00Z")).not.toBe(key);
  expect(focusReplyKey({ ...ref, machine: "peer" }, row.stoppedAt!)).not.toBe(key);
  const data = storage();
  createFocusReceipts(data).put(key, { ...receipt, text: "the user's reply" });
  expect(createFocusReceipts(data).get(key)).toMatchObject({ state: "sent", text: "the user's reply" });
});
test("R3: stable receipt identity survives equivalent ref and episode serialization", () => {
  const original = focusSuggestionKey(row);
  expect(focusSuggestionKey({ ...row, ref: { sessionId: "session", machine: "home" }, stoppedAt: "2026-11-09T14:00:00+02:00" })).toBe(original);
  for (const changed of [{ suggestion: "Different draft" }, { stoppedAt: "2026-11-09T12:01:00Z" }, { ref: { machine: "other", sessionId: "session" } }]) expect(focusSuggestionKey({ ...row, ...changed })).not.toBe(original);
  const data = storage(); const first = createFocusReceipts(data); first.put(original, receipt);
  expect(createFocusReceipts(data).get(original)).toEqual(receipt);
});
test("a reload during an in-flight send fences uncertain delivery instead of inviting another send", () => {
  const data = storage(); const first = createFocusReceipts(data); const key = focusSuggestionKey(row);
  first.put(key, { ...receipt, state: "sending", label: "sending" });
  expect(first.get(key)?.state).toBe("sending");
  expect(createFocusReceipts(data).get(key)).toMatchObject({ state: "check", label: "delivery unconfirmed · check the session" });
});
test("receipt writes fail closed on corrupt or unavailable storage", () => {
  expect(() => createFocusReceipts({ getItem: () => "{bad", setItem: () => {} }).get("x")).toThrow("receipts");
  const unavailable = createFocusReceipts({ getItem: () => null, setItem: () => { throw new Error("quota"); } });
  expect(() => unavailable.put("x", receipt)).toThrow("receipts");
});
test("N1: old settled fences make room while recent and sending fences survive", () => {
  const data = storage(); const old = Date.parse(receipt.at);
  const first = createFocusReceipts(data, () => old);
  for (let i = 0; i < 198; i++) first.put(String(i), receipt);
  first.put("in-flight", { ...receipt, state: "sending" });
  first.put("recent", { ...receipt, at: new Date(old + 6 * 86400_000).toISOString() });
  const later = createFocusReceipts(data, () => old + 7 * 86400_000 + 1);
  later.put("new", { ...receipt, at: new Date(old + 7 * 86400_000 + 1).toISOString() });
  expect(later.get("0")).toBeUndefined();
  expect(later.get("recent")).toEqual({ ...receipt, at: new Date(old + 6 * 86400_000).toISOString() });
  expect(later.get("in-flight")?.state).toBe("check");
  expect(later.get("new")?.state).toBe("sent");
});
test("N1: a long error label cannot poison the store and invalid writes never change it", () => {
  const data = storage(); const store = createFocusReceipts(data);
  store.put("long", { ...receipt, label: "x".repeat(1001) });
  expect(store.get("long")?.label).toBe("x".repeat(1000));
  store.put("good", receipt);
  expect(store.get("good")).toEqual(receipt);
  expect(() => store.put("bad", { ...receipt, at: "bad" })).toThrow();
  expect(() => store.put("x".repeat(2001), receipt)).toThrow();
  expect(store.get("good")).toEqual(receipt);
});
