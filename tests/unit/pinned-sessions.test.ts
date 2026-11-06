import { expect, test } from "bun:test";
import { conflictingAssistantPins, reconcilePinned, recordPinFailure, type PinHistory } from "../../src/pinned-sessions.ts";
const pins = [{ name: "assistant", cwd: "/tmp/assistant", command: ["pi"], harness: "pi" }];
test("reconciler creates only absent pins, never replaces live sessions", () => {
  expect(reconcilePinned(pins, [], {}, 0)).toEqual([{ name: "assistant", action: "create" }]);
  expect(reconcilePinned(pins, ["assistant"], {}, 0)).toEqual([]);
});
test("assistant directory reservations cover the complete configuration and live unpinned owners only", () => {
  const assistant = pins[0]!;
  const copy = { ...assistant, name: "copy" };
  expect([...conflictingAssistantPins([assistant, copy], [])].sort()).toEqual(["assistant", "copy"]);
  expect([...conflictingAssistantPins([copy], [assistant])]).toEqual(["copy"]);
  expect([...conflictingAssistantPins([assistant], [copy])]).toEqual(["assistant"]);
  expect([...conflictingAssistantPins([copy, { ...copy, name: "other" }], [])]).toEqual([]);
});
test("failure backoff caps then fails; stable runtime clears history in orchestrator", () => {
  const history: Record<string, PinHistory> = {};
  for (let n = 0; n < 5; n++) {
    history.assistant = recordPinFailure(history.assistant, n * 100000);
    expect(reconcilePinned(pins, [], history, n * 100000)[0]?.action).toBe(n === 4 ? "failed" : "wait");
  }
  expect(reconcilePinned(pins, [], history, 99999999)[0]?.action).toBe("failed");
  expect(reconcilePinned(pins, ["assistant"], history, 99999999)).toEqual([]);
});
