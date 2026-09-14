import { expect, test } from "bun:test";
import { createSuspensionInclusiveElapsedNow } from "../../src/task-relay/suspension-inclusive-clock.ts";
import type { SuspensionClockBindings } from "../../src/task-relay/suspension-inclusive-clock.ts";

function bindings(overrides: Partial<SuspensionClockBindings> = {}): SuspensionClockBindings {
  return {
    platform: "darwin",
    macTimebaseInfo: () => ({ status: 0, numerator: 125, denominator: 3 }),
    macContinuousTime: () => 24_000_000n,
    linuxBootTime: () => ({ status: 0, seconds: 5n, nanoseconds: 123_000_000n }),
    ...overrides,
  };
}

test("selects the platform-native suspension clock and converts its units", () => {
  expect(createSuspensionInclusiveElapsedNow(bindings())()).toBe(1_000);
  expect(createSuspensionInclusiveElapsedNow(bindings({ platform: "linux" }))()).toBe(5_123);
});

test("darwin 1:1 conversion supports valid ticks beyond Number.MAX_SAFE_INTEGER", () => {
  const elapsedNow = createSuspensionInclusiveElapsedNow(bindings({
    macTimebaseInfo: () => ({ status: 0, numerator: 1, denominator: 1 }),
    macContinuousTime: () => 9_007_199_254_741_123n,
  }));
  expect(elapsedNow()).toBeCloseTo(9_007_199_254.741123, 5);
});

test("rejects unavailable platforms and invalid native status or values", () => {
  expect(() => createSuspensionInclusiveElapsedNow(bindings({ platform: "freebsd" }))).toThrow();
  expect(() => createSuspensionInclusiveElapsedNow(bindings({ macTimebaseInfo: () => ({ status: 1, numerator: 1, denominator: 1 }) }))).toThrow();
  expect(() => createSuspensionInclusiveElapsedNow(bindings({ macContinuousTime: () => -1n }))()).toThrow();
  expect(() => createSuspensionInclusiveElapsedNow(bindings({ platform: "linux", linuxBootTime: () => ({ status: 1, seconds: 0n, nanoseconds: 0n }) }))()).toThrow();
  expect(() => createSuspensionInclusiveElapsedNow(bindings({ platform: "linux", linuxBootTime: () => ({ status: 0, seconds: 0n, nanoseconds: 1_000_000_000n }) }))()).toThrow();
});

test("native clock returns finite advancing elapsed time on the current host", async () => {
  const elapsedNow = createSuspensionInclusiveElapsedNow();
  const before = elapsedNow();
  await Bun.sleep(5);
  const after = elapsedNow();
  expect(Number.isFinite(before)).toBe(true);
  expect(after).toBeGreaterThan(before);
});
