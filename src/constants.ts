export const DEFAULT_OUTPUT_PREFIX = "\u{1F916}";
export const DEFAULT_QUIET_TIMEOUT_MS = 1000;
export const DEFAULT_MAX_OUTPUT_CHARS = 12000;
export const WHATSAPP_TEXT_CHUNK_LIMIT = 4000;
export const BRIDGE_STATE_FILE = "claude-bridge-state.json";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const LOG_DIR = (() => {
  const dir = join(process.env.HOME ?? "~", ".wolfpack", "logs");
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  return dir;
})();
export const LOG_FILE_PREFIX = "claude-bridge-";
export const ECHO_TTL_MS = 30_000;
export const GROUP_NAME_PREFIX = "cc-";
export const TOKEN_FILE = "claude-bridge-tokens.json";
export const TOKEN_TTL_MS = 300_000; // 5 minutes
