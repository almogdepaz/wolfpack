import { expect, test } from "bun:test";
import { sessionAttentionCounts, sessionAttentionSummary, sessionStatusDetails } from "../../public/session-attention.ts";
import type { SessionRuntimeUiInput } from "../../src/agent-runtime-ui.ts";

const sourceBacked: SessionRuntimeUiInput["runtimeState"] = {
  state: "needs-input", authority: "manifest", source: "local-manifest", freshness: "fresh", stale: false,
};

test("one attention classifier drives urgent counts without double-counting their unseen updates", () => {
  const counts = sessionAttentionCounts([
    { runtimeState: { ...sourceBacked, unseen: true } },
    { runtimeState: { ...sourceBacked, state: "failed", unseen: true } },
    { runtimeState: { ...sourceBacked, state: "done", unseen: true } },
    { runtimeState: { ...sourceBacked, state: "needs-input", stale: true, unseen: false } },
    { runtimeState: { state: "idle", unseen: true } },
    { triage: "idle" },
    { triage: "running" },
  ]);
  expect(counts).toEqual({ needsInput: 1, failed: 1, updated: 2 });
  expect(sessionAttentionSummary(counts)).toBe("1 need input, 1 failed, 2 updated since review");
});

test("status disclosure distinguishes reported state from accepted runtime state and unavailable times", () => {
  const details = sessionStatusDetails({ runtimeState: {
    ...sourceBacked, stale: true, freshness: "fresh", message: "approve <literal>", observedAt: "not a timestamp",
    changedAt: "2026-10-01T12:00:00Z",
  } });
  expect(details).toContain("Runtime: quiet");
  expect(details).toContain("Reported state: needs-input");
  expect(details).toContain("Reason: approve <literal>");
  expect(details).toContain("Source: local manifest (agent-reported, not verification)");
  expect(details).toContain("Freshness: stale");
  expect(details).toContain("Observed: unavailable");
  expect(details).toContain("Changed: 2026-10-01T12:00:00.000Z");
  expect(details).toContain("does not establish task success or passing checks");
});

test.each(["__proto__", "constructor", "toString", "not-a-source"])("unknown source %s is not a known status source", (source) => {
  expect(sessionStatusDetails({ runtimeState: { source } })).toContain("Source: unavailable");
});
