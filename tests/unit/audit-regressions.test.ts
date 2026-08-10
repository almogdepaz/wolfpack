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
// Imports the real `validateProjectDir` from src/ so this test cannot drift
// from production. `isUnderDevDir` resolves DEV_DIR from process.env.WOLFPACK_DEV_DIR
// at call time (set at top of file to /Users/home/Dev/).

import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { validateExplicitProjectDir, validateProjectDir } = await import("../../src/server/validate-project-dir.js");

describe("validateProjectDir — realpath containment", () => {
  test("rejects directory whose realpath escapes DEV_DIR", () => {
    const testDevDir = mkdtempSync(join(tmpdir(), "wolfpack-devdir-"));
    const project = join(testDevDir, "legit-project");
    mkdirSync(project);
    // testDevDir is under /tmp (or macOS equivalent), not under DEV_DIR (/Users/home/Dev/),
    // so containment must fail.
    const real = realpathSync(project);
    expect(isUnderDevDir(real)).toBe(false);
    const result = validateProjectDir(project);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_dir");
    rmSync(testDevDir, { recursive: true, force: true });
  });

  test("rejects symlink even when target would otherwise be valid", () => {
    const testDevDir = mkdtempSync(join(tmpdir(), "wolfpack-devdir-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "wolfpack-outside-"));
    const symlink = join(testDevDir, "sneaky-link");
    symlinkSync(outsideDir, symlink);
    // lstat catches the symlink before realpath even runs.
    const result = validateProjectDir(symlink);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_dir");
    rmSync(testDevDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("rejects nonexistent directory", () => {
    const result = validateProjectDir("/nonexistent/path/xyz");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_found");
  });
});

describe("validateExplicitProjectDir — explicit arbitrary directory boundary", () => {
  test("accepts an existing directory outside DEV_DIR and returns its canonical path", () => {
    const rawDir = mkdtempSync(join(tmpdir(), "wolfpack-explicit-project-"));
    try {
      expect(validateExplicitProjectDir(rawDir)).toEqual({
        ok: true,
        projectDir: realpathSync(rawDir),
      });
    } finally {
      rmSync(rawDir, { recursive: true, force: true });
    }
  });

  test("canonicalizes a directory reached through an intermediate symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-explicit-canonical-"));
    const targetParent = join(root, "target");
    const projectDir = join(targetParent, "project");
    const linkedParent = join(root, "linked-parent");
    mkdirSync(projectDir, { recursive: true });
    symlinkSync(targetParent, linkedParent);
    try {
      expect(validateExplicitProjectDir(join(linkedParent, "project"))).toEqual({
        ok: true,
        projectDir: realpathSync(projectDir),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects relative, NUL-containing, and overlong paths before filesystem access", () => {
    for (const projectDir of ["relative/project", "/tmp/with\0nul", `/${"a".repeat(4_096)}`]) {
      expect(validateExplicitProjectDir(projectDir)).toEqual({
        ok: false,
        code: "invalid",
        error: "invalid project directory",
      });
    }
  });

  test("rejects final symlinks, files, and missing paths", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-explicit-invalid-"));
    const directory = join(root, "directory");
    const symlink = join(root, "symlink");
    const file = join(root, "file");
    mkdirSync(directory);
    symlinkSync(directory, symlink);
    writeFileSync(file, "not a directory");
    try {
      expect(validateExplicitProjectDir(symlink)).toMatchObject({ ok: false, code: "not_dir" });
      expect(validateExplicitProjectDir(`${symlink}/`)).toMatchObject({ ok: false, code: "not_dir" });
      expect(validateExplicitProjectDir(file)).toMatchObject({ ok: false, code: "not_dir" });
      expect(validateExplicitProjectDir(join(root, "missing"))).toMatchObject({ ok: false, code: "not_found" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

import {
  clampCols,
  clampRows,
} from "../../src/validation.js";

// ── 3. clampCols / clampRows — NaN safety ──

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
