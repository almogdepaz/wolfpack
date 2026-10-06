import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { MAX_GIT_STATUS_FILES, parseProjectGitStatus, type GitChangeKind, type GitFileChange, type ProjectGitStatus } from "../extensions/git-status-contract.ts";

const MAX_OUTPUT = 256 * 1024;
const TIMEOUT_MS = 2000;
const kinds: Record<string, GitChangeKind> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type-changed", U: "unmerged" };

/** Porcelain v2 -z: filenames are opaque, including spaces, tabs, newlines and arrows. */
export function parseGitPorcelain(output: string): ProjectGitStatus {
  if (Buffer.byteLength(output) > MAX_OUTPUT) throw new Error("Git status output exceeds limit");
  const staged: GitFileChange[] = [], unstaged: GitFileChange[] = [], untracked: GitFileChange[] = [];
  let branch: string | null = null, detached = false, count = 0, truncated = false, sawBranch = false;
  const records = output.split("\0");
  if (records.pop() !== "") throw new Error("incomplete Git status output");
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.startsWith("# ")) {
      if (record.startsWith("# branch.head ")) { sawBranch = true; const head = record.slice(14); detached = head === "(detached)"; branch = detached ? null : head; }
      continue;
    }
    let path: string, xy: string, previousPath: string | undefined;
    if (record.startsWith("? ")) { path = record.slice(2); xy = "??"; }
    else {
      const fields = record[0] === "1" ? 8 : record[0] === "2" ? 9 : record[0] === "u" ? 10 : 0;
      if (!fields) throw new Error("invalid Git status record");
      let position = 0;
      for (let field = 0; field < fields; field++) { position = record.indexOf(" ", position) + 1; if (!position) throw new Error("incomplete Git status record"); }
      path = record.slice(position); xy = record.slice(2, 4);
      if (record[0] === "2") { previousPath = records[++index]; if (!previousPath) throw new Error("incomplete Git rename"); }
      if (record[0] === "u") xy = "UU";
    }
    if (!path || path.length > 4096 || previousPath && previousPath.length > 4096) throw new Error("invalid Git path");
    if (++count > MAX_GIT_STATUS_FILES) { truncated = true; continue; }
    const entry = (status: GitChangeKind): GitFileChange => ({ path, status, ...(previousPath ? { previousPath } : {}) });
    if (xy === "??") { untracked.push(entry("untracked")); continue; }
    for (const [code, group] of [[xy[0], staged], [xy[1], unstaged]] as const) {
      if (code === ".") continue;
      if (!code || !kinds[code]) throw new Error("invalid Git change code");
      group.push(entry(kinds[code]!));
    }
  }
  if (!sawBranch) throw new Error("missing Git branch header");
  return parseProjectGitStatus({ state: "ready", branch, detached, staged, unstaged, untracked, truncated });
}

/** Fixed argv, no shell. Isolated Git configuration and an overall subprocess deadline. */
export async function readProjectGitStatus(projectPath: string): Promise<ProjectGitStatus> {
  if (!isAbsolute(projectPath) || projectPath.includes("\0")) throw new Error("invalid project directory");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
  const deadline = performance.now() + TIMEOUT_MS;
  const base = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null", "-C", projectPath];
  const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve, reject) => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) { reject(new Error("Git status timed out")); return; }
    execFile("git", [...base, ...args], { env, timeout: remaining, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== "number")) { reject(new Error("Git status unavailable")); return; }
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
  // Git may run clean/process filters while checking modified tracked files. Neutralize
  // all configured filter drivers (including conditional includes), not just Git LFS.
  const config = await run(["config", "--includes", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"]);
  if (config.code !== 0 && config.code !== 1) throw new Error("Git configuration unavailable");
  const keys = config.stdout.split("\0").filter(Boolean);
  if (keys.length > 256 || keys.some(key => !/^filter\.[^\0\r\n]+\.(clean|process|required)$/.test(key))) throw new Error("Git filter configuration exceeds limit");
  const overrides = [...new Set(keys)].flatMap(key => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]);
  const result = await run([...overrides, "status", "--porcelain=v2", "-z", "--branch", "--no-ahead-behind", "--no-renames", "--untracked-files=normal", "--ignore-submodules=all"]);
  if (result.code === 128 && result.stderr.startsWith("fatal: not a git repository")) return { state: "not-repository" };
  if (result.code !== 0) throw new Error("Git status unavailable");
  return parseGitPorcelain(result.stdout);
}
