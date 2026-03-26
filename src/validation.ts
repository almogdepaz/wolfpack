/**
 * Shared pure validation functions.
 * Extracted from serve.ts and cli.ts for testability — zero side effects.
 */
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";

// ── Classic terminal WS allowed keys ──

export const WS_ALLOWED_KEYS = new Set([
  "Enter", "Tab", "Escape", "Up", "Down", "Left", "Right",
  "BTab", "BSpace", "DC", "Home", "End", "PPage", "NPage",
  "y", "n",
  "C-a", "C-b", "C-c", "C-d", "C-e", "C-f", "C-g", "C-h",
  "C-k", "C-l", "C-n", "C-p", "C-r", "C-u", "C-w", "C-z",
]);

// ── Regex patterns ──

export const CMD_REGEX = /^[a-zA-Z0-9 \-._/=]+$/;
export const BRANCH_REGEX = /^(?!.*\.\.)(?!.*\/\/)[a-zA-Z0-9._\-/]+$/;
export const PLAN_FILE_REGEX = /^[a-zA-Z0-9._\- ]+\.md$/;
export const SAFE_FILENAME = /^[a-zA-Z0-9._\- ]+$/;

// ── Validation functions ──

export function isValidProjectName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

export function isValidSessionName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0 && name.length <= 100;
}

export function isValidPlanFile(name: string): boolean {
  return PLAN_FILE_REGEX.test(name) && name !== ".." && name !== ".";
}

// ── Budget expansion ──

/** Expand iteration budget by subtask count, capped at ceiling. */
export function expandBudget(current: number, subtaskCount: number, ceiling: number): number {
  return current < ceiling ? Math.min(current + subtaskCount, ceiling) : current;
}

/** Choose git diff base for ralph cleanup scope. */
export function resolveCleanupDiffBase(startCommit: string): string {
  return startCommit || "HEAD~10";
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

// ── Sandbox (srt) settings ──

export interface SrtSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
  };
  filesystem: {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  ripgrep?: {
    command: string;
  };
}

/** Resolve a real binary path for rg (shell functions/aliases don't work in child processes). */
function resolveRipgrepBin(): { command: string; argv0?: string } | undefined {
  // Prefer a real rg binary on PATH
  try {
    const rgPath = execFileSync("which", ["rg"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (rgPath && !rgPath.includes("not found")) return { command: rgPath };
  } catch { /* not on PATH */ }
  // Fallback: claude bundles rg as a multicall binary (ARGV0=rg)
  const claudeBin = join(homedir(), ".local/bin/claude");
  try { statSync(claudeBin); return { command: claudeBin, argv0: "rg" }; } catch { /* nope */ }
  return undefined;
}

/** Build srt settings scoped to the given working directory. */
export function buildSrtSettings(allowedWriteDir: string): SrtSettings {
  const absDir = resolve(allowedWriteDir);
  const settings: SrtSettings = {
    network: {
      allowedDomains: [
        "github.com", "*.github.com",
        "npmjs.org", "*.npmjs.org", "registry.npmjs.org",
        "yarnpkg.com", "*.yarnpkg.com",
        "crates.io", "*.crates.io", "static.crates.io",
        "pypi.org", "*.pypi.org", "files.pythonhosted.org",
        "proxy.golang.org", "sum.golang.org",
        "bun.sh", "*.bun.sh",
        "api.anthropic.com",
        "api.openai.com",
        "generativelanguage.googleapis.com",
      ],
      deniedDomains: [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: ["~/.ssh", "~/.gnupg", "~/.aws/credentials"],
      allowWrite: [absDir, "/tmp"],
      denyWrite: [".env", ".env.*", "*.pem", "*.key"],
    },
  };
  const rg = resolveRipgrepBin();
  if (rg) settings.ripgrep = rg;
  return settings;
}
