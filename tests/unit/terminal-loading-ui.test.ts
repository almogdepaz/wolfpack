import { describe, expect, test } from "bun:test";
import {
  setTerminalLoadLabel,
  terminalLoadLabelFor,
  type TerminalLoadVisualState,
} from "../../public/terminal-loading-ui";

describe("terminal loading UI copy", () => {
  test("uses concise user-facing labels for visible loading states", () => {
    const expected: ReadonlyArray<readonly [TerminalLoadVisualState, string]> = [
      ["prefill-loading", "loading terminal"],
      ["hydrating", "preparing terminal"],
      ["reconnecting", "reconnecting terminal"],
      ["viewer-conflict", "session active elsewhere"],
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

describe("setTerminalLoadLabel", () => {
  test("overrides the visible label without changing the load state", () => {
    const inline = { dataset: {} as Record<string, string> };
    const attributes: Record<string, string> = {};
    const el = {
      dataset: { terminalLoadState: "reconnecting", terminalLoadLabel: "reconnecting terminal" } as Record<string, string>,
      setAttribute: (name: string, value: string) => { attributes[name] = value; },
      querySelector: () => inline,
    };
    setTerminalLoadLabel(el as unknown as HTMLElement, "sgt unreachable (attempt 2, retry in 3s)");
    expect(el.dataset).toEqual({ terminalLoadState: "reconnecting", terminalLoadLabel: "sgt unreachable (attempt 2, retry in 3s)" });
    expect(attributes["aria-label"]).toBe("sgt unreachable (attempt 2, retry in 3s)");
    expect(inline.dataset.terminalLoadLabel).toBe("sgt unreachable (attempt 2, retry in 3s)");
  });
});
