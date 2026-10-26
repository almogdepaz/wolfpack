import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { MAX_GIT_DIFF_SECTION_BYTES, MAX_GIT_DIFF_UNTRACKED_BYTES, parseProjectGitDiff, serializedDiffBytes, type ProjectGitDiff } from "../extensions/git-diff-contract.ts";
import { openProjectGit, type ProjectGitResult } from "./project-git.ts";

/** Raw output buffered per invocation; larger diffs stop the subprocess and are reported truncated. */
const MAX_OUTPUT = 128 * 1024;
/** One `--no-index` subprocess per untracked file (~8 ms each) shares the runner's deadline with everything else. */
const MAX_UNTRACKED_FILES = 32;
/** Larger untracked files are skipped instead of read; their diff could not fit the section anyway. */
const MAX_UNTRACKED_FILE_BYTES = 128 * 1024;
// No external diff, textconv, renames, colour or diff.relative scoping: paths stay repository-relative like status.
const DIFF = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative", "--ignore-submodules=all", "--unified=3", "--src-prefix=a/", "--dst-prefix=b/"];

/**
 * Keep whole lines whose JSON form fits the section cap. `stopped` output ends mid-stream,
 * so its trailing partial line is dropped and the section is always reported truncated.
 */
export function boundDiffSection(output: string, stopped: boolean, cap = MAX_GIT_DIFF_SECTION_BYTES): { text: string; truncated: boolean } {
  const complete = stopped ? output.slice(0, output.lastIndexOf("\n") + 1) : output;
  if (serializedDiffBytes(complete) <= cap) return { text: complete, truncated: stopped };
  // Lines split at "\n" never split a surrogate pair, so per-line escaped sizes add up exactly.
  let size = 2, end = 0;
  for (let next = complete.indexOf("\n"); next !== -1; next = complete.indexOf("\n", end)) {
    const line = serializedDiffBytes(complete.slice(end, next + 1)) - 2;
    if (size + line > cap) break;
    size += line; end = next + 1;
  }
  return { text: complete.slice(0, end), truncated: true };
}

// Git fails fatally (exit 128) on an unreadable file; skip it rather than lose every section.
const readable = (file: string) => { try { accessSync(file, constants.R_OK); return true; } catch { return false; } };

/**
 * Untracked files diffed one by one against /dev/null, in Git's listing order. Non-regular,
 * oversized, unreadable, vanished or uncounted files are skipped and reported as truncated.
 */
async function readUntracked(projectPath: string, run: (args: string[]) => Promise<ProjectGitResult>): Promise<{ text: string; truncated: boolean }> {
  // `:/` with --full-name lists the whole repository with root-relative names, like status, from any subdirectory.
  const listing = await run(["ls-files", "--others", "--exclude-standard", "-z", "--full-name", "--", ":/"]);
  if (listing.code !== 0) throw new Error("Git diff unavailable");
  const paths = listing.stdout.split("\0");
  paths.pop(); // the empty record after the final NUL, or the partial record of a stopped listing
  let truncated = listing.overflowed || paths.length > MAX_UNTRACKED_FILES;
  if (!paths.length) return { text: "", truncated };
  // `--no-index` paths and headers are relative to the working directory, so diff from the repository root.
  const top = await run(["rev-parse", "--show-cdup"]);
  const cdup = top.stdout.endsWith("\n") ? top.stdout.slice(0, -1) : "";
  if (top.code !== 0 || top.overflowed || !/^(\.\.\/)*$/.test(cdup)) throw new Error("Git diff unavailable");
  // Git resolves `cdup` physically; resolve the project too so a symlinked project path checks the files Git reads.
  const base = join(realpathSync(projectPath), cdup);
  let output = "";
  for (const path of paths.slice(0, MAX_UNTRACKED_FILES)) {
    if (output.length > MAX_GIT_DIFF_UNTRACKED_BYTES) { truncated = true; break; }
    const file = join(base, path), stat = lstatSync(file, { throwIfNoEntry: false });
    // Regular files only: `--no-index` follows a symlink, and one to a FIFO would block until the shared deadline.
    if (!stat?.isFile() || stat.size > MAX_UNTRACKED_FILE_BYTES || !readable(file)) { truncated = true; continue; }
    const diff = await run(["-C", cdup || ".", ...DIFF, "--no-index", "--", "/dev/null", path]);
    // Exit 1 means the file differs from /dev/null; without output it could not be read (e.g. it vanished).
    if (diff.code === 1 && !diff.stdout && diff.stderr) { truncated = true; continue; }
    if (diff.code !== 0 && diff.code !== 1) throw new Error("Git diff unavailable");
    if (diff.overflowed) { output += diff.stdout.slice(0, diff.stdout.lastIndexOf("\n") + 1); truncated = true; break; }
    output += diff.stdout;
  }
  const section = boundDiffSection(output, false, MAX_GIT_DIFF_UNTRACKED_BYTES);
  return { text: section.text, truncated: truncated || section.truncated };
}

export async function readProjectGitDiff(projectPath: string): Promise<ProjectGitDiff> {
  const run = await openProjectGit(projectPath, { label: "Git diff", maxOutput: MAX_OUTPUT, allowOverflow: true });
  const unstaged = await run(DIFF);
  // Outside a repository `git diff` falls back to `--no-index` usage (exit 129) instead of the usual fatal 128.
  if (unstaged.code === 129 && unstaged.stderr.startsWith("warning: Not a git repository")) return { state: "not-repository" };
  if (unstaged.code === 128 && unstaged.stderr.startsWith("fatal: not a git repository")) return { state: "not-repository" };
  if (unstaged.code !== 0) throw new Error("Git diff unavailable");
  const staged = await run([...DIFF, "--cached"]);
  if (staged.code !== 0) throw new Error("Git diff unavailable");
  const stagedSection = boundDiffSection(staged.stdout, staged.overflowed), unstagedSection = boundDiffSection(unstaged.stdout, unstaged.overflowed);
  const untracked = await readUntracked(projectPath, run);
  return parseProjectGitDiff({ state: "ready", staged: stagedSection.text, unstaged: unstagedSection.text, untracked: untracked.text, truncated: stagedSection.truncated || unstagedSection.truncated || untracked.truncated });
}
