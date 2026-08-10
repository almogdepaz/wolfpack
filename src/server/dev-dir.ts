/**
 * Project-directory authority. DEV_DIR roots named-project discovery and creation.
 * Explicit existing paths use the separate canonicalizing validator.
 */
import { join } from "node:path";
import { homedir } from "node:os";

export let DEV_DIR =
  process.env.WOLFPACK_DEV_DIR || join(homedir(), "Dev");

/** Test-only: override the cached DEV_DIR value. */
export function __setDevDir(dir: string): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__setDevDir() is only available in test mode");
  DEV_DIR = dir;
}

/** Returns true if dir is DEV_DIR itself or a child of DEV_DIR (proper path boundary).
 *  Reads DEV_DIR at call time so env overrides in tests take effect. */
export function isUnderDevDir(dir: string): boolean {
  const normalizePath = (path: string): string =>
    path.length > 1 ? path.replace(/\/+$/, "") : path;
  const devDir = process.env.WOLFPACK_DEV_DIR || DEV_DIR;
  const baseDir = normalizePath(devDir);
  const candidate = normalizePath(dir);
  return candidate === baseDir || candidate.startsWith(baseDir + "/");
}
