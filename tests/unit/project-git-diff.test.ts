import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundDiffSection, readProjectGitDiff } from "../../src/server/project-git-diff.ts";
import { readProjectGitStatus } from "../../src/server/project-git-status.ts";
import { MAX_GIT_DIFF_SECTION_BYTES, parseProjectGitDiff } from "../../src/extensions/git-diff-contract.ts";
import { EXTENSION_PEER_LIMITS } from "../../src/extensions/selected-host-contract.ts";

const roots: string[] = [];
function directory() { const root = mkdtempSync(join(tmpdir(), "wolfpack-git-diff-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0); return result.stdout.toString();
}
const serialized = (value: string) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** A fake git that answers the filter-config probe and runs `body` for every other invocation. */
function fakeGit(root: string, body: string) {
  const executable = join(root, "git");
  writeFileSync(executable, `#!/bin/sh\ncase "$*" in *config*) exit 1;; esac\n${body}\n`); chmodSync(executable, 0o755);
  const path = process.env.PATH; process.env.PATH = `${root}:${path}`;
  return () => { process.env.PATH = path; };
}

test("real Git diffs staged and unstaged text, binary and opaque paths separately on an unborn and a committed branch", async () => {
  const root = directory(); git(root, "init", "--initial-branch=main");
  const newline = "new\nline.txt", unicode = "spa ce é.txt";
  writeFileSync(join(root, "a.txt"), "one\n"); writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 98, 105, 110]));
  writeFileSync(join(root, unicode), "staged\n"); writeFileSync(join(root, newline), "x\n");
  git(root, "add", ".");
  const unborn = await readProjectGitDiff(root);
  expect(unborn).toMatchObject({ state: "ready", unstaged: "", truncated: false });
  if (unborn.state !== "ready") throw new Error("expected ready");
  expect(unborn.staged).toContain("diff --git a/a.txt b/a.txt\nnew file mode 100644\n");
  expect(unborn.staged).toContain("+one\n");
  expect(unborn.staged).toContain("Binary files /dev/null and b/bin.dat differ\n");
  // Git C-quotes unusual paths; the contract carries the patch text verbatim.
  expect(unborn.staged).toContain('+++ "b/new\\nline.txt"');
  expect(unborn.staged).toContain('"b/spa ce \\303\\251.txt"');
  git(root, "commit", "-m", "fixture");
  writeFileSync(join(root, "a.txt"), "one\nstaged two\n"); git(root, "add", "a.txt");
  writeFileSync(join(root, "a.txt"), "one\nstaged two\nunstaged three\n");
  writeFileSync(join(root, unicode), "staged\nworktree\n");
  writeFileSync(join(root, "untracked.txt"), "never diffed\n");
  const ready = await readProjectGitDiff(root);
  if (ready.state !== "ready") throw new Error("expected ready");
  expect(ready.truncated).toBe(false);
  expect(ready.staged).toBe("diff --git a/a.txt b/a.txt\nindex 5626abf..24d199c 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n one\n+staged two\n");
  expect(ready.unstaged).toContain("@@ -1,2 +1,3 @@\n one\n staged two\n+unstaged three\n");
  expect(ready.unstaged).toContain("+worktree\n");
  expect(ready.unstaged).not.toContain("+staged two");
  expect(ready.staged + ready.unstaged).not.toContain("untracked.txt");
});

test("Git diff runs no filters, textconv, external diff, fsmonitor or repository-relative scoping and leaves the index alone", async () => {
  const root = directory(); git(root, "init", "--initial-branch=main");
  writeFileSync(join(root, ".gitattributes"), "*.txt filter=hostile diff=hostile\n"); writeFileSync(join(root, "tracked.txt"), "initial\n");
  writeFileSync(join(root, "nested.md"), "outside\n"); mkdirSync(join(root, "sub")); writeFileSync(join(root, "sub", "inner.md"), "inner\n");
  git(root, "add", "."); git(root, "commit", "-m", "fixture");
  git(root, "config", "core.fsmonitor", "touch SHOULD_NOT_EXIST");
  git(root, "config", "filter.hostile.clean", "touch SHOULD_NOT_EXIST; cat");
  git(root, "config", "filter.hostile.process", "touch SHOULD_NOT_EXIST; cat");
  git(root, "config", "filter.hostile.required", "true");
  git(root, "config", "diff.hostile.textconv", "touch SHOULD_NOT_EXIST; cat");
  git(root, "config", "diff.hostile.command", "touch SHOULD_NOT_EXIST; true");
  git(root, "config", "diff.external", "touch SHOULD_NOT_EXIST; true");
  git(root, "config", "diff.relative", "true");
  git(root, "config", "color.ui", "always");
  writeFileSync(join(root, "tracked.txt"), "changed content\n"); writeFileSync(join(root, "nested.md"), "outside changed\n");
  const before = readFileSync(join(root, ".git", "index"));
  const old = process.env.GIT_DIR; process.env.GIT_DIR = "/does-not-exist";
  try {
    const diff = await readProjectGitDiff(root);
    if (diff.state !== "ready") throw new Error("expected ready");
    expect(diff.unstaged).toContain("-initial\n+changed content\n");
    expect(diff.unstaged).toContain("+outside changed\n");
    expect(diff.unstaged).not.toContain("\u001b[");
    // From a subdirectory, diff.relative must not hide or re-root changes elsewhere in the repository.
    const nested = await readProjectGitDiff(join(root, "sub"));
    if (nested.state !== "ready") throw new Error("expected ready");
    expect(nested.unstaged).toBe(diff.unstaged);
  } finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
  expect(readFileSync(join(root, ".git", "index"))).toEqual(before);
  expect(existsSync(join(root, "SHOULD_NOT_EXIST"))).toBe(false); expect(existsSync(join(root, "sub", "SHOULD_NOT_EXIST"))).toBe(false); expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
});

