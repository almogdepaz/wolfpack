/** Non-interactive configuration shared by the CLI and server. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { isPinnedSessions, type PinnedSession } from "./pinned-sessions.js";
import { isValidPort } from "./validation.js";
import { resolveWolfpackDir } from "./wolfpack-dir.js";
import { canonicalTailnetOrigin, isMachineDisplayName } from "./tailnet-machine-contract.js";

export const IS_MACOS = platform() === "darwin";
export const IS_LINUX = platform() === "linux";

export const WOLFPACK_DIR = resolveWolfpackDir();
export const CONFIG_PATH = join(WOLFPACK_DIR, "config.json");

export interface Config {
  devDir: string;
  port: number;
  tailscaleHostname?: string;
  /** Host-owned machine display name; overrides the OS computer name in every handshake. */
  displayName?: string;
  /** Installation identity, not a display name or an arbitrary URL. */
  focus?: { home: string };
  pinnedSessions?: PinnedSession[];
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
  const displayName = typeof candidate.displayName === "string" ? candidate.displayName.trim() : undefined;
  let focus: Config["focus"];
  if (candidate.focus !== undefined) {
    const value = candidate.focus as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.home !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.home) || Object.keys(value).some(k => k !== "home")) return null;
    focus = { home: value.home };
  }
  if (candidate.pinnedSessions !== undefined && !isPinnedSessions(candidate.pinnedSessions)) return null;
  return { devDir, port, tailscaleHostname, ...(isMachineDisplayName(displayName) && { displayName }), ...(focus && { focus }), ...(candidate.pinnedSessions !== undefined && { pinnedSessions: candidate.pinnedSessions as PinnedSession[] }) };
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
