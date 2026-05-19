import { describe, expect, test } from "bun:test";
import { parsePorcelainWorktrees } from "../../src/worktree.js";

describe("parsePorcelainWorktrees", () => {
  const PORCELAIN_WITH_NEWLINE = [
    "worktree /repo",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /repo/.worktrees/task-1",
    "HEAD def456",
    "branch refs/heads/ralph/task-1",
    "",
  ].join("\n");

  const PORCELAIN_NO_TRAILING_NEWLINE = [
    "worktree /repo",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /repo/.worktrees/task-1",
    "HEAD def456",
    "branch refs/heads/ralph/task-1",
  ].join("\n");

  test("parses porcelain output with trailing newline", () => {
    const entries = parsePorcelainWorktrees(PORCELAIN_WITH_NEWLINE);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      path: "/repo",
      head: "abc123",
      branch: "main",
      bare: false,
    });
    expect(entries[1]).toEqual({
      path: "/repo/.worktrees/task-1",
      head: "def456",
      branch: "ralph/task-1",
      bare: false,
    });
  });

  test("parses porcelain output WITHOUT trailing newline (ISS-10)", () => {
    const entries = parsePorcelainWorktrees(PORCELAIN_NO_TRAILING_NEWLINE);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({
      path: "/repo/.worktrees/task-1",
      head: "def456",
      branch: "ralph/task-1",
      bare: false,
    });
  });

  test("handles bare worktree", () => {
    const output = "worktree /repo\nHEAD abc123\nbare\n";
    const entries = parsePorcelainWorktrees(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].bare).toBe(true);
    expect(entries[0].branch).toBe("");
  });

  test("handles empty input", () => {
    expect(parsePorcelainWorktrees("")).toEqual([]);
  });

  test("single worktree without trailing newline", () => {
    const output = "worktree /repo\nHEAD abc123\nbranch refs/heads/main";
    const entries = parsePorcelainWorktrees(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("/repo");
  });
});
