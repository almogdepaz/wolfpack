import { describe, expect, test } from "bun:test";

// ── Validation functions from serve.ts (not exported, replicated here) ──
// These mirror the exact regex patterns used in serve.ts for input validation.

/** Mirrors serve.ts isValidProjectName() */
function isValidProjectName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

/** Mirrors serve.ts CMD_REGEX */
const CMD_REGEX = /^[a-zA-Z0-9 \-._/=]+$/;

/** Mirrors serve.ts plan file validation (inline in ralph start handler) */
function isValidPlanFile(name: string): boolean {
  return /^[a-zA-Z0-9._\- ]+\.md$/.test(name) && name !== ".." && name !== ".";
}

/** Mirrors serve.ts BRANCH_REGEX (inline in ralph start handler) */
const BRANCH_REGEX = /^[a-zA-Z0-9._\-/]+$/;

// ── isValidProjectName tests ──

describe("isValidProjectName", () => {
  test("accepts simple alphanumeric name", () => {
    expect(isValidProjectName("myproject")).toBe(true);
  });

  test("accepts name with hyphens", () => {
    expect(isValidProjectName("my-project")).toBe(true);
  });

  test("accepts name with dots", () => {
    expect(isValidProjectName("foo.bar")).toBe(true);
  });

  test("accepts name with underscores", () => {
    expect(isValidProjectName("test_123")).toBe(true);
  });

  test("accepts mixed valid chars", () => {
    expect(isValidProjectName("my-project_v2.0")).toBe(true);
  });

  test("accepts single character", () => {
    expect(isValidProjectName("a")).toBe(true);
  });

  test("rejects dot-dot (parent traversal)", () => {
    expect(isValidProjectName("..")).toBe(false);
  });

  test("rejects single dot (current dir)", () => {
    expect(isValidProjectName(".")).toBe(false);
  });

  test("rejects path traversal attempt", () => {
    expect(isValidProjectName("../../etc/passwd")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidProjectName("")).toBe(false);
  });

  test("rejects XSS script tag", () => {
    expect(isValidProjectName("<script>")).toBe(false);
  });

  test("rejects spaces", () => {
    expect(isValidProjectName("my project")).toBe(false);
  });

  test("rejects name with slashes", () => {
    expect(isValidProjectName("foo/bar")).toBe(false);
  });

  test("rejects name with backslash", () => {
    expect(isValidProjectName("foo\\bar")).toBe(false);
  });

  test("rejects name with semicolon (shell injection)", () => {
    expect(isValidProjectName("foo;rm -rf /")).toBe(false);
  });

  test("rejects name with pipe", () => {
    expect(isValidProjectName("foo|bar")).toBe(false);
  });

  test("rejects name with backticks", () => {
    expect(isValidProjectName("`whoami`")).toBe(false);
  });

  test("rejects name with $() command substitution", () => {
    expect(isValidProjectName("$(whoami)")).toBe(false);
  });

  test("rejects newlines", () => {
    expect(isValidProjectName("foo\nbar")).toBe(false);
  });

  test("rejects null bytes", () => {
    expect(isValidProjectName("foo\0bar")).toBe(false);
  });

  test("accepts dotfile-style name", () => {
    expect(isValidProjectName(".hidden")).toBe(true);
  });

  test("accepts name starting with number", () => {
    expect(isValidProjectName("123project")).toBe(true);
  });
});

// ── CMD_REGEX tests ──

