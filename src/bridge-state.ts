import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STATE_FILE, TOKEN_FILE } from "./constants.js";

export interface BridgeEntry {
  enabled: boolean;
  paused: boolean;
  tmuxSession: string;
  groupJid: string;
  groupName: string;
  enabledAt: string;
}

export interface BridgeState {
  bridges: Record<string, BridgeEntry>;
}

function statePath(stateDir: string): string {
  return join(stateDir, BRIDGE_STATE_FILE);
}

export function loadState(stateDir: string): BridgeState {
  const p = statePath(stateDir);
  if (!existsSync(p)) {
    return { bridges: {} };
  }
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return { bridges: {} };
  }
}

export function saveState(stateDir: string, state: BridgeState): void {
  writeFileSync(statePath(stateDir), JSON.stringify(state, null, 2));
}

export function isValidGroupJid(jid: string): boolean {
  return typeof jid === "string" && jid.endsWith("@g.us") && jid.length > 5;
}

export function extractGroupJid(sessionKey: string): string | null {
  const match = sessionKey.match(/:whatsapp:group:(.+)$/);
  if (!match) return null;
  const jid = match[1];
  return isValidGroupJid(jid) ? jid : null;
}

export function enableBridge(
  stateDir: string,
  sessionKey: string,
  tmuxSession: string,
  groupJid: string,
  groupName: string
): BridgeEntry | null {
  if (!isValidGroupJid(groupJid)) return null;
  const state = loadState(stateDir);
  const entry: BridgeEntry = {
    enabled: true,
    paused: false,
    tmuxSession,
    groupJid,
    groupName,
    enabledAt: new Date().toISOString(),
  };
  state.bridges[sessionKey] = entry;
  saveState(stateDir, state);
  return entry;
}

export function disableBridge(stateDir: string, sessionKey: string): void {
  const state = loadState(stateDir);
  delete state.bridges[sessionKey];
  saveState(stateDir, state);
}

export function pauseBridge(stateDir: string, sessionKey: string): boolean {
  const state = loadState(stateDir);
  const entry = state.bridges[sessionKey];
  if (!entry?.enabled) return false;
  entry.paused = true;
  saveState(stateDir, state);
  return true;
}

export function resumeBridge(stateDir: string, sessionKey: string): boolean {
  const state = loadState(stateDir);
  const entry = state.bridges[sessionKey];
  if (!entry?.enabled) return false;
  entry.paused = false;
  saveState(stateDir, state);
  return true;
}

export function getBridge(
  stateDir: string,
  sessionKey: string
): BridgeEntry | null {
  const state = loadState(stateDir);
  const entry = state.bridges[sessionKey];
  if (!entry?.enabled) return null;
  if (!isValidGroupJid(entry.groupJid)) return null;
  return entry;
}

export function getAllBridges(stateDir: string): Array<[string, BridgeEntry]> {
  const state = loadState(stateDir);
  return Object.entries(state.bridges).filter(
    ([, e]) => e.enabled && isValidGroupJid(e.groupJid)
  );
}

// =============================================================================
// Token management (tokens written by shell script, consumed by plugin)
// =============================================================================

interface TokenEntry {
  tmuxSession: string;
  createdAt: number;
  expiresAt: number;
}

interface TokenFile {
  tokens: Record<string, TokenEntry>;
}

function tokenFilePath(): string {
  return join(process.env.HOME ?? "~", ".clawdbot", TOKEN_FILE);
}

function loadTokens(): TokenFile {
  const p = tokenFilePath();
  if (!existsSync(p)) return { tokens: {} };
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return { tokens: {} };
  }
}

function saveTokens(data: TokenFile): void {
  writeFileSync(tokenFilePath(), JSON.stringify(data, null, 2));
}

/**
 * Consume a token: validate it exists and hasn't expired, delete it, return the tmuxSession.
 * Returns null if token is invalid or expired.
 */
export function consumeToken(token: string): { tmuxSession: string } | null {
  const data = loadTokens();
  const entry = data.tokens[token];
  if (!entry) return null;

  // Always delete the token (consumed or expired)
  delete data.tokens[token];
  saveTokens(data);

  if (Date.now() > entry.expiresAt) return null;

  return { tmuxSession: entry.tmuxSession };
}
