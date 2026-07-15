/**
 * Reconnect hydration logic — tests the production shouldRehydrate function
 * that determines whether to clear terminal content and restart hydration
 * when a WebSocket connection opens.
 */
import { describe, expect, test } from "bun:test";
import { shouldRehydrate } from "../../src/reconnect-hydration";

// ── shouldRehydrate decision tests ──

describe("reconnect hydration: shouldRehydrate decision", () => {
  test("first connect with authoritative prefill → false", () => {
    expect(shouldRehydrate(false, false, true)).toBe(false);
  });

  test("first connect without authoritative prefill → false", () => {
    expect(shouldRehydrate(false, false, false)).toBe(false);
  });

  test("auto-reconnect with full prefill → true", () => {
    expect(shouldRehydrate(true, true, true)).toBe(true);
  });

  test("auto-reconnect with viewport prefill → true", () => {
    expect(shouldRehydrate(true, true, true)).toBe(true);
  });

  test("auto-reconnect before hydration started → true", () => {
    expect(shouldRehydrate(true, false, true)).toBe(true);
  });

  test("manual retry with full prefill → true", () => {
    expect(shouldRehydrate(false, true, true)).toBe(true);
  });

  test("manual retry with viewport prefill → true", () => {
    expect(shouldRehydrate(false, true, true)).toBe(true);
  });
});

// ── Stateful prefill lifecycle simulation ──
// These tests verify the expected behavior across the full lifecycle
// of a controller using shouldRehydrate as the decision function.

describe("reconnect hydration: prefill lifecycle across connects", () => {
  test("full lifecycle: desktop auto-reconnect clears and rehydrates each time", () => {
    let hydrationStarted = false;
    const hasAuthoritativePrefill = true;

    expect(shouldRehydrate(false, hydrationStarted, hasAuthoritativePrefill)).toBe(false);
    hydrationStarted = true;

    expect(shouldRehydrate(true, hydrationStarted, hasAuthoritativePrefill)).toBe(true);
    expect(shouldRehydrate(true, hydrationStarted, hasAuthoritativePrefill)).toBe(true);
  });

  test("full lifecycle: grid auto-reconnect clears with viewport prefill", () => {
    let hydrationStarted = false;
    const hasAuthoritativePrefill = true;

    expect(shouldRehydrate(false, hydrationStarted, hasAuthoritativePrefill)).toBe(false);
    hydrationStarted = true;

    expect(shouldRehydrate(true, hydrationStarted, hasAuthoritativePrefill)).toBe(true);
  });

  test("full lifecycle: grid manual retry clears with viewport prefill", () => {
    expect(shouldRehydrate(false, true, true)).toBe(true);
  });
});

// ── Rehydration action simulation ──
// Simulates the sequence of actions taken in createPtyTerminalController's
// onOpen callback based on shouldRehydrate's decision.

describe("reconnect hydration: rehydration actions", () => {
  function simulateRehydration(opts: {
    wasReconnect: boolean;
    hydrationStarted: boolean;
    hasAuthoritativePrefill: boolean;
    hasTerm: boolean;
    hasHydration: boolean;
    hasElement: boolean;
  }) {
    const actions: string[] = [];
    const rehydrate = shouldRehydrate(opts.wasReconnect, opts.hydrationStarted, opts.hasAuthoritativePrefill);
    if (rehydrate && opts.hasTerm) {
      actions.push("term.reset");
      actions.push("counters.reset");
      if (opts.hasHydration) actions.push("hydration.start");
      if (opts.hasElement) {
        actions.push("css.hydrating");
        actions.push("css.remove-hydrated");
      }
    }
    return actions;
  }

  test("auto-reconnect with all components → full rehydration", () => {
    const actions = simulateRehydration({
      wasReconnect: true,
      hydrationStarted: true,
      hasAuthoritativePrefill: true,
      hasTerm: true,
      hasHydration: true,
      hasElement: true,
    });
    expect(actions).toEqual([
      "term.reset",
      "counters.reset",
      "hydration.start",
      "css.hydrating",
      "css.remove-hydrated",
    ]);
  });

  test("first connect → no rehydration actions", () => {
    const actions = simulateRehydration({
      wasReconnect: false,
      hydrationStarted: false,
      hasAuthoritativePrefill: true,
      hasTerm: true,
      hasHydration: true,
      hasElement: true,
    });
    expect(actions).toEqual([]);
  });

  test("reconnect without terminal → no actions (disposed)", () => {
    const actions = simulateRehydration({
      wasReconnect: true,
      hydrationStarted: true,
      hasAuthoritativePrefill: true,
      hasTerm: false,
      hasHydration: true,
      hasElement: true,
    });
    expect(actions).toEqual([]);
  });

  test("reconnect without hydration controller → skip hydration.start", () => {
    const actions = simulateRehydration({
      wasReconnect: true,
      hydrationStarted: true,
      hasAuthoritativePrefill: true,
      hasTerm: true,
      hasHydration: false,
      hasElement: true,
    });
    expect(actions).toEqual([
      "term.reset",
      "counters.reset",
      "css.hydrating",
      "css.remove-hydrated",
    ]);
  });

  test("reconnect without element → skip CSS changes", () => {
    const actions = simulateRehydration({
      wasReconnect: true,
      hydrationStarted: true,
      hasAuthoritativePrefill: true,
      hasTerm: true,
      hasHydration: true,
      hasElement: false,
    });
    expect(actions).toEqual([
      "term.reset",
      "counters.reset",
      "hydration.start",
    ]);
  });

  test("grid manual retry → full replacement hydration", () => {
    const actions = simulateRehydration({
      wasReconnect: false,
      hydrationStarted: true,
      hasAuthoritativePrefill: true,
      hasTerm: true,
      hasHydration: true,
      hasElement: true,
    });
    expect(actions).toEqual([
      "term.reset",
      "counters.reset",
      "hydration.start",
      "css.hydrating",
      "css.remove-hydrated",
    ]);
  });

  test("desktop manual retry → full rehydration", () => {
    const actions = simulateRehydration({
      wasReconnect: false,
      hydrationStarted: true,
      hasAuthoritativePrefill: true,
      hasTerm: true,
      hasHydration: true,
      hasElement: true,
    });
    expect(actions).toEqual([
      "term.reset",
      "counters.reset",
      "hydration.start",
      "css.hydrating",
      "css.remove-hydrated",
    ]);
  });
});
