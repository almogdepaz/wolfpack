import { expect, test } from "bun:test";
import { FOCUS_UI_ACTION as A, FOCUS_UI_CARD as C, parseFocusUiBatch, isFocusUiRow } from "../../src/focus-ui-log";
const base = { visit: "a8eb5e25-b8ac-4384-aa0a-c60f7dfcbded", at: "2026-11-16T12:00:00.000Z" };
const card = { session: "work", sessionId: "uuid-1", machine: "local", rank: 1, kind: "action" as const, reason: "needs-you" as const };
test("per-card done and the take's reply-to-chat are distinct content-free actions", () => {
  const events = [{ ...base, action: A.CARD, control: "done", session: "work", sessionId: "uuid-1", machine: "local" }, { ...base, action: A.ASSISTANT, control: "reply" }];
  expect(parseFocusUiBatch({ events })).not.toBeNull();
});
test("identifier fields reject prose while preserving focus ids, session selectors and machine identities", () => {
  const prose = "my confidential intention: discuss salary with alice";
  const event = { ...base, action: A.CARD, control: C.OPEN, session: "work", sessionId: "mock:work", machine: "local" };
  for (const field of ["visit", "session", "sessionId", "machine"]) expect(parseFocusUiBatch({ events: [{ ...event, [field]: prose }] })).toBeNull();
  for (const field of ["session", "sessionId", "machine"]) expect(parseFocusUiBatch({ events: [{ ...base, action: A.SHOWN, cards: [{ ...card, [field]: prose }] }] })).toBeNull();
  for (const [action, control] of [[A.INTENTION, "edit"], [A.ASSISTANT, "plan"], [A.DISCLOSURE, "expand"]]) {
    expect(parseFocusUiBatch({ events: [{ ...base, action, control, id: prose }] })).toBeNull();
    expect(parseFocusUiBatch({ events: [{ ...base, action, control, id: "ship" }] })).not.toBeNull();
  }
  for (const id of ["_not-focus-id", "a".repeat(129), "ship:salary"]) expect(parseFocusUiBatch({ events: [{ ...base, action: A.INTENTION, control: "edit", id }] })).toBeNull();
  for (const machine of ["local", "b8eb5e25-b8ac-4384-aa0a-c60f7dfcbded", "https://host.tail123.ts.net"]) expect(parseFocusUiBatch({ events: [{ ...event, machine }] })).not.toBeNull();
  for (const rank of [0, -1, 1.5, 129, prose]) expect(parseFocusUiBatch({ events: [{ ...base, action: A.SHOWN, cards: [{ ...card, rank }] }] })).toBeNull();
});
test("intention card identities are exclusive, content-free and distinguish their rendered surface", () => {
  const shown = { ...base, action: A.SHOWN, cards: [{ intentionId: "ship", rank: 1, kind: "action", reason: "needs-you" }, { intentionId: "ship", surface: "today", rank: 2, kind: "action", reason: "rules" }] };
  expect(parseFocusUiBatch({ events: [shown, { ...base, action: A.CARD, intentionId: "ship", control: "review" }] })).not.toBeNull();
  for (const target of [{ intentionId: "my confidential intention: discuss salary with alice" }, { intentionId: "ship", session: "work", sessionId: "mock:work", machine: "local" }]) {
    expect(parseFocusUiBatch({ events: [{ ...base, action: A.CARD, control: "review", ...target }] })).toBeNull();
    expect(parseFocusUiBatch({ events: [{ ...shown, cards: [{ ...shown.cards[0], ...target }] }] })).toBeNull();
  }
  expect(parseFocusUiBatch({ events: [{ ...base, action: A.CARD, intentionId: "ship", control: "review", surface: "PRIVATE_TITLE" }] })).toBeNull();
});
test("focus ui validation accepts only bounded, content-free event shapes", () => {
  const events = [{ ...base, action: A.OPEN }, { ...base, action: A.LEFT, visibleMs: 1000 }, { ...base, action: A.SHOWN, cards: [card] }, { ...base, action: A.CARD, control: C.REPLY, session: "work", sessionId: "uuid-1", machine: "local" }];
  expect(parseFocusUiBatch({ events })).toEqual(events);
  expect(isFocusUiRow({ ...events[0], seq: 1 })).toBe(true);
  for (const event of events) {
    for (const key of ["text", "title", "prompt", "preview", "input", "terminal", "extra"]) expect(parseFocusUiBatch({ events: [{ ...event, [key]: "SECRET" }] })).toBeNull();
  }
  for (const value of [{ events, extra: true }, { events: [] }, { events: Array(33).fill(events[0]) }, { events: [{ ...base, action: "arbitrary" }] }, { events: [{ ...base, action: A.LEFT, visibleMs: -1 }] }, { events: [{ ...base, action: A.SHOWN, cards: [{ ...card, reason: "SECRET" }] }] }, { events: [{ ...base, action: A.SHOWN, cards: [{ ...card, preview: "SECRET" }] }] }, { events: [{ ...base, action: A.OPEN, visit: "x".repeat(129) }] }, { events: [{ ...base, action: A.OPEN, at: "bad" }] }]) expect(parseFocusUiBatch(value)).toBeNull();
});
