import { describe, expect, test } from "bun:test";
import {
  TERMINAL_REHYDRATION_ACTION,
  createTerminalConnectionLifecycle,
} from "../../src/terminal-connection-lifecycle.ts";

describe("terminal connection lifecycle", () => {
  test("coordinates a reconnect replacement prefill through its first byte", () => {
    const lifecycle = createTerminalConnectionLifecycle();

    expect(lifecycle.onSocketOpen({
      wasReconnect: true,
      hydrationStarted: true,
      hasAuthoritativePrefill: true,
      hasPendingResizeScrollRestore: false,
    })).toEqual({
      resetTerminal: false,
      rehydrationAction: TERMINAL_REHYDRATION_ACTION.REPLACEMENT,
      resetScrollLock: true,
    });
    expect(lifecycle.beginReplacementPrefill(false)).toEqual({
      activateHydration: false,
      resetTerminal: false,
    });
    expect(lifecycle.onBinaryData()).toEqual({ activateHydration: true, resetTerminal: true });
  });

  test("keeps viewport replacement bytes and activates hydration at prefill completion", () => {
    const lifecycle = createTerminalConnectionLifecycle();
    lifecycle.beginReplacementPrefill(false);

    lifecycle.onReplacePrefill();
    expect(lifecycle.onPrefillDone()).toEqual({
      activateHydration: true,
      resetTerminal: false,
    });
  });

  test("invalidates write completions from a replaced connection", () => {
    const lifecycle = createTerminalConnectionLifecycle();
    const write = lifecycle.beginHydrationWrite();

    lifecycle.beginConnection();

    expect(lifecycle.finishHydrationWrite(write)).toBe(false);
    expect(lifecycle.pendingHydrationWrites).toBe(0);
  });
});
