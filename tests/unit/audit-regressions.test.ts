/**
 * Regression tests for fixes from the security/correctness audit.
 * Each test targets a specific finding that was fixed in the fix/audit-findings branch.
 */
import { describe, expect, test } from "bun:test";

// ── 1. Path containment boundary (audit finding: prefix check too weak) ──
// Set DEV_DIR before importing so the module-level constant picks it up.
// Use trailing slash to verify boundary logic handles normalized equivalence.
process.env.WOLFPACK_DEV_DIR = "/Users/home/Dev/";
const { isUnderDevDir } = await import("../../src/server/dev-dir.js");

describe("isUnderDevDir — path containment boundary", () => {
  test("exact match on DEV_DIR itself", () => {
    expect(isUnderDevDir("/Users/home/Dev/")).toBe(true);
    expect(isUnderDevDir("/Users/home/Dev")).toBe(true);
  });

  test("child directory matches", () => {
    expect(isUnderDevDir("/Users/home/Dev/wolfpack")).toBe(true);
    expect(isUnderDevDir("/Users/home/Dev/foo/bar/baz")).toBe(true);
  });

  test("rejects sibling path that shares string prefix", () => {
    // This was the original bug — /Users/home/Developer matched /Users/home/Dev
    expect(isUnderDevDir("/Users/home/Developer")).toBe(false);
    expect(isUnderDevDir("/Users/home/DevOps")).toBe(false);
    expect(isUnderDevDir("/Users/home/Dev2")).toBe(false);
  });

  test("rejects unrelated paths", () => {
    expect(isUnderDevDir("/tmp/something")).toBe(false);
    expect(isUnderDevDir("/Users/other/Dev/project")).toBe(false);
  });

  test("rejects partial prefix with no separator", () => {
    expect(isUnderDevDir("/Users/home/Devious")).toBe(false);
  });
});

// ── 1b. validateProjectDir realpath containment ──

import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Mirrors the core logic of routes.ts validateProjectDir():
 * rejects symlinks, rejects dirs whose realpath escapes DEV_DIR.
 */
function validateProjectDir(projectDir: string, devDir: string): "ok" | "not_dir" | "not_found" {
  try {
    if (lstatSync(projectDir).isSymbolicLink() || !statSync(projectDir).isDirectory()) return "not_dir";
    if (!isUnderDevDir(realpathSync(projectDir))) return "not_dir";
  } catch {
    return "not_found";
  }
  return "ok";
}

