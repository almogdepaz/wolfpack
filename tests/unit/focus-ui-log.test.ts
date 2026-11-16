import { expect, test } from "bun:test";
import { FOCUS_UI_ACTION as A, FOCUS_UI_CARD as C, parseFocusUiBatch, isFocusUiRow } from "../../src/focus-ui-log";
const base = { visit: "visit-1", at: "2026-11-16T12:00:00.000Z" };
const card = { session: "work", sessionId: "uuid-1", machine: "local", rank: 1, kind: "action", reason: "needs-you" };
test("focus ui validation accepts only bounded, content-free event shapes", () => {
  const events = [{ ...base, action: A.OPEN }, { ...base, action: A.LEFT, visibleMs: 1000 }, { ...base, action: A.SHOWN, cards: [card] }, { ...base, action: A.CARD, control: C.REPLY, session: "work", sessionId: "uuid-1", machine: "local" }];
  expect(parseFocusUiBatch({ events })).toEqual(events);
  expect(isFocusUiRow({ ...events[0], seq: 1 })).toBe(true);
  for (const event of events) {
    for (const key of ["text", "title", "prompt", "preview", "input", "terminal", "extra"]) expect(parseFocusUiBatch({ events: [{ ...event, [key]: "SECRET" }] })).toBeNull();
  }
  for (const value of [{ events, extra: true }, { events: [] }, { events: Array(33).fill(events[0]) }, { events: [{ ...base, action: "arbitrary" }] }, { events: [{ ...base, action: A.LEFT, visibleMs: -1 }] }, { events: [{ ...base, action: A.SHOWN, cards: [{ ...card, reason: "SECRET" }] }] }, { events: [{ ...base, action: A.SHOWN, cards: [{ ...card, preview: "SECRET" }] }] }, { events: [{ ...base, action: A.OPEN, visit: "x".repeat(129) }] }, { events: [{ ...base, action: A.OPEN, at: "bad" }] }]) expect(parseFocusUiBatch(value)).toBeNull();
});
