import { expect, test } from "bun:test";
import { reconcilePinned, recordPinFailure, type PinHistory } from "../../src/pinned-sessions.ts";
const pins = [{ name: "assistant", cwd: "/tmp/assistant", command: ["pi"], harness: "pi" }];
test("reconciler creates only absent pins, never replaces live sessions", () => {
  expect(reconcilePinned(pins, [], {}, 0)).toEqual([{ name: "assistant", action: "create" }]);
  expect(reconcilePinned(pins, ["assistant"], {}, 0)).toEqual([]);
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
