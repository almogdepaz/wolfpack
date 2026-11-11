import { expect, test } from "bun:test";
import { emptyFocus, isFocusDocument, isFocusOp, reduceFocus, type FocusTriage } from "../../src/focus-contract.ts";
import { focusCards, mergeFocus, type FocusSession } from "../../src/focus-ranking.ts";
import * as ranking from "../../src/focus-ranking.ts";

const now = "2026-11-06T12:00:00.000Z";
const later = "2026-11-06T12:01:00.000Z";
const rows: FocusTriage[] = [
  { ref: { machine: "home", sessionId: "a" }, stoppedAt: now, verdict: "needs-you", reason: "Choose a plan" },
  { ref: { intentionId: "ship" }, verdict: "needs-you", reason: "Choose the release" },
];
const initial = () => reduceFocus(emptyFocus(), [{ type: "add", intention: { id: "ship", title: "Ship" } }], now);
const take = { text: "Choose the plan before the release.", about: rows.map(r => r.ref) };
const order = (note: unknown = take) => ({ type: "next", rows, author: "assistant", take: note });

test("take is bounded one-line data tied to distinct refs in the same order, including no targets", () => {
  const doc = reduceFocus(initial(), [order()], now);
  expect(doc.next?.take).toEqual(take);
  expect(isFocusDocument(doc)).toBe(true);
  expect(reduceFocus(initial(), [order({ text: "x".repeat(200), about: [] })], now).next?.take?.text).toHaveLength(200);
  for (const text of ["", "  ", "x".repeat(201), "a\nb", "a\rb", "a\tb", "a\u001bb", "a\u2028b", "a\u2029b", "a\u202eb", "a\u200db", "a\ufe0fb"]) {
    expect(isFocusOp(order({ text, about: [] }))).toBe(false);
  }
  for (const invalid of [null, { text: "hi" }, { ...take, extra: true }, { text: "hi", about: [{}] },
    { text: "hi", about: [{ intentionId: "missing" }] }, { text: "hi", about: [rows[0]!.ref, rows[0]!.ref] },
    { text: "hi", about: [{ ...rows[0]!.ref, extra: true }] }, { text: "hi", about: Array(6).fill(rows[0]!.ref) }]) {
    expect(isFocusOp(order(invalid))).toBe(false);
    expect(isFocusDocument({ ...doc, next: { ...doc.next, take: invalid } })).toBe(false);
  }
  const five = Array.from({ length: 5 }, (_, i) => ({ ...rows[0]!, ref: { machine: "home", sessionId: `s${i}` } }));
  expect(isFocusOp({ type: "next", rows: five, author: "assistant", take: { text: "Cross-session risk", about: five.map(r => r.ref) } })).toBe(true);
});

test("dismissal pins the server order timestamp; replacement drops the take and old docs gain no new keys", () => {
  const legacy = reduceFocus(initial(), [{ type: "next", rows, author: "assistant" }, { type: "nudge", text: "legacy", author: "assistant" }], now);
  expect(isFocusDocument(legacy)).toBe(true);
  expect(legacy).not.toHaveProperty("seenTakeAt");
  expect(legacy.next).not.toHaveProperty("take");
  const doc = reduceFocus(legacy, [order()], now);
  expect(() => reduceFocus(doc, [{ type: "seen-take", at: later }], later)).toThrow();
  expect(() => reduceFocus(initial(), [{ type: "seen-take", at: now }], now)).toThrow();
  const seen = reduceFocus(doc, [{ type: "seen-take", at: now }], "2027-01-01T00:00:00Z");
  expect(seen.seenTakeAt).toBe(now);
  expect(isFocusDocument(seen)).toBe(true);
  expect(doc).not.toHaveProperty("seenTakeAt");
  expect(isFocusDocument({ ...seen, seenTakeAt: "bad" })).toBe(false);
  const replacement = reduceFocus(seen, [{ type: "next", rows, author: "assistant" }], later);
  expect(replacement.next).not.toHaveProperty("take");
  expect(reduceFocus(seen, [order()], later).next?.take).toEqual(take);
});

test("take visibility follows live assistant order, shared dismissal and every full-merge card episode", () => {
  const doc = reduceFocus(initial(), [order()], now);
  const sessions: FocusSession[] = [{ id: "a", name: "a", state: "needs-input", changedAt: now, machineInstallationId: "home" }];
  const options = { enabled: true, now: Date.parse(later), cap: Infinity, machineKnown: () => true, machineReachable: () => true };
  const visible = (d = doc, s = sessions, overrides = {}) => {
    const merge = mergeFocus(d, s, { ...options, ...overrides });
    return ranking.takeVisible(d, focusCards(merge.rows, s).cards, merge.order);
  };
  expect(visible()).toBe(true);
  expect(visible(doc, sessions, { enabled: false })).toBe(false);
  expect(visible(doc, sessions, { stale: true })).toBe(false);
  expect(visible(doc, sessions, { now: Date.parse(now) + 4 * 3600_000 })).toBe(false);
  expect(visible({ ...doc, next: { ...doc.next!, author: "rules" } })).toBe(false);
  expect(visible(reduceFocus(doc, [{ type: "seen-take", at: now }], later))).toBe(false);
  const seen = reduceFocus(doc, [{ type: "seen-take", at: now }], later);
  expect(visible(reduceFocus(seen, [order()], later))).toBe(true);
  expect(visible(doc, [{ ...sessions[0]!, state: "working" }])).toBe(false);
  expect(visible(doc, [{ ...sessions[0]!, changedAt: later }])).toBe(false);
  expect(visible(doc, [{ ...sessions[0]!, machineInstallationId: "other" }])).toBe(false);
  expect(visible(reduceFocus(doc, [{ type: "done", id: "ship" }], later))).toBe(false);
  expect(visible(reduceFocus(doc, [order({ text: "Where does add eggs belong?", about: [] })], now), [])).toBe(true);
  expect(visible(reduceFocus(doc, [{ type: "next", rows, author: "assistant" }], later))).toBe(false);
});