describe("CMD_REGEX", () => {
  test("accepts simple command", () => {
    expect(CMD_REGEX.test("npm run build")).toBe(true);
  });

  test("accepts command with path", () => {
    expect(CMD_REGEX.test("node src/index.js")).toBe(true);
  });

  test("accepts command with equals (flags)", () => {
    expect(CMD_REGEX.test("--config=prod")).toBe(true);
  });

  test("accepts command with hyphens", () => {
    expect(CMD_REGEX.test("run-tests --verbose")).toBe(true);
  });

  test("accepts command with dots and underscores", () => {
    expect(CMD_REGEX.test("my_script.sh")).toBe(true);
  });

  test("accepts command with forward slashes", () => {
    expect(CMD_REGEX.test("./bin/start")).toBe(true);
  });

  test("rejects semicolon (command chaining)", () => {
    expect(CMD_REGEX.test("npm test; rm -rf /")).toBe(false);
  });

  test("rejects pipe", () => {
    expect(CMD_REGEX.test("cat file | grep secret")).toBe(false);
  });

  test("rejects ampersand (background/chaining)", () => {
    expect(CMD_REGEX.test("cmd && evil")).toBe(false);
  });

  test("rejects backtick (command substitution)", () => {
    expect(CMD_REGEX.test("`whoami`")).toBe(false);
  });

  test("rejects $() (command substitution)", () => {
    expect(CMD_REGEX.test("$(cat /etc/passwd)")).toBe(false);
  });

  test("rejects redirect >", () => {
    expect(CMD_REGEX.test("echo hi > /tmp/out")).toBe(false);
  });

  test("rejects redirect <", () => {
    expect(CMD_REGEX.test("cmd < /etc/passwd")).toBe(false);
  });

  test("rejects newline (command injection)", () => {
    expect(CMD_REGEX.test("cmd\nrm -rf /")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(CMD_REGEX.test("")).toBe(false);
  });

  test("rejects backslash", () => {
    expect(CMD_REGEX.test("path\\to\\file")).toBe(false);
  });

  test("rejects single quotes", () => {
    expect(CMD_REGEX.test("echo 'hello'")).toBe(false);
  });

  test("rejects double quotes", () => {
    expect(CMD_REGEX.test('echo "hello"')).toBe(false);
  });

  test("rejects exclamation mark", () => {
    expect(CMD_REGEX.test("!command")).toBe(false);
  });
});

// ── Plan file validation tests ──

describe("isValidPlanFile", () => {
  test("accepts simple plan file", () => {
    expect(isValidPlanFile("PLAN.md")).toBe(true);
  });

  test("accepts lowercase md file", () => {
    expect(isValidPlanFile("plan.md")).toBe(true);
  });

  test("accepts plan file with spaces", () => {
    expect(isValidPlanFile("my plan.md")).toBe(true);
  });

  test("accepts plan file with hyphens", () => {
    expect(isValidPlanFile("my-plan.md")).toBe(true);
  });

  test("accepts plan file with underscores", () => {
    expect(isValidPlanFile("my_plan.md")).toBe(true);
  });

  test("accepts plan file with dots in name", () => {
    expect(isValidPlanFile("v2.0.plan.md")).toBe(true);
  });

  test("accepts plan file with numbers", () => {
    expect(isValidPlanFile("plan123.md")).toBe(true);
  });

  test("rejects file not ending in .md", () => {
    expect(isValidPlanFile("plan.txt")).toBe(false);
  });

  test("rejects file with no extension", () => {
    expect(isValidPlanFile("PLAN")).toBe(false);
  });

  test("rejects dot-dot (parent traversal)", () => {
    expect(isValidPlanFile("..")).toBe(false);
  });

  test("rejects path traversal via ../", () => {
    expect(isValidPlanFile("../evil.md")).toBe(false);
  });

  test("rejects path with slashes", () => {
    expect(isValidPlanFile("subdir/plan.md")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidPlanFile("")).toBe(false);
  });

  test("rejects just .md", () => {
    expect(isValidPlanFile(".md")).toBe(false);
  });

  test("rejects shell metacharacters in name", () => {
    expect(isValidPlanFile("$(whoami).md")).toBe(false);
  });

  test("rejects angle brackets", () => {
    expect(isValidPlanFile("<script>.md")).toBe(false);
  });

  test("rejects backticks", () => {
    expect(isValidPlanFile("`cmd`.md")).toBe(false);
  });

  test("rejects semicolons", () => {
    expect(isValidPlanFile("a;b.md")).toBe(false);
  });

  test("rejects pipes", () => {
    expect(isValidPlanFile("a|b.md")).toBe(false);
  });
});

// ── Branch name validation tests ──

describe("BRANCH_REGEX", () => {
  test("accepts simple branch name", () => {
    expect(BRANCH_REGEX.test("main")).toBe(true);
  });

  test("accepts branch with slash (namespaced)", () => {
    expect(BRANCH_REGEX.test("feature/login")).toBe(true);
  });

  test("accepts branch with hyphens", () => {
    expect(BRANCH_REGEX.test("fix-bug-123")).toBe(true);
  });

  test("accepts branch with underscores", () => {
    expect(BRANCH_REGEX.test("feature_new")).toBe(true);
  });

  test("accepts branch with dots", () => {
    expect(BRANCH_REGEX.test("release/v2.0")).toBe(true);
  });

  test("accepts deeply nested branch", () => {
    expect(BRANCH_REGEX.test("user/feature/sub-task")).toBe(true);
  });

  test("accepts numeric branch", () => {
    expect(BRANCH_REGEX.test("123")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(BRANCH_REGEX.test("")).toBe(false);
  });

  test("rejects spaces", () => {
    expect(BRANCH_REGEX.test("my branch")).toBe(false);
  });

  test("rejects shell metacharacters (semicolon)", () => {
    expect(BRANCH_REGEX.test("main;rm -rf /")).toBe(false);
  });

  test("rejects pipe", () => {
    expect(BRANCH_REGEX.test("a|b")).toBe(false);
  });

  test("rejects backticks", () => {
    expect(BRANCH_REGEX.test("`whoami`")).toBe(false);
  });

  test("rejects $() substitution", () => {
    expect(BRANCH_REGEX.test("$(cmd)")).toBe(false);
  });

  test("rejects backslash", () => {
    expect(BRANCH_REGEX.test("a\\b")).toBe(false);
  });

  test("rejects angle brackets", () => {
    expect(BRANCH_REGEX.test("<script>")).toBe(false);
  });

  test("rejects tilde", () => {
    expect(BRANCH_REGEX.test("~user")).toBe(false);
  });

  test("rejects colon", () => {
    expect(BRANCH_REGEX.test("ref:main")).toBe(false);
  });
});
