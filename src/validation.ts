/**
 * Shared pure validation functions.
 * Extracted from serve.ts and cli.ts for testability — zero side effects.
 */
// ── Regex patterns ──

export const CMD_REGEX = /^[a-zA-Z0-9 \-._/=]+$/;
export const SAFE_FILENAME = /^[a-zA-Z0-9._\- ]+$/;

// ── Validation functions ──

export function isValidProjectName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

export const MAX_SESSION_NAME_LENGTH = 100;
export const MAX_INITIAL_PROMPT_LENGTH = 32_768;

export function isValidSessionName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0 && name.length <= MAX_SESSION_NAME_LENGTH;
}

// ── Clamping ──

export function clampCols(n: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(20, Math.min(v, 300)) : 80;
}

export function clampRows(n: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(5, Math.min(v, 100)) : 24;
}

// ── Port validation ──

export function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

// ── Shell escaping ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/\0/g, "").replace(/'/g, "'\\''") + "'";
}

// ── XML/plist escaping ──

export function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ── systemd Environment value escaping ──

export function systemdEsc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "");
}
