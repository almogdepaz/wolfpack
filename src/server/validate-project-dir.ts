/**
 * Project-directory validation — pure module (no HTTP side-effects).
 *
 * Extracted from routes.ts so regression tests can exercise the real
 * implementation instead of a copy. The routes.ts call sites wrap this
 * with response-emitting helpers.
 */
import { lstatSync, statSync, realpathSync } from "node:fs";
import { isUnderDevDir } from "./dev-dir.js";

export type ValidateProjectDirResult =
  | { ok: true; projectDir: string }
  | { ok: false; code: "not_dir" | "not_found"; error: string };

/**
 * Validate that `projectDir`:
 *   1. exists,
 *   2. is not a symlink (lstat),
 *   3. is a directory,
 *   4. and its realpath resolves under DEV_DIR (defense-in-depth).
 *
 * Returns a discriminated result rather than mutating an HTTP response.
 * Callers translate `code` to a status code (`not_dir` → 400, `not_found` → 404).
 */
export function validateProjectDir(projectDir: string): ValidateProjectDirResult {
  try {
    if (lstatSync(projectDir).isSymbolicLink() || !statSync(projectDir).isDirectory()) {
      return { ok: false, code: "not_dir", error: "not a directory" };
    }
    if (!isUnderDevDir(realpathSync(projectDir))) {
      return { ok: false, code: "not_dir", error: "not a directory" };
    }
  } catch {
    return { ok: false, code: "not_found", error: "project directory not found" };
  }
  return { ok: true, projectDir };
}
