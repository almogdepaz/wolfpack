/**
 * Regression tests for fixes from the security/correctness audit.
 * Each test targets a specific finding that was fixed in the fix/audit-findings branch.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PRIOR_ENV = {
  WOLFPACK_TEST: process.env.WOLFPACK_TEST,
  WOLFPACK_DEV_DIR: process.env.WOLFPACK_DEV_DIR,
} as const;
const { DEV_DIR: PRIOR_CACHED_DEV_DIR } = await import("../../src/server/dev-dir.ts");

process.env.WOLFPACK_TEST = "1";
const RAW_TEST_DEV_DIR = mkdtempSync(join(tmpdir(), "wolfpack-audit-devdir-"));
const TEST_DEV_DIR = realpathSync(RAW_TEST_DEV_DIR);
process.env.WOLFPACK_DEV_DIR = TEST_DEV_DIR;
const { __setDevDir } = await import("../../src/test-hooks.ts");
const { isUnderDevDir } = await import("../../src/server/dev-dir.js");
__setDevDir(TEST_DEV_DIR);

// ── 1. Path containment boundary (audit finding: prefix check too weak) ──

describe("isUnderDevDir — path containment boundary", () => {
  test("exact match on DEV_DIR itself", () => {
    expect(isUnderDevDir(`${TEST_DEV_DIR}/`)).toBe(true);
    expect(isUnderDevDir(TEST_DEV_DIR)).toBe(true);
  });

  test("child directory matches", () => {
    expect(isUnderDevDir(join(TEST_DEV_DIR, "wolfpack"))).toBe(true);
    expect(isUnderDevDir(join(TEST_DEV_DIR, "foo", "bar", "baz"))).toBe(true);
  });

  test("rejects sibling path that shares string prefix", () => {
    expect(isUnderDevDir(`${TEST_DEV_DIR}eloper`)).toBe(false);
    expect(isUnderDevDir(`${TEST_DEV_DIR}Ops`)).toBe(false);
    expect(isUnderDevDir(`${TEST_DEV_DIR}2`)).toBe(false);
  });

  test("rejects unrelated paths", () => {
    expect(isUnderDevDir(join(tmpdir(), "something"))).toBe(false);
    expect(isUnderDevDir(join(dirname(TEST_DEV_DIR), "other", "project"))).toBe(false);
  });

  test("rejects partial prefix with no separator", () => {
    expect(isUnderDevDir(`${TEST_DEV_DIR}ious`)).toBe(false);
  });
});

// ── 1b. validateProjectDir realpath containment ──
// Imports the real `validateProjectDir` from src/ so this test cannot drift
// from production.

const { validateExplicitProjectDir, validateProjectDir } = await import("../../src/server/validate-project-dir.js");

describe("validateProjectDir — realpath containment", () => {
  test("rejects directory whose realpath escapes DEV_DIR", () => {
    const testDevDir = mkdtempSync(join(tmpdir(), "wolfpack-devdir-"));
    const project = join(testDevDir, "legit-project");
    mkdirSync(project);
    // testDevDir is a sibling temp root, not under TEST_DEV_DIR.
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
      expect(validateExplicitProjectDir(join(file, "child"))).toMatchObject({ ok: false, code: "not_found" });
      expect(validateExplicitProjectDir(join(root, "missing"))).toMatchObject({ ok: false, code: "not_found" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies structured ELOOP failures as unavailable without exposing OS details", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-explicit-unavailable-"));
    const loop = join(root, "loop");
    const projectDir = join(loop, "project");
    symlinkSync("loop", loop);
    try {
      let filesystemError: unknown;
      try {
        lstatSync(projectDir);
      } catch (error: unknown) {
        filesystemError = error;
      }
      expect(filesystemError).toBeInstanceOf(Error);
      expect((filesystemError as NodeJS.ErrnoException).code).toBe("ELOOP");
      expect(validateExplicitProjectDir(projectDir)).toEqual({
        ok: false,
        code: "unavailable",
        error: "project directory unavailable",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

afterAll(() => {
  rmSync(TEST_DEV_DIR, { recursive: true, force: true });
  __setDevDir(PRIOR_CACHED_DEV_DIR);
  if (PRIOR_ENV.WOLFPACK_DEV_DIR === undefined) delete process.env.WOLFPACK_DEV_DIR;
  else process.env.WOLFPACK_DEV_DIR = PRIOR_ENV.WOLFPACK_DEV_DIR;
  if (PRIOR_ENV.WOLFPACK_TEST === undefined) delete process.env.WOLFPACK_TEST;
  else process.env.WOLFPACK_TEST = PRIOR_ENV.WOLFPACK_TEST;
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
