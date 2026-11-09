import { expect, test } from "bun:test";
import { createFocusReceipts, focusSuggestionKey } from "../../public/focus-receipts";
import type { FocusTriage } from "../../src/focus-contract";
const row: FocusTriage = { ref: { machine: "home", sessionId: "session" }, stoppedAt: "2026-11-09T12:00:00.000Z", verdict: "suggest", reason: "Continue", suggestion: "Continue the plan." };
const receipt = { label: "sent to session", state: "sent" as const, at: "2026-11-09T12:00:00.000Z" };
function storage() { let value: string | null = null; return { getItem: (_key: string) => value, setItem: (_key: string, next: string) => { value = next; } }; }
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
test("receipt writes fail closed on corrupt, unavailable or full storage, without erasing fences", () => {
  expect(() => createFocusReceipts({ getItem: () => "{bad", setItem: () => {} }).get("x")).toThrow("receipts");
  const data = storage(); const full = createFocusReceipts(data);
  for (let i = 0; i < 200; i++) full.put(String(i), receipt);
  expect(() => full.put("overflow", receipt)).toThrow("full");
  expect(full.get("0")).toEqual(receipt);
  full.put("0", { ...receipt, state: "check" });
  expect(full.get("0")?.state).toBe("check");
  const unavailable = createFocusReceipts({ getItem: () => null, setItem: () => { throw new Error("quota"); } });
  expect(() => unavailable.put("x", receipt)).toThrow("receipts");
});
