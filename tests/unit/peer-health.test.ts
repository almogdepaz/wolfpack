import { test, expect } from "bun:test";
import { fetchWithTimeout } from "../../public/fetch-timeout.ts";
import {
  recordFailure,
  recordSuccess,
  fetchTimeoutMs,
  FAILING_TIMEOUT_MS,
  HEALTHY_TIMEOUT_MS,
  FAILURE_THRESHOLD,
} from "../../src/peer-health.ts";

test("repeated failures periodically regain the full recovery budget", () => {
  let state = {};
  const budgets: number[] = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    budgets.push(fetchTimeoutMs(state, "slow-but-recovered"));
    state = recordFailure(state, "slow-but-recovered");
  }
  // A peer needing 3s must not be trapped forever by the 1.5s fast failure budget.
  expect(budgets.slice(FAILURE_THRESHOLD)).toContain(HEALTHY_TIMEOUT_MS);
  expect(budgets.slice(FAILURE_THRESHOLD)).toContain(FAILING_TIMEOUT_MS);
});

test("a slow recovered peer eventually completes a real deadline-bounded read", async () => {
  let state = recordFailure(recordFailure({}, "slow"), "slow");
  let recovered = false;
  for (let attempt = 0; attempt < 4 && !recovered; attempt++) {
    try {
      const response = await fetchWithTimeout("https://slow.test/api/sessions", {}, fetchTimeoutMs(state, "slow"), (_input, init) => new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response("healthy")), 2_000);
        init!.signal!.addEventListener("abort", () => { clearTimeout(timer); reject(init!.signal!.reason); }, { once: true });
      }));
      recovered = response.ok;
      state = recordSuccess(state, "slow");
    } catch { state = recordFailure(state, "slow"); }
  }
  expect(recovered).toBe(true);
  expect(fetchTimeoutMs(state, "slow")).toBe(HEALTHY_TIMEOUT_MS);
}, 10_000);

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
