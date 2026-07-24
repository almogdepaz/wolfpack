import { describe, test, expect } from "bun:test";
import { validatePeerLoops } from "../../src/server/routes.js";

describe("validatePeerLoops", () => {
  test("returns null when data is not an object", () => {
    expect(validatePeerLoops("peer1", "string")).toBeNull();
    expect(validatePeerLoops("peer1", null)).toBeNull();
    expect(validatePeerLoops("peer1", 42)).toBeNull();
  });

  test("returns null when 'loops' key is missing", () => {
    expect(validatePeerLoops("peer1", { other: [] })).toBeNull();
  });

  test("returns null when 'loops' is not an array", () => {
    expect(validatePeerLoops("peer1", { loops: "not-array" })).toBeNull();
    expect(validatePeerLoops("peer1", { loops: 123 })).toBeNull();
    expect(validatePeerLoops("peer1", { loops: {} })).toBeNull();
  });

  test("returns empty array for empty loops", () => {
    expect(validatePeerLoops("peer1", { loops: [] })).toEqual([]);
  });

  test("skips non-object entries", () => {
    const result = validatePeerLoops("peer1", { loops: ["string", 42, null] });
    expect(result).toEqual([]);
  });

  test("skips entries without project field", () => {
    const result = validatePeerLoops("peer1", { loops: [{ active: true }] });
    expect(result).toEqual([]);
  });

  test("passes valid entries and strips unexpected keys", () => {
    const result = validatePeerLoops("peer1", {
      loops: [
        {
          project: "myapp",
          active: true,
          completed: false,
          iteration: 3,
          totalIterations: 10,
          agent: "claude",
          pid: 1234,
          // unexpected key — should be stripped
          __proto_pollution: "evil",
          injectedField: "<script>alert(1)</script>",
        },
      ],
    });
    expect(result).toHaveLength(1);
    const entry = result![0];
    expect(entry.project).toBe("myapp");
    expect(entry.active).toBe(true);
    expect(entry.completed).toBe(false);
    expect(entry.iteration).toBe(3);
    expect(entry.agent).toBe("claude");
    expect(entry.pid).toBe(1234);
    // stripped keys
    expect("__proto_pollution" in entry).toBe(false);
    expect("injectedField" in entry).toBe(false);
  });

  test("skips fields with wrong types", () => {
    const result = validatePeerLoops("peer1", {
      loops: [
        {
          project: "myapp",
          active: "yes",       // should be boolean, not string
          iteration: "three",  // should be number, not string
          pid: "not-a-number",
        },
      ],
    });
    expect(result).toHaveLength(1);
    const entry = result![0];
    expect(entry.project).toBe("myapp");
    expect("active" in entry).toBe(false);
    expect("iteration" in entry).toBe(false);
    expect("pid" in entry).toBe(false);
  });

  test("handles mix of valid and invalid entries", () => {
    const result = validatePeerLoops("peer1", {
      loops: [
        { project: "good", active: true, iteration: 1 },
        { noProject: true },
        null,
        { project: "also-good", completed: true },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result![0].project).toBe("good");
    expect(result![1].project).toBe("also-good");
  });

  test("validates nested peer status source fields against the shared contract", () => {
    const result = validatePeerLoops("peer1", {
      loops: [
        {
          project: "myapp",
          statusSource: { state: "pwned", authority: "fallback", freshness: "fresh", source: "screen-fallback", label: "bad", stale: false, observedAt: "now" },
          statusSources: [
            { state: "idle", authority: "fallback", freshness: "fresh", source: "screen-fallback", label: "ok", stale: false, observedAt: "now", capabilities: ["semantic-state", "evil"] },
            { state: "idle", authority: "evil", freshness: "fresh", source: "screen-fallback", label: "bad", stale: false, observedAt: "now" },
          ],
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect("statusSource" in result![0]).toBe(false);
    expect(result![0].statusSources).toEqual([
      { state: "idle", authority: "fallback", freshness: "fresh", source: "screen-fallback", label: "ok", stale: false, observedAt: "now", capabilities: ["semantic-state"] },
    ]);
  });

  test("validates all RalphStatus fields when present", () => {
    const fullEntry = {
      project: "test",
      active: true,
      completed: false,
      audit: false,
      cleanup: false,
      cleanupEnabled: true,
      auditFixEnabled: false,
      iteration: 2,
      totalIterations: 5,
      agent: "claude",
      planFile: "PLAN.md",
      progressFile: "progress.txt",
      started: "2026-03-18T10:00:00Z",
      finished: "",
      lastOutput: "working...",
      pid: 9876,
      tasksDone: 3,
      tasksTotal: 10,
    };
    const result = validatePeerLoops("peer1", { loops: [fullEntry] });
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual(fullEntry);
  });
});
