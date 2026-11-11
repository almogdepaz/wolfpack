import { expect, test } from "bun:test";
import { createFocusReceipts, focusSuggestionKey, focusReplyKey } from "../../public/focus-receipts";
import { focusNextRefKey, type FocusTriage } from "../../src/focus-contract";
const row: FocusTriage = { ref: { machine: "home", sessionId: "session" }, stoppedAt: "2026-11-09T12:00:00.000Z", verdict: "suggest", reason: "Continue", suggestion: "Continue the plan." };
const receipt = { label: "sent to session", state: "sent" as const, at: "2026-11-09T12:00:00.000Z" };
function storage() { let value: string | null = null; return { getItem: (_key: string) => value, setItem: (_key: string, next: string) => { value = next; } }; }
test("empty-box replies fence the physical ref and episode, independently of edited text", () => {
  const ref = { machine: "home", sessionId: "session" };
  const key = focusReplyKey(ref, row.stoppedAt!);
  expect(JSON.parse(key)).toEqual(["reply", JSON.parse(focusSuggestionKey(row))[1], Date.parse(row.stoppedAt!)]);
  expect(focusReplyKey({ sessionId: "session", machine: "home" }, "2026-11-09T14:00:00+02:00")).toBe(key);
  expect(focusReplyKey(ref, "2026-11-09T12:01:00Z")).not.toBe(key);
  expect(focusReplyKey({ ...ref, machine: "peer" }, row.stoppedAt!)).not.toBe(key);
  const data = storage();
  createFocusReceipts(data).put(key, { ...receipt, text: "the user's reply" });
  expect(createFocusReceipts(data).get(key)).toMatchObject({ state: "sent", text: "the user's reply" });
});
test("send keys have distinct domains and all modes share the physical episode fence", () => {
  const suggestion = focusSuggestionKey({ ...row, suggestion: "reply" });
  const reply = focusReplyKey(row.ref, row.stoppedAt!);
  expect(suggestion).not.toBe(reply);
  const data = storage(); const store = createFocusReceipts(data);
  store.put(suggestion, { ...receipt, text: "reply", state: "check" });
  expect(store.get(reply)).toBeUndefined();
  expect(store.forEpisode(reply)).toMatchObject({ state: "check", text: "reply" });
  expect(store.forEpisode(focusSuggestionKey({ ...row, suggestion: "Another suggestion" }))).toMatchObject({ state: "check" });
  expect(store.forEpisode(focusReplyKey(row.ref, "2026-11-09T12:01:00Z"))).toBeUndefined();
});
test("legacy suggestion and ambiguous reply keys remain physical fences without claiming a new suggestion was sent", () => {
  for (const suggestion of ["Continue the plan", "reply"]) {
    const data = storage(); const legacy = JSON.stringify([focusNextRefKey(row.ref), Date.parse(row.stoppedAt!), suggestion]);
    createFocusReceipts(data).put(legacy, { ...receipt, text: "previous text", state: "sending" });
    const reloaded = createFocusReceipts(data);
    expect(reloaded.forEpisode(focusReplyKey(row.ref, row.stoppedAt!))).toMatchObject({ state: "check", text: "previous text" });
    if (suggestion === "reply") expect(reloaded.get(focusSuggestionKey({ ...row, suggestion }))).toBeUndefined();
    else expect(reloaded.get(focusSuggestionKey({ ...row, suggestion }))).toMatchObject({ state: "check", text: "previous text" });
  }
});
test("only a not-delivered receipt permits a different action on the same episode", () => {
  const store = createFocusReceipts(storage());
  store.put(focusSuggestionKey(row), { ...receipt, state: "retry" });
  expect(store.forEpisode(focusReplyKey(row.ref, row.stoppedAt!))).toBeUndefined();
});
test("R3: stable receipt identity survives equivalent ref and episode serialization", () => {
  const original = focusSuggestionKey(row);
  expect(focusSuggestionKey({ ...row, ref: { sessionId: "session", machine: "home" }, stoppedAt: "2026-11-09T14:00:00+02:00" })).toBe(original);
  for (const changed of [{ suggestion: "Different draft" }, { stoppedAt: "2026-11-09T12:01:00Z" }, { ref: { machine: "other", sessionId: "session" } }]) expect(focusSuggestionKey({ ...row, ...changed })).not.toBe(original);
  const data = storage(); const first = createFocusReceipts(data); first.put(original, receipt);
  expect(createFocusReceipts(data).get(original)).toEqual(receipt);
});
test("a reload during an in-flight send fences uncertain delivery instead of inviting another send", () => {
  const data = storage(); const first = createFocusReceipts(data, () => Date.parse(receipt.at)); const key = focusSuggestionKey(row);
  first.put(key, { ...receipt, state: "sending", label: "sending" });
  expect(first.get(key)?.state).toBe("sending");
  expect(createFocusReceipts(data).get(key)).toMatchObject({ state: "check", label: "delivery unconfirmed · check the session" });
});
test("an orphaned send becomes check at two minutes, including the current tab and episode fence", () => {
  const data = storage(); const start = Date.parse(receipt.at);
  let now = start;
  const store = createFocusReceipts(data, () => now);
  const key = focusSuggestionKey(row);
  store.put(key, { ...receipt, state: "sending", label: "sending", text: row.suggestion });
  now = start + 119_999;
  expect(store.get(key)?.state).toBe("sending");
  expect(store.forEpisode(focusReplyKey(row.ref, row.stoppedAt!))?.state).toBe("sending");
  now++;
  const uncertain = { state: "check", label: "delivery unconfirmed · check the session", text: row.suggestion };
  expect(store.get(key)).toMatchObject(uncertain);
  expect(store.forEpisode(focusReplyKey(row.ref, row.stoppedAt!))).toMatchObject(uncertain);
  expect(createFocusReceipts(data, () => now).get(key)).toMatchObject(uncertain);
  now += 60_000;
  expect(store.get(key)?.state).toBe("check");
  // A late observed outcome may settle the fence, never replay the send.
  store.put(key, { ...receipt, state: "sent", at: new Date(now).toISOString() });
  expect(store.get(key)?.state).toBe("sent");
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
