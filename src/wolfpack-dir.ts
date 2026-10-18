import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Wolfpack's per-user state directory (config, settings, push keys, task
 * ledgers, runtime-state cache). `WOLFPACK_DIR` relocates every store at once
 * so tests and side-by-side installs never touch the real `~/.wolfpack`;
 * store-specific overrides (e.g. `WOLFPACK_SETTINGS_PATH`) still win.
 * A configured but relative value is refused rather than silently falling
 * back to the real directory.
 */
export function resolveWolfpackDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env.WOLFPACK_DIR?.trim();
  if (configured === undefined || configured === "") return join(homedir(), ".wolfpack");
  if (!isAbsolute(configured) || configured.includes("\0")) {
    throw new TypeError("WOLFPACK_DIR must be an absolute path");
  }
  return configured;
}
