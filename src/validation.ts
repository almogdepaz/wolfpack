/**
 * Shared pure validation functions.
 * Extracted from serve.ts and cli.ts for testability — zero side effects.
 */
import { isAbsolute, resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import type { RalphAgent } from "./ralph-agent.js";

// ── Regex patterns ──

export const CMD_REGEX = /^[a-zA-Z0-9 \-._/=]+$/;
export const BRANCH_REGEX = /^(?!.*\.\.)(?!.*\/\/)[a-zA-Z0-9._\-/]+$/;
export const PLAN_FILE_REGEX = /^[a-zA-Z0-9._\- ]+\.md$/;
export const DOT_PLANS_FILE_REGEX = /^\.plans\/[a-zA-Z0-9._\- ]+\.md$/;
export const SAFE_FILENAME = /^[a-zA-Z0-9._\- ]+$/;

// ── Validation functions ──

export function isValidProjectName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

export function isValidSessionName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0 && name.length <= 100;
}

export function isValidPlanFile(name: string): boolean {
  return (PLAN_FILE_REGEX.test(name) || DOT_PLANS_FILE_REGEX.test(name)) && name !== ".." && name !== ".";
}

// ── Budget expansion ──

/** Expand iteration budget by subtask count, capped at ceiling. */
export function expandBudget(current: number, subtaskCount: number, ceiling: number): number {
  return current < ceiling ? Math.min(current + Math.max(0, subtaskCount), ceiling) : current;
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

export interface BuildSrtSettingsOptions {
  readonly agent?: RalphAgent;
}

/**
 * Cached `rg` resolution. Previously this ran a sync
 * `which rg` on every ralph iteration via buildSrtSettings → a hang in
 * `which` (slow PATH, NFS, broken `which` shim) would block iteration
 * startup, and the cost was paid N times per loop. PATH doesn't change
 * within a process lifetime; one resolve per process is enough.
 *
 * `null` = explicitly resolved-and-not-found (don't re-probe). Use the
 * `__resetResolveRipgrepBinCache` helper from tests if you need a fresh
 * lookup (we don't currently expose it; PATH is stable enough that the
 * cache is fine for the test suite).
 */
let _cachedRgBin: { command: string; argv0?: string } | null | undefined;

/** Resolve a real binary path for rg (shell functions/aliases don't work in child processes). */
function resolveRipgrepBin(): { command: string; argv0?: string } | undefined {
  if (_cachedRgBin !== undefined) return _cachedRgBin ?? undefined;
  // Prefer a real rg binary on PATH
  try {
    const rgPath = execFileSync("which", ["rg"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (rgPath && !rgPath.includes("not found")) {
      _cachedRgBin = { command: rgPath };
      return _cachedRgBin;
    }
  } catch { /* not on PATH */ }
  // Fallback: claude bundles rg as a multicall binary (ARGV0=rg)
  const claudeBin = join(homedir(), ".local/bin/claude");
  try {
    statSync(claudeBin);
    _cachedRgBin = { command: claudeBin, argv0: "rg" };
    return _cachedRgBin;
  } catch { /* nope */ }
  _cachedRgBin = null;
  return undefined;
}

function resolveGitMetadataDirs(cwd: string): string[] {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return [gitDir, commonDir]
      .filter(path => path.length > 0)
      .map(path => isAbsolute(path) ? path : resolve(cwd, path))
      .filter((path, index, paths) => paths.indexOf(path) === index);
  } catch {
    return [];
  }
}

/** Build srt settings scoped to the given working directory. */
export function buildSrtSettings(allowedWriteDir: string, options: BuildSrtSettingsOptions = {}): SrtSettings {
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
      allowWrite: [absDir, "/tmp", join(homedir(), ".claude")],
      denyWrite: [".env", ".env.*", "*.pem", "*.key"],
    },
  };

  settings.filesystem.allowWrite.push(...resolveGitMetadataDirs(absDir));

  if (options.agent === "codex") {
    settings.network.allowedDomains.push("chatgpt.com", "*.chatgpt.com");
    // Codex initializes mutable state under ~/.codex before stable per-session
    // subpaths exist. This intentionally grants broad persistent Codex state
    // access; docs/ralph-behavior.md records the accepted sandbox risk.
    settings.filesystem.allowWrite.push(join(homedir(), ".codex"));
  }

  const rg = resolveRipgrepBin();
  if (rg) settings.ripgrep = rg;
  return settings;
}