test("sections are cut at the last newline that keeps their JSON form under the cap", () => {
  expect(boundDiffSection("a\nb\n", false)).toEqual({ text: "a\nb\n", truncated: false });
  // Control characters serialize as six bytes each; the cap applies to the escaped form.
  const control = ("\u0001".repeat(1000) + "\n").repeat(40);
  expect(control.length).toBeLessThan(MAX_GIT_DIFF_SECTION_BYTES);
  const cut = boundDiffSection(control, false);
  expect(cut.truncated).toBe(true); expect(cut.text.endsWith("\n")).toBe(true);
  expect(serialized(cut.text)).toBeLessThanOrEqual(MAX_GIT_DIFF_SECTION_BYTES);
  expect(serialized(cut.text + "\u0001".repeat(1000) + "\n")).toBeGreaterThan(MAX_GIT_DIFF_SECTION_BYTES);
  expect(boundDiffSection("x".repeat(MAX_GIT_DIFF_SECTION_BYTES) + "\n", false)).toEqual({ text: "", truncated: true });
  // A stopped subprocess leaves a partial final line, which is dropped even when it would fit.
  expect(boundDiffSection("whole\npart", true)).toEqual({ text: "whole\n", truncated: true });
});

test("a large real diff is truncated, flagged and kept within the cap", async () => {
  const root = directory(); git(root, "init", "--initial-branch=main");
  writeFileSync(join(root, "big.txt"), "seed\n"); git(root, "add", "."); git(root, "commit", "-m", "fixture");
  writeFileSync(join(root, "big.txt"), Array.from({ length: 20000 }, (_, i) => `line ${i} ${"z".repeat(20)}`).join("\n") + "\n");
  const diff = await readProjectGitDiff(root);
  if (diff.state !== "ready") throw new Error("expected ready");
  expect(diff.truncated).toBe(true); expect(diff.staged).toBe("");
  expect(diff.unstaged.startsWith("diff --git a/big.txt b/big.txt\n")).toBe(true); expect(diff.unstaged.endsWith("\n")).toBe(true);
  expect(serialized(diff.unstaged)).toBeLessThanOrEqual(MAX_GIT_DIFF_SECTION_BYTES);
});

test("huge subprocess output is stopped at the reader buffer, not drained, and reported as truncated", async () => {
  const root = directory();
  // Prints far more than any cap, then stalls: only killing the child returns before the deadline.
  const restore = fakeGit(root, "yes 'diff line' | head -c 50000000\nexec /bin/sleep 10");
  const started = Date.now();
  try {
    const diff = await readProjectGitDiff(root);
    expect(Date.now() - started).toBeLessThan(1500);
    if (diff.state !== "ready") throw new Error("expected ready");
    expect(diff.truncated).toBe(true);
    for (const section of [diff.staged, diff.unstaged]) { expect(section.endsWith("diff line\n")).toBe(true); expect(serialized(section)).toBeLessThanOrEqual(MAX_GIT_DIFF_SECTION_BYTES); }
  } finally { restore(); }
});

test("the shared runner keeps Git status strict: oversized status output still fails instead of truncating", async () => {
  const root = directory();
  const restore = fakeGit(root, "printf '# branch.head main\\0'; yes '? f' | tr '\\n' '\\0' | head -c 400000");
  try { await expect(readProjectGitStatus(root)).rejects.toThrow("Git status unavailable"); }
  finally { restore(); }
});

test("non-repository is distinct from invalid/unavailable projects and stalled Git is killed within the deadline", async () => {
  expect(await readProjectGitDiff(directory())).toEqual({ state: "not-repository" });
  await expect(readProjectGitDiff("relative")).rejects.toThrow();
  await expect(readProjectGitDiff("/not/a/real/project")).rejects.toThrow();
  const root = directory(), restore = fakeGit(root, "exec /bin/sleep 10"), started = Date.now();
  try { await expect(readProjectGitDiff(root)).rejects.toThrow(); expect(Date.now() - started).toBeLessThan(3000); }
  finally { restore(); }
  const failing = directory(), restoreFailing = fakeGit(failing, "echo 'fatal: something else' >&2; exit 2");
  try { await expect(readProjectGitDiff(failing)).rejects.toThrow("Git diff unavailable"); }
  finally { restoreFailing(); }
});

test("the contract validates shape and caps, and worst-case responses fit the peer project limit", () => {
  const worst = ("\u0001".repeat(4095) + "\n").repeat(100);
  const { text } = boundDiffSection(worst, false);
  const diff = parseProjectGitDiff({ state: "ready", staged: text, unstaged: text, truncated: true });
  const envelope = { installationId: "11111111-1111-4111-8111-111111111111", scopeSessionId: "22222222-2222-4222-8222-222222222222", extensionId: "a".repeat(64), diff };
  expect(new TextEncoder().encode(JSON.stringify(envelope)).byteLength).toBeLessThanOrEqual(EXTENSION_PEER_LIMITS.project);
  expect(parseProjectGitDiff({ state: "not-repository", staged: "ignored" })).toEqual({ state: "not-repository" });
  expect(Object.isFrozen(diff)).toBe(true);
  for (const bad of [null, [], {}, { state: "ready", staged: "", unstaged: "" }, { state: "ready", staged: 1, unstaged: "", truncated: false }, { state: "ready", staged: "", unstaged: null, truncated: false }, { state: "ready", staged: "", unstaged: "", truncated: "no" }, { state: "ready", staged: "\u0001".repeat(MAX_GIT_DIFF_SECTION_BYTES / 6), unstaged: "", truncated: false }]) {
    expect(() => parseProjectGitDiff(bad)).toThrow("invalid project Git diff");
  }
});
