import { describe, expect, test } from "bun:test";
import { createReplacementPrefillLifecycle } from "../../src/replacement-prefill-lifecycle.ts";

describe("replacement prefill lifecycle", () => {
  test("hides only when reconnect prefill first arrives", () => {
    const lifecycle = createReplacementPrefillLifecycle();
    expect(lifecycle.begin(false)).toEqual({ activateHydration: false });
    expect(lifecycle.onBinaryData()).toEqual({ activateHydration: true });
  });

  test("completes an empty replacement prefill behind hydration without resetting", () => {
    const lifecycle = createReplacementPrefillLifecycle();
    lifecycle.begin(false);
    expect(lifecycle.onPrefillDone()).toEqual({ activateHydration: true });
  });

  test("activates takeover hydration immediately without resetting the emulator", () => {
    const lifecycle = createReplacementPrefillLifecycle();
    expect(lifecycle.begin(true)).toEqual({ activateHydration: true });
    expect(lifecycle.onBinaryData()).toEqual({ activateHydration: false });
  });
});
