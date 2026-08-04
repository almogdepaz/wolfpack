import { describe, expect, test } from "bun:test";
import {
  TERMINAL_REHYDRATION_ACTION,
  createTerminalConnectionLifecycle,
} from "../../src/terminal-connection-lifecycle.ts";

describe("terminal connection lifecycle", () => {
  test("does not reset a fresh terminal before its authoritative snapshot", () => {
    const lifecycle = createTerminalConnectionLifecycle();

    expect(lifecycle.onSocketOpen({
      wasReconnect: false,
      hydrationStarted: false,
      hasAuthoritativePrefill: true,
      hasPendingResizeScrollRestore: false,
    })).toEqual({
      rehydrationAction: TERMINAL_REHYDRATION_ACTION.NONE,
      resetScrollLock: true,
    });
  });

  test("coordinates a reconnect replacement prefill through its first byte", () => {
    const lifecycle = createTerminalConnectionLifecycle();

    expect(lifecycle.onSocketOpen({
      wasReconnect: true,
      hydrationStarted: true,
      hasAuthoritativePrefill: true,
      hasPendingResizeScrollRestore: false,
    })).toEqual({
      rehydrationAction: TERMINAL_REHYDRATION_ACTION.REPLACEMENT,
      resetScrollLock: true,
    });
    expect(lifecycle.beginReplacementPrefill(false)).toEqual({
      activateHydration: false,
    });
    expect(lifecycle.onBinaryData()).toEqual({ activateHydration: true });
  });

  test("keeps viewport replacement bytes and activates hydration at prefill completion", () => {
    const lifecycle = createTerminalConnectionLifecycle();
    lifecycle.beginReplacementPrefill(false);

    lifecycle.onReplacePrefill();
    expect(lifecycle.onPrefillDone()).toEqual({
      activateHydration: true,
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
