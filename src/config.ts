/** Non-interactive configuration shared by the CLI and server. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { isValidPort } from "./validation.js";
import { canonicalTailnetOrigin } from "./tailnet-machine-contract.js";

export const IS_MACOS = platform() === "darwin";
export const IS_LINUX = platform() === "linux";

export const WOLFPACK_DIR = join(homedir(), ".wolfpack");
export const CONFIG_PATH = join(WOLFPACK_DIR, "config.json");

export interface Config {
  devDir: string;
  port: number;
  tailscaleHostname?: string;
}

export function parseConfig(raw: unknown): Config | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const devDir = typeof candidate.devDir === "string" ? candidate.devDir.trim() : "";
  const port = candidate.port;
  if (!devDir || typeof port !== "number" || !isValidPort(port)) return null;
  const configuredHostname = typeof candidate.tailscaleHostname === "string"
    ? candidate.tailscaleHostname.trim()
    : "";
  const canonicalOrigin = configuredHostname ? canonicalTailnetOrigin(configuredHostname) : null;
  const tailscaleHostname = canonicalOrigin?.slice("https://".length);
  return { devDir, port, tailscaleHostname };
}

export function loadConfigFromText(text: string): Config | null {
  try {
    return parseConfig(JSON.parse(text));
  } catch { /* expected: malformed or empty config text */
    return null;
  }
}

export function loadConfig(): Config | null {
  try {
    return loadConfigFromText(readFileSync(CONFIG_PATH, "utf-8"));
  } catch { /* expected: config file doesn't exist yet */
    return null;
  }
}

export function saveConfig(c: Config) {
  mkdirSync(WOLFPACK_DIR, { recursive: true, mode: 0o700 });
  // 0600 — config holds Tailscale hostname and port; on shared machines
  // a default-umask 0644 would leak the network address to other local
  // users.
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
}

export function remoteUrl(config: Config): string | null {
  return canonicalTailnetOrigin(config.tailscaleHostname);
}
