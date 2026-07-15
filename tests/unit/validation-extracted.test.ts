import { describe, expect, test } from "bun:test";
import {
  CMD_REGEX,
  BRANCH_REGEX,
  PLAN_FILE_REGEX,
  isValidProjectName,
  isValidPlanFile,
  clampCols,
  clampRows,
  isValidPort,
  shellEscape,
  expandBudget,
} from "../../src/validation.ts";

// ── clampCols ──

describe("clampCols", () => {
  test("passes through value within range", () => {
    expect(clampCols(80)).toBe(80);
    expect(clampCols(120)).toBe(120);
  });

  test("clamps to minimum 20", () => {
    expect(clampCols(1)).toBe(20);
    expect(clampCols(0)).toBe(20);
    expect(clampCols(-100)).toBe(20);
    expect(clampCols(19)).toBe(20);
  });

  test("boundary: exactly 20", () => {
    expect(clampCols(20)).toBe(20);
  });

  test("boundary: exactly 300", () => {
    expect(clampCols(300)).toBe(300);
  });

  test("clamps to maximum 300", () => {
    expect(clampCols(301)).toBe(300);
    expect(clampCols(9999)).toBe(300);
    expect(clampCols(1000000)).toBe(300);
  });

  test("handles NaN → returns default 80", () => {
    expect(clampCols(NaN)).toBe(80);
  });

  test("handles Infinity → returns default 80", () => {
    expect(clampCols(Infinity)).toBe(80);
  });

  test("handles -Infinity → returns default 80", () => {
    expect(clampCols(-Infinity)).toBe(80);
  });
});

// ── clampRows ──

describe("clampRows", () => {
  test("passes through value within range", () => {
    expect(clampRows(24)).toBe(24);
    expect(clampRows(50)).toBe(50);
  });

  test("clamps to minimum 5", () => {
    expect(clampRows(1)).toBe(5);
    expect(clampRows(0)).toBe(5);
    expect(clampRows(-10)).toBe(5);
    expect(clampRows(4)).toBe(5);
  });

  test("boundary: exactly 5", () => {
    expect(clampRows(5)).toBe(5);
  });

  test("boundary: exactly 100", () => {
    expect(clampRows(100)).toBe(100);
  });

  test("clamps to maximum 100", () => {
    expect(clampRows(101)).toBe(100);
    expect(clampRows(9999)).toBe(100);
  });

  test("handles Infinity → returns default 24", () => {
    expect(clampRows(Infinity)).toBe(24);
  });

  test("handles -Infinity → returns default 24", () => {
    expect(clampRows(-Infinity)).toBe(24);
  });
});

// ── isValidPort ──

describe("isValidPort", () => {
  test("accepts valid ports", () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(80)).toBe(true);
    expect(isValidPort(443)).toBe(true);
    expect(isValidPort(8080)).toBe(true);
    expect(isValidPort(18790)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
  });

  test("rejects 0", () => {
    expect(isValidPort(0)).toBe(false);
  });

  test("rejects negative numbers", () => {
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort(-100)).toBe(false);
  });

  test("rejects > 65535", () => {
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(100000)).toBe(false);
  });

  test("rejects NaN and fractional ports", () => {
    expect(isValidPort(NaN)).toBe(false);
    expect(isValidPort(18790.5)).toBe(false);
  });

  test("rejects Infinity", () => {
    expect(isValidPort(Infinity)).toBe(false);
    expect(isValidPort(-Infinity)).toBe(false);
  });
});

// ── isValidProjectName (from validation.ts — real import) ──

describe("isValidProjectName (imported)", () => {
  test("accepts valid names", () => {
    expect(isValidProjectName("myproject")).toBe(true);
    expect(isValidProjectName("my-project_v2.0")).toBe(true);
    expect(isValidProjectName(".hidden")).toBe(true);
  });

  test("rejects traversal and specials", () => {
    expect(isValidProjectName("..")).toBe(false);
    expect(isValidProjectName(".")).toBe(false);
    expect(isValidProjectName("foo/bar")).toBe(false);
    expect(isValidProjectName("")).toBe(false);
    expect(isValidProjectName("$(whoami)")).toBe(false);
  });
});

// ── shellEscape (from validation.ts — real import) ──

describe("shellEscape (imported)", () => {
  test("wraps in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  test("escapes single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  test("empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  test("handles shell metacharacters safely", () => {
    const result = shellEscape("rm -rf /; echo pwned");
    expect(result).toBe("'rm -rf /; echo pwned'");
  });

  test("handles dollar signs and backticks", () => {
    expect(shellEscape("$HOME `whoami`")).toBe("'$HOME `whoami`'");
  });
});

// ── Regex exports match serve.ts inline patterns ──

describe("CMD_REGEX", () => {
  test("accepts valid commands", () => {
    expect(CMD_REGEX.test("claude --dangerously-skip-permissions")).toBe(true);
    expect(CMD_REGEX.test("npm run build")).toBe(true);
  });

  test("rejects shell injection", () => {
    expect(CMD_REGEX.test("cmd; rm -rf /")).toBe(false);
    expect(CMD_REGEX.test("cmd && evil")).toBe(false);
    expect(CMD_REGEX.test("`whoami`")).toBe(false);
  });
});

describe("BRANCH_REGEX", () => {
  test("accepts valid branches", () => {
    expect(BRANCH_REGEX.test("feature/login")).toBe(true);
    expect(BRANCH_REGEX.test("fix-bug-123")).toBe(true);
  });

  test("rejects shell injection", () => {
    expect(BRANCH_REGEX.test("main;rm -rf /")).toBe(false);
  });
});

describe("isValidPlanFile", () => {
  test("accepts valid plan files", () => {
    expect(isValidPlanFile("PLAN.md")).toBe(true);
    expect(isValidPlanFile("my plan.md")).toBe(true);
    expect(isValidPlanFile(".plans/adoption.md")).toBe(true);
  });

  test("rejects traversal and non-md", () => {
    expect(isValidPlanFile("../evil.md")).toBe(false);
    expect(isValidPlanFile(".plans/../evil.md")).toBe(false);
    expect(isValidPlanFile("plans/adoption.md")).toBe(false);
    expect(isValidPlanFile(".plans/nested/adoption.md")).toBe(false);
    expect(isValidPlanFile("plan.txt")).toBe(false);
    expect(isValidPlanFile("")).toBe(false);
  });
});

// ── expandBudget (ISS-12) ──

describe("expandBudget", () => {
  test("adds subtask count within ceiling", () => {
    expect(expandBudget(5, 3, 20)).toBe(8);
  });

  test("caps at ceiling", () => {
    expect(expandBudget(18, 5, 20)).toBe(20);
  });

  test("no-ops when already at ceiling", () => {
    expect(expandBudget(20, 5, 20)).toBe(20);
  });

  test("clamps negative subtaskCount to 0 (ISS-12)", () => {
    expect(expandBudget(10, -3, 20)).toBe(10);
    expect(expandBudget(10, -100, 20)).toBe(10);
  });

  test("zero subtaskCount is a no-op", () => {
    expect(expandBudget(10, 0, 20)).toBe(10);
  });
});
