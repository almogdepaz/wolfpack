import { expect, test } from "bun:test";
import { distribution, dueSlots, errorCode } from "../../scripts/relay-perf/measurement.ts";

test("nearest-rank quantiles retain small-sample tails and mark empty series unknown", () => {
  expect(distribution([])).toEqual({ count: 0, p50: null, p95: null, p99: null, max: null });
  expect(distribution([4, 1, 3, 2])).toEqual({ count: 4, p50: 2, p95: 4, p99: 4, max: 4 });
  expect(() => distribution([NaN])).toThrow();
  expect(() => distribution([-1])).toThrow();
});
test("dispatch delay does not erase offered samples or slide the schedule", () => {
  expect(dueSlots(1000, 1250, 100, 0, 4)).toEqual([
    { scheduled: 1000, dispatched: 1250, lateness: 250 },
    { scheduled: 1100, dispatched: 1250, lateness: 150 },
    { scheduled: 1200, dispatched: 1250, lateness: 50 },
  ]);
  expect(dueSlots(1000, 1250, 100, 3, 4)).toEqual([]);
  expect(dueSlots(1000, 5000, 100, 3, 4)).toHaveLength(1);
  expect(() => dueSlots(0, 0, 0, 0, 1)).toThrow();
});
test("failure accounting uses typed code rather than parsing diagnostic prose", () => {
  expect(errorCode({ code: "RELAY_CAPACITY", message: "arbitrary diagnostic" })).toBe("RELAY_CAPACITY");
  expect(errorCode(new TypeError("PEER_UNREACHABLE"))).toBe("TypeError");
});