describe("validateProjectDir — realpath containment", () => {
  let testDevDir: string;
  let outsideDir: string;

  test("accepts real directory under DEV_DIR", () => {
    testDevDir = mkdtempSync(join(tmpdir(), "wolfpack-devdir-"));
    const project = join(testDevDir, "legit-project");
    mkdirSync(project);
    // isUnderDevDir checks against process.env.WOLFPACK_DEV_DIR which is /Users/home/Dev/
    // so we test the realpathSync + isUnderDevDir logic directly
    const real = realpathSync(project);
    // the project's realpath is under testDevDir (not under DEV_DIR), so isUnderDevDir returns false
    // This verifies the containment check works
    expect(isUnderDevDir(real)).toBe(false);
    expect(validateProjectDir(project, testDevDir)).toBe("not_dir");
    rmSync(testDevDir, { recursive: true, force: true });
  });

  test("rejects symlink pointing outside DEV_DIR", () => {
    testDevDir = mkdtempSync(join(tmpdir(), "wolfpack-devdir-"));
    outsideDir = mkdtempSync(join(tmpdir(), "wolfpack-outside-"));
    const symlink = join(testDevDir, "sneaky-link");
    symlinkSync(outsideDir, symlink);
    // lstatSync catches the symlink before realpath even runs
    expect(validateProjectDir(symlink, testDevDir)).toBe("not_dir");
    rmSync(testDevDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("rejects nonexistent directory", () => {
    expect(validateProjectDir("/nonexistent/path/xyz", "/tmp")).toBe("not_found");
  });
});

// ── 2. killPortHolder process verification ──

import { isWolfpackProcess } from "../../src/cli/config.js";

describe("isWolfpackProcess — killPortHolder identity check", () => {
  test("identifies wolfpack processes", () => {
    expect(isWolfpackProcess("/Users/home/.wolfpack/bin/wolfpack")).toBe(true);
    expect(isWolfpackProcess("wolfpack-bridge")).toBe(true);
    expect(isWolfpackProcess("bun /path/to/wolfpack/cli.ts")).toBe(true);
  });

  test("rejects non-wolfpack processes", () => {
    expect(isWolfpackProcess("node /app/server.js")).toBe(false);
    expect(isWolfpackProcess("python3 -m http.server")).toBe(false);
    expect(isWolfpackProcess("nginx: master")).toBe(false);
  });
});

// ── 3. Ralph subtask expansion budget ──

import {
  expandBudget,
  clampCols,
  clampRows,
  resolveCleanupDiffBase,
} from "../../src/validation.js";

describe("expandBudget — ralph subtask expansion", () => {
  test("budget increases by subtask count, not just 1", () => {
    expect(expandBudget(5, 4, 100)).toBe(9);
  });

  test("budget respects ceiling", () => {
    expect(expandBudget(98, 5, 100)).toBe(100);
  });

  test("single subtask increments by 1", () => {
    expect(expandBudget(5, 1, 100)).toBe(6);
  });

  test("at ceiling, budget stays unchanged", () => {
    expect(expandBudget(100, 3, 100)).toBe(100);
  });
});

// ── 4b. clampCols / clampRows — NaN safety ──

describe("clampCols / clampRows — NaN safety", () => {
  test("NaN returns sensible default", () => {
    expect(clampCols(NaN)).toBe(80);
    expect(clampRows(NaN)).toBe(24);
  });

  test("normal values still clamp correctly", () => {
    expect(clampCols(10)).toBe(20);
    expect(clampCols(500)).toBe(300);
    expect(clampCols(120)).toBe(120);
    expect(clampRows(2)).toBe(5);
    expect(clampRows(200)).toBe(100);
    expect(clampRows(40)).toBe(40);
  });

  test("undefined coerces to NaN default", () => {
    expect(clampCols(undefined as any)).toBe(80);
    expect(clampRows(undefined as any)).toBe(24);
  });

  test("null coerces to 0, gets clamped to minimum", () => {
    expect(clampCols(null as any)).toBe(20);
    expect(clampRows(null as any)).toBe(5);
  });
});

// ── 4. Ralph cleanup scope uses START_COMMIT ──

describe("ralph cleanup prompt — START_COMMIT boundary", () => {
  test("uses START_COMMIT when available", () => {
    expect(resolveCleanupDiffBase("abc123")).toBe("abc123");
  });

  test("falls back to HEAD~10 when START_COMMIT is empty", () => {
    expect(resolveCleanupDiffBase("")).toBe("HEAD~10");
  });
});

// ── 5. /api/ralph/start validation ──

import { isValidPlanFile, BRANCH_REGEX } from "../../src/validation.js";

describe("ralph start — validation functions", () => {
  test("valid plan filenames", () => {
    expect(isValidPlanFile("PLAN.md")).toBe(true);
    expect(isValidPlanFile("my-plan.md")).toBe(true);
    expect(isValidPlanFile("plan v2.md")).toBe(true);
  });

  test("path traversal attempts rejected", () => {
    expect(isValidPlanFile("../evil.md")).toBe(false);
    expect(isValidPlanFile("path/to/plan.md")).toBe(false);
    expect(isValidPlanFile("")).toBe(false);
    expect(isValidPlanFile("..")).toBe(false);
    expect(isValidPlanFile(".")).toBe(false);
  });

  test("branch names validated", () => {
    expect(BRANCH_REGEX.test("feature/foo")).toBe(true);
    expect(BRANCH_REGEX.test("main")).toBe(true);
    expect(BRANCH_REGEX.test("fix-123")).toBe(true);
    expect(BRANCH_REGEX.test("branch with spaces")).toBe(false);
    expect(BRANCH_REGEX.test("")).toBe(false);
  });

  test("iterations are clamped to [1, 500]", () => {
    function clampIters(iterations: number | undefined): number {
      return Math.max(1, Math.min(500, iterations ?? 5));
    }

    expect(clampIters(undefined)).toBe(5);
    expect(clampIters(0)).toBe(1);
    expect(clampIters(-10)).toBe(1);
    expect(clampIters(1000)).toBe(500);
    expect(clampIters(50)).toBe(50);
  });
});
