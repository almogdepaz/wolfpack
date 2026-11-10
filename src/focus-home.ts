import { readFileSync } from "node:fs";
import { CONFIG_PATH, parseConfig } from "./config.js";
import { writePrivateJsonFile } from "./persistence.js";

export function isFocusHome(value: unknown): value is string | null {
  return value === null || typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
export function readFocusHomeConfig(path = CONFIG_PATH): Record<string, unknown> | null {
  try { const raw: unknown = JSON.parse(readFileSync(path, "utf8")); return parseConfig(raw) ? raw as Record<string, unknown> : null; }
  catch { return null; }
}
/** Atomic local-only config edit; unknown fields survive. An incoming local
 * home can retire its stale assistant pin without enabling/relaunching it. */
export function writeFocusHome(home: string | null, path = CONFIG_PATH, disableAssistantFolder?: string) {
  if (!isFocusHome(home)) throw new Error("home must be an installation id or null");
  const raw = readFocusHomeConfig(path);
  if (!raw) throw new Error("valid wolfpack config required");
  const previous = parseConfig(raw)!;
  const { focus: _prior, ...rest } = raw;
  const next: Record<string, unknown> = home === null ? rest : { ...rest, focus: { home } };
  const pins = previous.pinnedSessions;
  let unpinned = false;
  if (disableAssistantFolder && pins) {
    const retained = pins.filter(pin => pin.name !== "assistant" || pin.cwd !== disableAssistantFolder);
    unpinned = retained.length !== pins.length;
    if (unpinned) next.pinnedSessions = retained;
  }
  const config = parseConfig(next);
  if (!config) throw new Error("focus home config failed validation; not saved");
  const changed = (previous.focus?.home ?? null) !== home || unpinned;
  if (changed) writePrivateJsonFile(path, next);
  return { changed, config };
}
