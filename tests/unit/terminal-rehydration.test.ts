import { describe, expect, test } from "bun:test";
import {
  TERMINAL_REHYDRATION_ACTION,
  terminalRehydrationAction,
} from "../../src/terminal-rehydration.ts";

describe("terminal rehydration action", () => {
  test("does nothing on the first attach", () => {
    expect(terminalRehydrationAction({
      wasReconnect: false,
      hydrationStarted: false,
      hasAuthoritativePrefill: true,
    })).toBe(TERMINAL_REHYDRATION_ACTION.NONE);
  });

  test("starts visible hydration for a manual retry with authoritative prefill", () => {
    expect(terminalRehydrationAction({
      wasReconnect: false,
      hydrationStarted: true,
      hasAuthoritativePrefill: true,
    })).toBe(TERMINAL_REHYDRATION_ACTION.IMMEDIATE);
  });

  test("retains the prior frame until replacement prefill arrives on reconnect", () => {
    expect(terminalRehydrationAction({
      wasReconnect: true,
      hydrationStarted: true,
      hasAuthoritativePrefill: true,
    })).toBe(TERMINAL_REHYDRATION_ACTION.REPLACEMENT);
  });

  test("reconnects through replacement hydration even without authoritative prefill", () => {
    expect(terminalRehydrationAction({
      wasReconnect: true,
      hydrationStarted: false,
      hasAuthoritativePrefill: false,
    })).toBe(TERMINAL_REHYDRATION_ACTION.REPLACEMENT);
  });
});
