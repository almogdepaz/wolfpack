import { describe, expect, test } from "bun:test";
import {
  TERMINAL_REHYDRATION_ACTION,
  createTerminalConnectionLifecycle,
} from "../../src/terminal-connection-lifecycle.ts";

const SOCKET_OPEN_CASES = [
  ["first attach with authoritative prefill", false, false, true, TERMINAL_REHYDRATION_ACTION.NONE],
  ["first attach without authoritative prefill", false, false, false, TERMINAL_REHYDRATION_ACTION.NONE],
  ["manual retry with authoritative prefill", false, true, true, TERMINAL_REHYDRATION_ACTION.IMMEDIATE],
  ["manual retry without authoritative prefill", false, true, false, TERMINAL_REHYDRATION_ACTION.NONE],
  ["reconnect with authoritative prefill", true, true, true, TERMINAL_REHYDRATION_ACTION.REPLACEMENT],
  ["reconnect without authoritative prefill", true, false, false, TERMINAL_REHYDRATION_ACTION.REPLACEMENT],
] as const;

describe("terminal connection lifecycle", () => {
  test.each(SOCKET_OPEN_CASES)(
    "selects the expected rehydration action for %s",
    (_label, wasReconnect, hydrationStarted, hasAuthoritativePrefill, rehydrationAction) => {
      const lifecycle = createTerminalConnectionLifecycle();

      expect(lifecycle.onSocketOpen({
        wasReconnect,
        hydrationStarted,
        hasAuthoritativePrefill,
        hasPendingResizeScrollRestore: false,
      })).toEqual({ rehydrationAction, resetScrollLock: true });
    },
  );

  test("preserves scroll lock while resize scroll restoration is pending", () => {
    const lifecycle = createTerminalConnectionLifecycle();

    expect(lifecycle.onSocketOpen({
      wasReconnect: false,
      hydrationStarted: false,
      hasAuthoritativePrefill: true,
      hasPendingResizeScrollRestore: true,
    })).toEqual({
      rehydrationAction: TERMINAL_REHYDRATION_ACTION.NONE,
      resetScrollLock: false,
    });
  });

  test("tracks active-epoch writes and keeps the pending count at zero", () => {
    const lifecycle = createTerminalConnectionLifecycle();
    const first = lifecycle.beginHydrationWrite();
    const second = lifecycle.beginHydrationWrite();

    expect(lifecycle.pendingHydrationWrites).toBe(2);
    expect(lifecycle.finishHydrationWrite(first)).toBe(true);
    expect(lifecycle.pendingHydrationWrites).toBe(1);
    expect(lifecycle.finishHydrationWrite(second)).toBe(true);
    expect(lifecycle.pendingHydrationWrites).toBe(0);
    expect(lifecycle.finishHydrationWrite(second)).toBe(true);
    expect(lifecycle.pendingHydrationWrites).toBe(0);
  });

  test("invalidates write completions from a replaced connection", () => {
    const lifecycle = createTerminalConnectionLifecycle();
    const staleWrite = lifecycle.beginHydrationWrite();

    lifecycle.beginConnection();

    expect(lifecycle.finishHydrationWrite(staleWrite)).toBe(false);
    expect(lifecycle.pendingHydrationWrites).toBe(0);
  });

  test("clears pending writes only when socket open starts rehydration", () => {
    const lifecycle = createTerminalConnectionLifecycle();
    lifecycle.beginHydrationWrite();

    lifecycle.onSocketOpen({
      wasReconnect: false,
      hydrationStarted: false,
      hasAuthoritativePrefill: true,
      hasPendingResizeScrollRestore: false,
    });
    expect(lifecycle.pendingHydrationWrites).toBe(1);

    lifecycle.onSocketOpen({
      wasReconnect: false,
      hydrationStarted: true,
      hasAuthoritativePrefill: true,
      hasPendingResizeScrollRestore: false,
    });
    expect(lifecycle.pendingHydrationWrites).toBe(0);
  });

  test("activates a visible replacement exactly once on its first binary data", () => {
    const lifecycle = createTerminalConnectionLifecycle();
    lifecycle.beginHydrationWrite();

    expect(lifecycle.beginReplacementPrefill(false)).toEqual({ activateHydration: false });
    expect(lifecycle.pendingHydrationWrites).toBe(0);
    expect(lifecycle.onBinaryData()).toEqual({ activateHydration: true });
    expect(lifecycle.onPrefillDone()).toEqual({ activateHydration: false });
    expect(lifecycle.onBinaryData()).toEqual({ activateHydration: false });
  });

  test("activates an empty replacement exactly once at prefill completion", () => {
    const lifecycle = createTerminalConnectionLifecycle();

    expect(lifecycle.beginReplacementPrefill(false)).toEqual({ activateHydration: false });
    expect(lifecycle.onPrefillDone()).toEqual({ activateHydration: true });
    expect(lifecycle.onBinaryData()).toEqual({ activateHydration: false });
  });

  test("replace-prefill clears writes without cancelling pending replacement", () => {
    const lifecycle = createTerminalConnectionLifecycle();
    lifecycle.beginReplacementPrefill(false);
    lifecycle.beginHydrationWrite();

    lifecycle.onReplacePrefill();

    expect(lifecycle.pendingHydrationWrites).toBe(0);
    expect(lifecycle.onPrefillDone()).toEqual({ activateHydration: true });
  });

  test("control takeover activates immediately with no later replacement activation", () => {
    const lifecycle = createTerminalConnectionLifecycle();
    lifecycle.beginReplacementPrefill(false);
    lifecycle.beginHydrationWrite();

    expect(lifecycle.onControlGranted()).toEqual({ activateHydration: true });
    expect(lifecycle.pendingHydrationWrites).toBe(0);
    expect(lifecycle.onBinaryData()).toEqual({ activateHydration: false });
    expect(lifecycle.onPrefillDone()).toEqual({ activateHydration: false });
  });

  test("reset clears writes and replacement state without advancing the epoch", () => {
    const lifecycle = createTerminalConnectionLifecycle();
    lifecycle.beginReplacementPrefill(false);
    const activeWrite = lifecycle.beginHydrationWrite();

    lifecycle.reset();

    expect(lifecycle.pendingHydrationWrites).toBe(0);
    expect(lifecycle.finishHydrationWrite(activeWrite)).toBe(true);
    expect(lifecycle.onBinaryData()).toEqual({ activateHydration: false });
    expect(lifecycle.onPrefillDone()).toEqual({ activateHydration: false });
  });
});
