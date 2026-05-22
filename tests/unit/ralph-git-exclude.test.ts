import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { ensureRalphTransientGitExcludes } from "../../src/ralph-git-exclude.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("ensureRalphTransientGitExcludes", () => {
  test("excludes runner-owned transient files from git add -A", () => {
    const repo = mkdtempSync(join(tmpdir(), "ralph-git-exclude-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "README.md"), "init\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);

    ensureRalphTransientGitExcludes(repo, "progress.txt");

    writeFileSync(join(repo, ".ralph-response.json"), "{}\n");
    writeFileSync(join(repo, ".ralph-response-schema-123.json"), "{}\n");
    writeFileSync(join(repo, ".ralph-srt-settings-123.json"), "{}\n");
    writeFileSync(join(repo, ".ralph.log"), "log\n");
    writeFileSync(join(repo, "progress.txt"), "# Progress Log\n");
    writeFileSync(join(repo, "feature.ts"), "export const ok = true;\n");

    git(repo, ["add", "-A"]);
    const staged = git(repo, ["diff", "--cached", "--name-only"]);

    expect(staged).toContain("feature.ts");
    expect(staged).not.toContain(".ralph-response.json");
    expect(staged).not.toContain(".ralph-response-schema-123.json");
    expect(staged).not.toContain(".ralph-srt-settings-123.json");
    expect(staged).not.toContain(".ralph.log");
    expect(staged).not.toContain("progress.txt");

    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf-8");
    expect(exclude).toContain("# ralph transient files");
    expect(exclude).toContain(".ralph-response.json");
    expect(exclude).toContain("progress.txt");
  });

  test("is a no-op outside git repositories", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-no-git-"));
    mkdirSync(join(dir, "sub"));
    expect(() => ensureRalphTransientGitExcludes(join(dir, "sub"), "progress.txt")).not.toThrow();
  });
});
