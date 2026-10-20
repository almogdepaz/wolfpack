import { expect, test } from "bun:test";
import { sessionTier } from "../../src/agent-runtime-ui";
import { AGENT_STATUS_STATES } from "../../src/agent-status-contract";

const tiers = { running: "work", working: "work", audit: "work", cleanup: "work", output: "work", "needs-input": "need", failed: "fail", idle: "idle", done: "idle", stopped: "idle", off: "idle", unknown: "idle" } as const;
for (const state of AGENT_STATUS_STATES) {
  test(`session tier: ${state}`, () => {
    const broker = state === "off" || state === "unknown";
    const fallback = state === "output" || state === "idle";
    expect(sessionTier({ runtimeState: {
      state, freshness: "fresh", stale: false,
      authority: broker ? "broker" : fallback ? "fallback" : "manifest",
      source: broker ? "broker-liveness" : fallback ? "screen-fallback" : "local-manifest",
    } })).toBe(tiers[state]);
  });
}
test("stale semantic state uses the existing runtime fallback", () => {
  expect(sessionTier({ runtimeState: { state: "needs-input", freshness: "stale", stale: true } })).toBe("idle");
});
