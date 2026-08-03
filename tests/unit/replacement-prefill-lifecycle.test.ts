import { describe, expect, test } from "bun:test";
import { createReplacementPrefillLifecycle } from "../../src/replacement-prefill-lifecycle.ts";

describe("replacement prefill lifecycle", () => {
  test("hides only when reconnect prefill first arrives", () => {
    const lifecycle = createReplacementPrefillLifecycle();
    expect(lifecycle.begin(false)).toEqual({ activateHydration: false });
    expect(lifecycle.onBinaryData()).toEqual({ activateHydration: true, resetTerminal: true });
  });

  test("clears an empty replacement prefill behind hydration", () => {
    const lifecycle = createReplacementPrefillLifecycle();
    lifecycle.begin(false);
    expect(lifecycle.onPrefillDone()).toEqual({ activateHydration: true, resetTerminal: true });
  });

  test("activates takeover hydration immediately but still resets at first byte", () => {
    const lifecycle = createReplacementPrefillLifecycle();
    expect(lifecycle.begin(true)).toEqual({ activateHydration: true });
    expect(lifecycle.onBinaryData()).toEqual({ activateHydration: false, resetTerminal: true });
  });
});
