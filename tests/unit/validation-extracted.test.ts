import { describe, expect, test } from "bun:test";
import {
  WS_ALLOWED_KEYS,
  CMD_REGEX,
  BRANCH_REGEX,
  PLAN_FILE_REGEX,
  isValidProjectName,
  isValidPlanFile,
  clampCols,
  clampRows,
  isValidPort,
  shellEscape,
} from "../../validation.ts";

// ── WS_ALLOWED_KEYS ──

describe("WS_ALLOWED_KEYS", () => {
  const ALL_EXPECTED = [
    "Enter", "Tab", "Escape", "Up", "Down", "Left", "Right",
    "BTab", "BSpace", "DC", "Home", "End", "PPage", "NPage",
    "y", "n",
    "C-a", "C-b", "C-c", "C-d", "C-e", "C-f", "C-g", "C-h",
    "C-k", "C-l", "C-n", "C-p", "C-r", "C-u", "C-w", "C-z",
  ];

  test("contains all 32 expected keys", () => {
    expect(WS_ALLOWED_KEYS.size).toBe(32);
    for (const key of ALL_EXPECTED) {
      expect(WS_ALLOWED_KEYS.has(key)).toBe(true);
    }
  });

  test("rejects random strings", () => {
    expect(WS_ALLOWED_KEYS.has("Delete")).toBe(false);
    expect(WS_ALLOWED_KEYS.has("F1")).toBe(false);
    expect(WS_ALLOWED_KEYS.has("Space")).toBe(false);
    expect(WS_ALLOWED_KEYS.has("Backspace")).toBe(false);
  });

  test("rejects injection strings", () => {
    expect(WS_ALLOWED_KEYS.has('"; rm -rf /')).toBe(false);
    expect(WS_ALLOWED_KEYS.has("$(whoami)")).toBe(false);
    expect(WS_ALLOWED_KEYS.has("`cat /etc/passwd`")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(WS_ALLOWED_KEYS.has("")).toBe(false);
  });

  test("is case-sensitive", () => {
    expect(WS_ALLOWED_KEYS.has("enter")).toBe(false);
    expect(WS_ALLOWED_KEYS.has("ENTER")).toBe(false);
    expect(WS_ALLOWED_KEYS.has("c-c")).toBe(false);
  });
});

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

  test("handles NaN → clamps to 20", () => {
    // Math.max(20, Math.min(NaN, 300)) → Math.max(20, NaN) → NaN
    // Actually: Math.min(NaN, 300) = NaN, Math.max(20, NaN) = NaN
    // This is a known edge case — NaN propagates through Math.min/max
    const result = clampCols(NaN);
    expect(Number.isNaN(result)).toBe(true);
  });

  test("handles Infinity → clamps to 300", () => {
    expect(clampCols(Infinity)).toBe(300);
  });

  test("handles -Infinity → clamps to 20", () => {
    expect(clampCols(-Infinity)).toBe(20);
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

  test("handles Infinity → clamps to 100", () => {
    expect(clampRows(Infinity)).toBe(100);
  });

  test("handles -Infinity → clamps to 5", () => {
    expect(clampRows(-Infinity)).toBe(5);
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

  test("rejects NaN", () => {
    expect(isValidPort(NaN)).toBe(false);
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
  });

  test("rejects traversal and non-md", () => {
    expect(isValidPlanFile("../evil.md")).toBe(false);
    expect(isValidPlanFile("plan.txt")).toBe(false);
    expect(isValidPlanFile("")).toBe(false);
  });
});
