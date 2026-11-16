import { expect, test } from "bun:test";
import { isFocusAssistantSession, withoutFocusAssistant } from "../../src/focus-session.ts";
const assistant = { name: "assistant", pinned: true, identity: { wolfpackSessionId: "worker-id", projectPath: "/private/assistant" },
  focusAssistant: { name: "assistant" as const, sessionId: "worker-id", folder: "/private/assistant" } };

test("only the owning-home proven pinned incarnation is the focus assistant", () => {
  expect(isFocusAssistantSession(assistant)).toBe(true);
  expect(isFocusAssistantSession({ name: "assistant" })).toBe(false);
  expect(isFocusAssistantSession({ name: "assistant", pinned: true })).toBe(false);
  expect(isFocusAssistantSession({ ...assistant, pinned: false })).toBe(false);
  expect(isFocusAssistantSession({ name: "polybot", pinned: true })).toBe(false);
});

test("render and count sites drop the managed assistant and keep namesakes in order", () => {
  const sessions = [{ name: "wolfpack" }, assistant, { name: "assistant", pinned: true }, { name: "polybot", pinned: false }];
  expect(withoutFocusAssistant(sessions).map(s => s.name)).toEqual(["wolfpack", "assistant", "polybot"]);
  expect(withoutFocusAssistant([])).toEqual([]);
});
