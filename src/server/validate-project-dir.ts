/**
 * Project-directory validation — pure module (no HTTP side-effects).
 *
 * Extracted from routes.ts so regression tests can exercise the real
 * implementation instead of a copy. The routes.ts call sites wrap this
 * with response-emitting helpers.
 */
import { lstatSync, statSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isUnderDevDir } from "./dev-dir.js";

export const MAX_PROJECT_DIR_LENGTH = 4_096;

const NOT_FOUND_FILESYSTEM_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

export type ValidateProjectDirResult =
  | { ok: true; projectDir: string }
  | { ok: false; code: "invalid" | "not_dir" | "not_found" | "unavailable"; error: string };

/**
 * Validate that `projectDir`:
 *   1. exists,
 *   2. is not a symlink (lstat),
 *   3. is a directory,
 *   4. and its realpath resolves under DEV_DIR (defense-in-depth).
 *
 * Returns a discriminated result rather than mutating an HTTP response.
 * Callers translate `code` to an HTTP or command-specific error.
 */
export function validateProjectDir(projectDir: string): ValidateProjectDirResult {
  const result = validateDirectory(projectDir);
  if (!result.ok) return result;
  if (!isUnderDevDir(result.projectDir)) {
    return { ok: false, code: "not_dir", error: "not a directory" };
  }
  return result;
}

/**
 * Validate an explicitly selected existing directory without treating the
 * request path itself as authority. Explicit paths must be absolute and are
 * canonicalized before callers use them as a session cwd.
 */
export function validateExplicitProjectDir(projectDir: string): ValidateProjectDirResult {
  if (
    !projectDir
    || projectDir.length > MAX_PROJECT_DIR_LENGTH
    || projectDir.includes("\0")
    || !isAbsolute(projectDir)
  ) {
    return { ok: false, code: "invalid", error: "invalid project directory" };
  }
  return validateDirectory(projectDir);
}

function validateDirectory(projectDir: string): ValidateProjectDirResult {
  try {
    // A trailing separator makes lstat follow a final symlink on POSIX. Resolve
    // lexical separators first so the final component is always inspected.
    const pathToInspect = resolve(projectDir);
    if (lstatSync(pathToInspect).isSymbolicLink() || !statSync(pathToInspect).isDirectory()) {
      return { ok: false, code: "not_dir", error: "not a directory" };
    }
    return { ok: true, projectDir: realpathSync(pathToInspect) };
  } catch (error: unknown) {
    if (
      error instanceof Error
      && "code" in error
      && typeof error.code === "string"
      && NOT_FOUND_FILESYSTEM_CODES.has(error.code)
    ) {
      return { ok: false, code: "not_found", error: "project directory not found" };
    }
    return { ok: false, code: "unavailable", error: "project directory unavailable" };
  }
}
