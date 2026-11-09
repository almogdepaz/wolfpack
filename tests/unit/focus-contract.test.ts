import { describe, expect, test } from "bun:test";
import { emptyFocus, isFocusDocument, reduceFocus, type FocusOp, type FocusTriage } from "../../src/focus-contract.ts";

const now = "2026-11-06T12:00:00.000Z";
const add = { type: "add", intention: { id: "ship", title: "ship focus", project: "/dev/app", machine: "sgt", sessions: ["id-1"] } } as const;
describe("focus document", () => {
  test("adds, edits, completes, undoes, reorders and drops without mutating input", () => {
    const initial = emptyFocus();
    const one = reduceFocus(initial, [add], now);
    expect(initial.intentions).toEqual([]);
    expect(one.revision).toBe(1);
    expect(one.intentions[0]?.createdAt).toBe(now);
    const two = reduceFocus(one, [{ type: "add", intention: { id: "other", title: "other" } }, { type: "edit", id: "ship", patch: { title: "ship now" } }, { type: "done", id: "ship" }, { type: "reorder", ids: ["other", "ship"] }], now);
    expect(two.intentions.map(i => [i.id, i.done])).toEqual([["other", undefined], ["ship", true]]);
    // "we need to know when items are done": a tick is stamped, an undo clears the stamp
    expect(two.intentions[1]?.doneAt).toBe(now);
    expect(isFocusDocument({ ...two, intentions: [{ ...two.intentions[1]!, doneAt: "not a time" }] })).toBe(false);
    expect(reduceFocus(two, [{ type: "undo", id: "ship" }], now).intentions[1]).not.toHaveProperty("doneAt");
    expect(two.intentions[1]?.title).toBe("ship now");
    expect(reduceFocus(two, [{ type: "undo", id: "ship" }, { type: "drop", id: "other" }], now).intentions).toEqual([{ ...one.intentions[0], title: "ship now", done: false }]);
    expect(isFocusDocument(two)).toBe(true);
  });
  test("a repeated done keeps the first tick's time; a legacy done row without one gets stamped", () => {
    const later = "2026-11-06T15:30:00.000Z";
    const ticked = reduceFocus(reduceFocus(emptyFocus(), [add], now), [{ type: "done", id: "ship" }], now);
    expect(reduceFocus(ticked, [{ type: "done", id: "ship" }], later).intentions[0]?.doneAt).toBe(now);
    const legacy = { ...ticked, intentions: [{ ...ticked.intentions[0]!, doneAt: undefined }] };
    delete legacy.intentions[0]!.doneAt;
    expect(reduceFocus(legacy, [{ type: "done", id: "ship" }], later).intentions[0]?.doneAt).toBe(later);
  });
  test("bounded assistant data and shared day-note acknowledgement", () => {
    const doc = reduceFocus(emptyFocus(), [{ type: "nudge", text: "ship first", author: "assistant" }, { type: "note", text: "durable memory" }, { type: "day-summary", summary: { date: "2026-11-05", done: 4, carried: 2, questions: 1 } }, { type: "seen-day-note", at: now }], now);
    expect(doc.nudge).toEqual({ text: "ship first", author: "assistant", updatedAt: now });
    expect(doc.notes).toBe("durable memory");
    expect(doc.seenDayNoteAt).toBe(now);
    expect(isFocusDocument(doc)).toBe(true);
  });
  test("next stores bounded ordered triage without changing intentions or acknowledging sessions", () => {
    const initial = reduceFocus(emptyFocus(), [add], now);
    const rows: FocusTriage[] = [
      { ref: { machine: "installation-a", sessionId: "session-a" }, stoppedAt: now, verdict: "suggest", reason: "Continue the approved plan", suggestion: "Go ahead with the plan.", doneIntention: "ship" },
      { ref: { intentionId: "ship" }, verdict: "needs-you", reason: "Choose the product direction" },
      { ref: { machine: "offline-peer", sessionId: "session-b" }, stoppedAt: now, verdict: "quiet", reason: "Nothing for you" },
    ];
    const next = reduceFocus(initial, [{ type: "next", rows, author: "assistant" }], now);
    expect(next.next).toEqual({ rows, author: "assistant", updatedAt: now });
    expect(next.intentions).toEqual(initial.intentions);
    expect(initial).not.toHaveProperty("next");
    expect(isFocusDocument(next)).toBe(true);
    expect(reduceFocus(next, [{ type: "note", text: "no triage change" }], now).next).toEqual(next.next);
    expect(reduceFocus(next, [{ type: "next", rows: [], author: "assistant" }], now).next?.rows).toEqual([]);
    for (const patch of [
      { verdict: "sent" }, { verdict: ["quiet"] }, { verdict: { toString: () => "quiet" } }, { reason: "two\nlines" }, { reason: "x".repeat(301) },
      { suggestion: "x".repeat(201) }, { suggestion: "two\rline" }, { suggestion: "\u001b[31m" },
      { verdict: "quiet", suggestion: "go" }, { verdict: "needs-you", doneIntention: "ship" },
      { stoppedAt: undefined }, { stoppedAt: "bad" }, { ref: { sessionId: "a" } },
      { ref: { machine: "a", sessionId: "a", intentionId: "ship" } }, { extra: true },
    ]) expect(() => reduceFocus(initial, [{ type: "next", rows: [{ ...rows[0], ...patch }], author: "assistant" }], now)).toThrow();
    expect(() => reduceFocus(initial, [{ type: "next", rows: [{ ref: { machine: "peer", sessionId: "session" }, stoppedAt: now, verdict: ["quiet"], reason: "No user action" }], author: "assistant" }], now)).toThrow();
    expect(() => reduceFocus(initial, [{ type: "next", rows: [rows[0], rows[0]], author: "assistant" }], now)).toThrow();
    expect(() => reduceFocus(initial, [{ type: "next", rows: Array(201).fill(rows[0]), author: "assistant" }], now)).toThrow();
    expect(() => reduceFocus(initial, [{ type: "next", rows: [{ ...rows[0], doneIntention: "missing" }], author: "assistant" }], now)).toThrow();
    expect(() => reduceFocus(initial, [{ type: "next", rows: [{ ...rows[0], suggestion: undefined, doneIntention: undefined }], author: "assistant" }], now)).toThrow();
    expect(isFocusDocument({ ...next, next: { ...next.next, updatedAt: "bad" } })).toBe(false);
  });
  test("there is no reply op and no reply field: the user talks to the assistant in its terminal", () => {
    expect(() => reduceFocus(emptyFocus(), [{ type: "reply", text: "Broker leak first.", author: "assistant" } as unknown as FocusOp], now)).toThrow();
    expect(isFocusDocument({ ...emptyFocus(), reply: { text: "hi", author: "assistant", updatedAt: now } })).toBe(false);
  });
  test("rejects invalid operations atomically, duplicates, partial reorder, unknown fields and oversized text", () => {
    const doc = reduceFocus(emptyFocus(), [add], now);
    for (const ops of [[add], [{ type: "done", id: "missing" }], [{ type: "reorder", ids: [] }], [{ type: "edit", id: "ship", patch: { title: "" } }], [{ type: "note", text: "x".repeat(16001) }], [{ type: "done", id: "ship", extra: true }]]) {
      expect(() => reduceFocus(doc, ops, now)).toThrow();
    }
    expect(doc.revision).toBe(1);
    expect(isFocusDocument({ ...doc, version: 2 })).toBe(false);
    expect(isFocusDocument({ ...doc, intentions: [...doc.intentions, ...doc.intentions] })).toBe(false);
  });
});
