import { describe, expect, test } from "bun:test";

// ── Validation functions from serve.ts (not exported, replicated here) ──
// These mirror the exact regex patterns used in serve.ts for input validation.

/** Mirrors serve.ts isValidProjectName() */
function isValidProjectName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

/** Mirrors serve.ts CMD_REGEX */
const CMD_REGEX = /^[a-zA-Z0-9 \-._/=]+$/;

/** Mirrors validation.ts isValidSessionName() — no dots or colons (tmux restriction) */
function isValidSessionName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0 && name.length <= 100;
}

// ── isValidSessionName tests ──

describe("isValidSessionName", () => {
  test("accepts simple name", () => {
    expect(isValidSessionName("my-session")).toBe(true);
  });

  test("accepts underscores", () => {
    expect(isValidSessionName("my_session")).toBe(true);
  });

  test("accepts numbers", () => {
    expect(isValidSessionName("wolfpack-2")).toBe(true);
  });

  test("accepts uppercase", () => {
    expect(isValidSessionName("MySession")).toBe(true);
  });

  test("rejects dots (tmux restriction)", () => {
    expect(isValidSessionName("foo.bar")).toBe(false);
  });

  test("rejects colons (tmux restriction)", () => {
    expect(isValidSessionName("foo:bar")).toBe(false);
  });

  test("rejects spaces", () => {
    expect(isValidSessionName("my session")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidSessionName("")).toBe(false);
  });

  test("rejects slashes", () => {
    expect(isValidSessionName("foo/bar")).toBe(false);
  });

  test("rejects shell injection", () => {
    expect(isValidSessionName("foo;rm -rf /")).toBe(false);
  });

  test("rejects names over 100 chars", () => {
    expect(isValidSessionName("a".repeat(101))).toBe(false);
  });

  test("accepts names at 100 chars", () => {
    expect(isValidSessionName("a".repeat(100))).toBe(true);
  });
});

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
