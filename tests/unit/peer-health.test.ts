import { test, expect } from "bun:test";
import {
  recordFailure,
  recordSuccess,
  fetchTimeoutMs,
  FAILING_TIMEOUT_MS,
  HEALTHY_TIMEOUT_MS,
  FAILURE_THRESHOLD,
} from "../../src/peer-health.ts";

test("healthy peer uses long timeout", () => {
  expect(fetchTimeoutMs({}, "https://peer.ts.net")).toBe(HEALTHY_TIMEOUT_MS);
});

test("peer under threshold still uses long timeout", () => {
  let s = {};
  for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) s = recordFailure(s, "peer");
  expect(fetchTimeoutMs(s, "peer")).toBe(HEALTHY_TIMEOUT_MS);
});

test("peer at or above threshold uses short timeout", () => {
  let s = {};
  for (let i = 0; i < FAILURE_THRESHOLD; i++) s = recordFailure(s, "peer");
  expect(fetchTimeoutMs(s, "peer")).toBe(FAILING_TIMEOUT_MS);
});

test("recordSuccess clears failure count", () => {
  let s = {};
  for (let i = 0; i < FAILURE_THRESHOLD + 5; i++) s = recordFailure(s, "peer");
  expect(fetchTimeoutMs(s, "peer")).toBe(FAILING_TIMEOUT_MS);
  s = recordSuccess(s, "peer");
  expect(fetchTimeoutMs(s, "peer")).toBe(HEALTHY_TIMEOUT_MS);
});

test("recordSuccess on unknown peer is a no-op", () => {
  const s = {};
  expect(recordSuccess(s, "unknown")).toBe(s);
});

test("failures are tracked per peer independently", () => {
  let s = {};
  for (let i = 0; i < FAILURE_THRESHOLD; i++) s = recordFailure(s, "slow");
  expect(fetchTimeoutMs(s, "slow")).toBe(FAILING_TIMEOUT_MS);
  expect(fetchTimeoutMs(s, "fast")).toBe(HEALTHY_TIMEOUT_MS);
});

test("recordFailure returns a new object (immutable update)", () => {
  const s = {};
  const s2 = recordFailure(s, "peer");
  expect(s2).not.toBe(s);
  expect(s).toEqual({});
});
