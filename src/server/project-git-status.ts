import { MAX_GIT_STATUS_FILES, parseProjectGitStatus, type GitChangeKind, type GitFileChange, type ProjectGitStatus } from "../extensions/git-status-contract.ts";
import { openProjectGit } from "./project-git.ts";

const MAX_OUTPUT = 256 * 1024;
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
  const run = await openProjectGit(projectPath, { label: "Git status", maxOutput: MAX_OUTPUT });
  const result = await run(["status", "--porcelain=v2", "-z", "--branch", "--no-ahead-behind", "--no-renames", "--untracked-files=normal", "--ignore-submodules=all"]);
  if (result.code === 128 && result.stderr.startsWith("fatal: not a git repository")) return { state: "not-repository" };
  if (result.code !== 0) throw new Error("Git status unavailable");
  return parseGitPorcelain(result.stdout);
}
