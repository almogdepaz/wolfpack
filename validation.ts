/**
 * Shared pure validation functions.
 * Extracted from serve.ts and cli.ts for testability — zero side effects.
 */

// ── Key allowlist for WS terminal handler ──

export const WS_ALLOWED_KEYS = new Set([
  "Enter", "Tab", "Escape", "Up", "Down", "Left", "Right",
  "BTab", "BSpace", "DC", "Home", "End", "PPage", "NPage",
  "y", "n",
  "C-a", "C-b", "C-c", "C-d", "C-e", "C-f", "C-g", "C-h",
  "C-k", "C-l", "C-n", "C-p", "C-r", "C-u", "C-w", "C-z",
]);

// ── Regex patterns ──

export const CMD_REGEX = /^[a-zA-Z0-9 \-._/=]+$/;
export const BRANCH_REGEX = /^[a-zA-Z0-9._\-/]+$/;
export const PLAN_FILE_REGEX = /^[a-zA-Z0-9._\- ]+\.md$/;

// ── Validation functions ──

export function isValidProjectName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

export function isValidPlanFile(name: string): boolean {
  return PLAN_FILE_REGEX.test(name) && name !== ".." && name !== ".";
}

// ── Clamping ──

export function clampCols(n: number): number {
  return Math.max(20, Math.min(n, 300));
}

export function clampRows(n: number): number {
  return Math.max(5, Math.min(n, 100));
}

// ── Port validation ──

export function isValidPort(n: number): boolean {
  return Number.isFinite(n) && n >= 1 && n <= 65535;
}

// ── Shell escaping ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
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
