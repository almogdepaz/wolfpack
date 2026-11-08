import { describe, expect, test } from "bun:test";
import { agentContextEnabled, extensionUnavailable, summarizeAgentContext } from "../../src/focus-context.ts";

const item = (id: string, text = `${id} text`) => ({ id, text });
const v3 = {
  schemaVersion: 3,
  goal: "Keep session context useful",
  now: { id: "publisher", text: "Build automatic publication", details: "So the panel follows." },
  needsYou: [item("review", "Review the narrow panel"), ...Array.from({ length: 6 }, (_, i) => item(`q${i}`))],
  needToKnow: [item("a"), item("b"), item("c"), item("d")],
  nextSteps: [{ id: "test", text: "Test resume", owner: "agent" }, { id: "ok", text: "Approve", owner: "user" }],
  history: [{ id: "h", text: "Use structured updates", kind: "decision" }],
  source: { harness: "pi", sessionId: "s", branchId: null, coveredEntryId: null },
  updatedAt: "2026-11-08T10:00:00.000Z",
  freshness: "reviewed",
  activity: { state: "idle", observedAt: "2026-11-08T10:00:00.000Z" },
};

describe("agent-context summary for a session card", () => {
  test("v3: goal, now, every needs-you item, up to 3 next with owner, first 3 need-to-know, freshness", () => {
    const summary = summarizeAgentContext(v3);
    expect(summary).toEqual({
      kind: "v3",
      goal: "Keep session context useful",
      now: "Build automatic publication",
      needsYou: [{ id: "review", text: "Review the narrow panel" }, ...Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, text: `q${i} text` }))],
      nextSteps: [{ text: "Test resume", owner: "agent" }, { text: "Approve", owner: "user" }],
      needToKnow: ["a text", "b text", "c text"],
      freshness: "reviewed",
      updatedAt: "2026-11-08T10:00:00.000Z",
    });
  });
  test("no document is no block; another schema version is one line; malformed parts are dropped, not trusted", () => {
    expect(summarizeAgentContext(null)).toBeNull();
    expect(summarizeAgentContext(undefined)).toBeNull();
    expect(summarizeAgentContext({ schemaVersion: 1, goal: "old", planItems: [] })).toEqual({ kind: "unsupported", version: "1" });
    expect(summarizeAgentContext({ goal: "no version" })).toEqual({ kind: "unsupported", version: "?" });
    expect(summarizeAgentContext({ schemaVersion: "<b>9</b>".repeat(20) })).toEqual({ kind: "unsupported", version: "?" });
    const odd = summarizeAgentContext({ schemaVersion: 3, goal: 7, now: "flat", needsYou: [item("ok"), { text: "no id" }, "x"], nextSteps: [{ text: "t", owner: "root" }, ...Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, text: `n${i}`, owner: "agent" }))], needToKnow: "nope", updatedAt: "garbage", freshness: "fresh" });
    expect(odd).toEqual({ kind: "v3", needsYou: [{ id: "ok", text: "ok text" }], nextSteps: [{ text: "t" }, { text: "n0", owner: "agent" }, { text: "n1", owner: "agent" }], needToKnow: [] });
  });
  test("the catalog lists agent-context installed and enabled, outside safe mode", () => {
    const entry = { extensionId: "agent-context", enabled: true };
    expect(agentContextEnabled({ safeMode: false, installations: [{ extensionId: "changes", enabled: true }, entry] })).toBe(true);
    expect(agentContextEnabled({ safeMode: false, installations: [{ ...entry, enabled: false }] })).toBe(false);
    expect(agentContextEnabled({ safeMode: true, installations: [entry] })).toBe(false);
    expect(agentContextEnabled({ installations: [{ extensionId: "changes", enabled: true }] })).toBe(false);
    expect(agentContextEnabled(null)).toBe(false);
  });
  test("an older peer (no extensions api) or a missing/disabled extension is an answer, not a transport error (N2)", () => {
    const failure = (status: number, data: unknown) => Object.assign(new Error("x"), { status, data });
    expect(extensionUnavailable(failure(404, {}))).toBe(true);
    expect(extensionUnavailable(failure(404, { error: { code: "NOT_INSTALLED", message: "extension is not installed" } }))).toBe(true);
    expect(extensionUnavailable(failure(409, { error: { code: "DISABLED", message: "disabled" } }))).toBe(true);
    expect(extensionUnavailable(failure(503, { error: { code: "STORE_UNAVAILABLE" } }))).toBe(false);
    expect(extensionUnavailable(failure(401, {}))).toBe(false);
    expect(extensionUnavailable(new TypeError("Failed to fetch"))).toBe(false);
    expect(extensionUnavailable(new Error("selected peer is not ready"))).toBe(false);
  });
});
