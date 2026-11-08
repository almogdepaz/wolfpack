import { describe, expect, test } from "bun:test";
import { emptyFocus, isFocusDocument, reduceFocus, type FocusOp } from "../../src/focus-contract.ts";

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
