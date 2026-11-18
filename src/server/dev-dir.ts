/**
 * Project-directory authority. DEV_DIR roots named-project discovery and creation.
 * Explicit existing paths use the separate canonicalizing validator.
 */
import { join } from "node:path";
import { homedir } from "node:os";

export const DEV_DIR =
  process.env.WOLFPACK_DEV_DIR || join(homedir(), "Dev");

/** Returns true for the selected root or its children (proper path boundary).
 * Without an explicit root, preserve current environment precedence. */
export function isUnderDevDir(dir: string, configuredDevDir?: string): boolean {
  const normalizePath = (path: string): string =>
    path.length > 1 ? path.replace(/\/+$/, "") : path;
  const devDir = configuredDevDir ?? (process.env.WOLFPACK_DEV_DIR || DEV_DIR);
  const baseDir = normalizePath(devDir);
  const candidate = normalizePath(dir);
  return candidate === baseDir || candidate.startsWith(baseDir + "/");
}
