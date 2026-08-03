/**
 * Reconnect hydration decision coverage.
 */
import { describe, expect, test } from "bun:test";
import { shouldRehydrate } from "../../src/reconnect-hydration";

describe("reconnect hydration", () => {
  test("keeps the first unauthoritative attach in place", () => {
    expect(shouldRehydrate(false, false, false)).toBe(false);
  });

  test("keeps the first authoritative attach in place", () => {
    expect(shouldRehydrate(false, false, true)).toBe(false);
  });

  test("rehydrates every automatic reconnect", () => {
    expect(shouldRehydrate(true, false, false)).toBe(true);
    expect(shouldRehydrate(true, true, true)).toBe(true);
  });

  test("rehydrates a manual retry only after initial hydration with authoritative prefill", () => {
    expect(shouldRehydrate(false, true, true)).toBe(true);
    expect(shouldRehydrate(false, true, false)).toBe(false);
  });
});
