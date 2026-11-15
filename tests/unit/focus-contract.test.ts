import { describe, expect, test } from "bun:test";
import { emptyFocus, focusPastedReply, focusReplyHasHiddenControl, isFocusDocument, reduceFocus, type FocusOp, type FocusTriage } from "../../src/focus-contract.ts";

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
  test("prunes done intentions at seven days, retaining recent, open and undated legacy items", () => {
    const atAge = (age: number) => new Date(Date.parse(now) - age).toISOString();
    const week = 7 * 864e5;
    const initial = { ...emptyFocus(), intentions: [
      { id: "older", title: "older", createdAt: now, done: true, doneAt: atAge(week + 1) },
      { id: "boundary", title: "boundary", createdAt: now, done: true, doneAt: atAge(week) },
      { id: "recent", title: "recent", createdAt: now, done: true, doneAt: atAge(week - 1) },
      { id: "open", title: "open", createdAt: now, done: false, doneAt: atAge(week + 1) },
      { id: "legacy", title: "legacy", createdAt: now, done: true },
    ] };
    const saved = reduceFocus(initial, [{ type: "note", text: "trigger a write" }], now);
    expect(saved.intentions.map(i => i.id)).toEqual(["recent", "open", "legacy"]);
    expect(initial.intentions).toHaveLength(5);
    expect(saved.revision).toBe(1);
  });
  test("prunes before add at the cap, including a reorder computed from the current ids", () => {
    const initial = { ...emptyFocus(), intentions: Array.from({ length: 200 }, (_, n) => ({
      id: `item-${n}`, title: `item ${n}`, createdAt: now,
      ...(n === 0 && { done: true, doneAt: "2026-10-01T12:00:00.000Z" }),
    })) };
    expect(isFocusDocument(initial)).toBe(true);
    const saved = reduceFocus(initial, [add], now);
    expect(saved.intentions).toHaveLength(200);
    expect(saved.intentions.at(-1)?.id).toBe("ship");
    expect(saved.intentions.some(i => i.id === "item-0")).toBe(false);
    const smaller = { ...initial, intentions: initial.intentions.slice(0, 3) };
    expect(reduceFocus(smaller, [add, { type: "reorder", ids: ["ship", ...smaller.intentions.map(i => i.id)] }], now).intentions.map(i => i.id)).toEqual(["ship", "item-1", "item-2"]);
  });
  test("pruned next, take and doneIntention refs do not poison this or later writes", () => {
    const initial = reduceFocus(emptyFocus(), [add, { type: "done", id: "ship" }], "2026-10-01T12:00:00.000Z");
    const rows: FocusTriage[] = [
      { ref: { intentionId: "ship" }, verdict: "needs-you", reason: "old task" },
      { ref: { machine: "peer", sessionId: "hint-only" }, stoppedAt: now, verdict: "suggest", reason: "done hint", doneIntention: "ship" },
      { ref: { machine: "peer", sessionId: "reply" }, stoppedAt: now, verdict: "suggest", reason: "reply too", doneIntention: "ship", suggestion: "Continue." },
    ];
    const next = { type: "next", author: "assistant", rows, take: { text: "Priorities", about: rows.map(row => row.ref) } } as const;
    const withNext = reduceFocus(initial, [next], "2026-10-01T13:00:00.000Z");
    for (const saved of [reduceFocus(withNext, [{ type: "note", text: "later" }], now), reduceFocus(initial, [next], now)]) {
      expect(saved.intentions).toEqual([]);
      expect(saved.next?.rows).toEqual([{ ref: rows[2]!.ref, stoppedAt: now, verdict: "suggest", reason: "reply too", suggestion: "Continue." }]);
      expect(saved.next?.take?.about).toEqual([rows[2]!.ref]);
      expect(isFocusDocument(saved)).toBe(true);
      expect(() => reduceFocus(saved, [{ type: "next", rows: saved.next!.rows, take: saved.next!.take, author: "assistant" }, { type: "note", text: "another write" }], now)).not.toThrow();
    }
    expect(() => reduceFocus(initial, [{ ...next, rows: [{ ...rows[0], ref: { intentionId: "unknown" } }], take: undefined }], now)).toThrow("intention not found: unknown");
  });
  test("next may reference an id re-added after its old completion was pruned", () => {
    const initial = reduceFocus(emptyFocus(), [add, { type: "done", id: "ship" }], "2026-10-01T12:00:00.000Z");
    const rows: FocusTriage[] = [{ ref: { intentionId: "ship" }, verdict: "needs-you", reason: "new work" }];
    const saved = reduceFocus(initial, [add, { type: "next", author: "assistant", rows, take: { text: "New priority", about: [rows[0]!.ref] } }], now);
    expect(saved.intentions[0]?.done).toBeUndefined();
    expect(saved.next?.rows).toEqual(rows);
    expect(saved.next?.take?.about).toEqual([rows[0]!.ref]);
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
  test("M2/L2: suggestions and reasons cannot conceal text or invoke harness commands", () => {
    const initial = reduceFocus(emptyFocus(), [add], now);
    const row = { ref: { machine: "peer", sessionId: "session" }, stoppedAt: now, verdict: "suggest", reason: "Continue the approved plan", suggestion: "Continue the plan." };
    for (const hidden of ["\u202e", "\u202a", "\u2066", "\u2069", "\u200e", "\u200f", "\u200b", "\u200c", "\u200d", "\ufeff", "\u00ad", "\u034f", "\ufe0f"]) {
      for (const field of ["suggestion", "reason"] as const) {
        if (field === "reason" && ["\u200d", "\ufe0f"].includes(hidden)) continue;
        expect(() => reduceFocus(initial, [{ type: "next", rows: [{ ...row, [field]: `continue${hidden} safely` }], author: "assistant" }], now)).toThrow();
      }
    }
    for (const suggestion of ["/clear", "!git push", "   /clear", "  ! command"]) {
      expect(() => reduceFocus(initial, [{ type: "next", rows: [{ ...row, suggestion }], author: "assistant" }], now)).toThrow();
    }
    expect(reduceFocus(initial, [{ type: "next", rows: [{ ...row, suggestion: "Continue — café 中文 😀;  keep scope." }], author: "assistant" }], now).next?.rows[0]?.suggestion).toBe("Continue — café 中文 😀;  keep scope.");
  });
  test("N2: emoji formatting is allowed in reasons only, without bypassing the raw reason bound", () => {
    const row = { ref: { machine: "peer", sessionId: "session" }, stoppedAt: now, verdict: "suggest", suggestion: "Continue the plan." };
    for (const reason of ["✔️ done", "👩‍💻 review"]) {
      const doc = reduceFocus(emptyFocus(), [{ type: "next", author: "assistant", rows: [{ ...row, reason }] }], now);
      expect(doc.next?.rows[0]?.reason).toBe(reason);
      expect(() => reduceFocus(emptyFocus(), [{ type: "next", author: "assistant", rows: [{ ...row, reason, suggestion: reason }] }], now)).toThrow();
      expect(() => reduceFocus(emptyFocus(), [{ type: "next", author: "assistant", rows: [{ ...row, reason, ref: { ...row.ref, sessionId: reason } }] }], now)).toThrow();
    }
    expect(() => reduceFocus(emptyFocus(), [{ type: "next", author: "assistant", rows: [{ ...row, reason: `x${"\u200d".repeat(300)}` }] }], now)).toThrow();
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

describe("user-edited replies", () => {
  test("hidden terminal controls and invisible formatting are refused; visible commands and emoji are kept", () => {
    for (const hidden of ["Continue\u001b[D", "go\tnow", "Continue\u202e", "a\u200bb", "x\u0007", "a\u0085b", "go\u2028on"]) expect(focusReplyHasHiddenControl(hidden)).toBe(true);
    for (const visible of ["/review notes  exactly as typed", "!ls -la", "continue with step 2", "ship it 👩‍💻 ❤️", "naïve café"]) expect(focusReplyHasHiddenControl(visible)).toBe(false);
  });
  test("pasting flattens line breaks and tabs to spaces and drops other hidden controls", () => {
    expect(focusPastedReply("one\r\ntwo\nthree\tfour")).toBe("one two three four");
    expect(focusPastedReply("Continue\u001b[D\u202e ok\u200b")).toBe("Continue[D ok");
    expect(focusPastedReply("ship it 👩‍💻 ❤️")).toBe("ship it 👩‍💻 ❤️");
    expect(focusReplyHasHiddenControl(focusPastedReply("a\u0000b\u009bc\u2066d"))).toBe(false);
  });
});
