import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitPorcelain, readProjectGitStatus } from "../../src/server/project-git-status.ts";
import { parseProjectGitStatus } from "../../src/extensions/git-status-contract.ts";

const roots: string[] = [];
function directory() { const root = mkdtempSync(join(tmpdir(), "wolfpack-git-status-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0); return result.stdout.toString();
}
const ordinary = (xy: string, path: string) => `1 ${xy} N... 100644 100644 100644 abc def ${path}\0`;
test("porcelain handles staged+unstaged, literal paths, rename pairs, conflicts and detached HEAD", () => {
  const status = parseGitPorcelain("# branch.oid abc\0# branch.head (detached)\0" + ordinary("MM", "space\tand\n<img>.ts") + "2 R. N... 100644 100644 100644 abc def R100 new -> name\0old name\0" + "u UU N... 100644 100644 100644 100644 a b c conflict\0? untracked/\0");
  expect(status).toMatchObject({ state: "ready", branch: null, detached: true, truncated: false, staged: [{ path: "space\tand\n<img>.ts", status: "modified" }, { path: "new -> name", previousPath: "old name", status: "renamed" }, { path: "conflict", status: "unmerged" }], unstaged: [{ path: "space\tand\n<img>.ts", status: "modified" }, { path: "conflict", status: "unmerged" }], untracked: [{ path: "untracked/", status: "untracked" }] });
});
test("bounded prefixes cannot appear clean; malformed/oversized data fails closed", () => {
  const status = parseGitPorcelain("# branch.head main\0" + Array.from({ length: 201 }, (_, i) => `? file-${i}\0`).join(""));
  expect(status).toMatchObject({ truncated: true }); if (status.state === "ready") expect(status.untracked).toHaveLength(200);
  for (const bad of ["# branch.head main", "? file\0", "# branch.head main\0garbage\0", "# branch.head main\0" + ordinary("ZZ", "bad"), "x".repeat(262145)]) expect(() => parseGitPorcelain(bad)).toThrow();
  expect(() => parseProjectGitStatus({ ...status, untracked: [{ path: "\0", status: "untracked" }] })).toThrow();
});
test("real Git reports unborn/clean/dirty states without changing index or running filters/fsmonitor", async () => {
  const root = directory(); git(root, "init", "--initial-branch=main");
  expect(await readProjectGitStatus(root)).toMatchObject({ state: "ready", branch: "main", staged: [], unstaged: [], untracked: [] });
  writeFileSync(join(root, ".gitattributes"), "*.txt filter=hostile\n"); writeFileSync(join(root, "tracked.txt"), "initial\n");
  git(root, "add", "."); git(root, "commit", "-m", "fixture");
  git(root, "config", "core.fsmonitor", "touch SHOULD_NOT_EXIST");
  git(root, "config", "filter.hostile.clean", "touch SHOULD_NOT_EXIST; cat");
  git(root, "config", "filter.hostile.process", "touch SHOULD_NOT_EXIST; cat");
  git(root, "config", "filter.hostile.required", "true");
  writeFileSync(join(root, "tracked.txt"), "changed content\n"); writeFileSync(join(root, "new <file>.ts"), "x");
  const before = readFileSync(join(root, ".git", "index"));
  const old = process.env.GIT_DIR; process.env.GIT_DIR = "/does-not-exist";
  try { expect(await readProjectGitStatus(root)).toMatchObject({ branch: "main", staged: [], unstaged: [{ path: "tracked.txt", status: "modified" }], untracked: [{ path: "new <file>.ts", status: "untracked" }] }); }
  finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
  expect(readFileSync(join(root, ".git", "index"))).toEqual(before);
  expect(existsSync(join(root, "SHOULD_NOT_EXIST"))).toBe(false); expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
});
test("non-repository is distinct from invalid/unavailable project", async () => {
  expect(await readProjectGitStatus(directory())).toEqual({ state: "not-repository" });
  await expect(readProjectGitStatus("relative")).rejects.toThrow();
  await expect(readProjectGitStatus("/not/a/real/project")).rejects.toThrow();
});
test("a stalled Git subprocess is killed within the overall deadline", async () => {
  const root = directory(); const executable = join(root, "git");
  writeFileSync(executable, '#!/bin/sh\ncase "$*" in *config*) exit 1;; esac\nexec /bin/sleep 10\n'); chmodSync(executable, 0o755);
  const path = process.env.PATH; process.env.PATH = `${root}:${path}`;
  const started = Date.now();
  try { await expect(readProjectGitStatus(root)).rejects.toThrow(); expect(Date.now() - started).toBeLessThan(3000); }
  finally { process.env.PATH = path; }
});
