import { MAX_GIT_DIFF_SECTION_BYTES, parseProjectGitDiff, serializedDiffBytes, type ProjectGitDiff } from "../extensions/git-diff-contract.ts";
import { openProjectGit } from "./project-git.ts";

/** Raw output buffered per invocation; larger diffs stop the subprocess and are reported truncated. */
const MAX_OUTPUT = 128 * 1024;
// No external diff, textconv, renames, colour or diff.relative scoping: paths stay repository-relative like status.
const DIFF = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative", "--ignore-submodules=all", "--unified=3", "--src-prefix=a/", "--dst-prefix=b/"];

/**
 * Keep whole lines whose JSON form fits the section cap. `stopped` output ends mid-stream,
 * so its trailing partial line is dropped and the section is always reported truncated.
 */
export function boundDiffSection(output: string, stopped: boolean): { text: string; truncated: boolean } {
  const complete = stopped ? output.slice(0, output.lastIndexOf("\n") + 1) : output;
  if (serializedDiffBytes(complete) <= MAX_GIT_DIFF_SECTION_BYTES) return { text: complete, truncated: stopped };
  // Lines split at "\n" never split a surrogate pair, so per-line escaped sizes add up exactly.
  let size = 2, end = 0;
  for (let next = complete.indexOf("\n"); next !== -1; next = complete.indexOf("\n", end)) {
    const line = serializedDiffBytes(complete.slice(end, next + 1)) - 2;
    if (size + line > MAX_GIT_DIFF_SECTION_BYTES) break;
    size += line; end = next + 1;
  }
  return { text: complete.slice(0, end), truncated: true };
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
  return parseProjectGitDiff({ state: "ready", staged: stagedSection.text, unstaged: unstagedSection.text, truncated: stagedSection.truncated || unstagedSection.truncated });
}
