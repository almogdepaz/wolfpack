import { expect, test } from "bun:test";
import { isFocusAssistantSession, withoutFocusAssistant } from "../../src/focus-session.ts";

test("only the pinned session named assistant is the focus assistant", () => {
  expect(isFocusAssistantSession({ name: "assistant", pinned: true })).toBe(true);
  // a user's own session that happens to be called assistant is an ordinary session
  expect(isFocusAssistantSession({ name: "assistant" })).toBe(false);
  expect(isFocusAssistantSession({ name: "assistant", pinned: false })).toBe(false);
  expect(isFocusAssistantSession({ name: "polybot", pinned: true })).toBe(false);
});

test("render and count sites drop the assistant and keep every other session in order", () => {
  const sessions = [{ name: "wolfpack" }, { name: "assistant", pinned: true }, { name: "assistant" }, { name: "polybot", pinned: false }];
  expect(withoutFocusAssistant(sessions).map(s => s.name)).toEqual(["wolfpack", "assistant", "polybot"]);
  expect(withoutFocusAssistant([])).toEqual([]);
});
