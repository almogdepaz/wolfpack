import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export const RALPH_TRANSIENT_GIT_EXCLUDES = [
  ".ralph-response.json",
  ".ralph-response-schema-*.json",
  ".ralph-srt-settings-*.json",
  ".ralph.log",
  ".ralph.lock",
  ".ralph_iter.tmp",
] as const;

export function ensureRalphTransientGitExcludes(cwd: string, progressFile: string): void {
  let excludePath: string;
  try {
    const gitPath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    excludePath = isAbsolute(gitPath) ? gitPath : join(cwd, gitPath);
  } catch {
    return;
  }

  const patterns = [...RALPH_TRANSIENT_GIT_EXCLUDES, progressFile];
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
  const existingLines = new Set(existing.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  const missing = patterns.filter(pattern => !existingLines.has(pattern));
  if (missing.length === 0) return;

  mkdirSync(dirname(excludePath), { recursive: true });
  const prefix = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
  const header = existing.includes("# ralph transient files") ? "" : "# ralph transient files\n";
  writeFileSync(excludePath, `${existing}${prefix}${header}${missing.join("\n")}\n`);
}
