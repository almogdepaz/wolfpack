import { describe, expect, test } from "bun:test";
import {
  terminalLoadLabelFor,
  type TerminalLoadVisualState,
} from "../../public/terminal-loading-ui";

describe("terminal loading UI copy", () => {
  test("uses concise user-facing labels for visible loading states", () => {
    const expected: ReadonlyArray<readonly [TerminalLoadVisualState, string]> = [
      ["prefill-loading", "loading terminal"],
      ["hydrating", "preparing terminal"],
      ["reconnecting", "reconnecting terminal"],
      ["viewer-conflict", "take control to view"],
      ["displaced", "opened elsewhere"],
      ["live", "terminal connected"],
      ["ended", "terminal ended"],
      ["failed", "terminal unavailable"],
    ];

    expect(expected.map(([state, label]) => [state, terminalLoadLabelFor(state), label])).toEqual(
      expected.map(([state, label]) => [state, label, label]),
    );
  });
});
