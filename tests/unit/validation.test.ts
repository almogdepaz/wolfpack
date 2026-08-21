import { describe, expect, test } from "bun:test";
import {
  CMD_REGEX,
  clampCols,
  clampRows,
  isValidPort,
  isValidProjectName,
  isValidSessionName,
  projectLabelToSessionName,
} from "../../src/validation.ts";

describe("isValidSessionName", () => {
  test.each([
    "session",
    "my-session",
    "my_session",
    "Wolfpack2",
    "x",
    "a".repeat(100),
  ])("accepts %p", (name) => {
    expect(isValidSessionName(name)).toBe(true);
  });

  test.each([
    ["empty", ""],
    ["101 chars", "a".repeat(101)],
    ["dot", "foo.bar"],
    ["colon", "foo:bar"],
    ["slash", "foo/bar"],
    ["backslash", "foo\\bar"],
    ["space", "foo bar"],
    ["semicolon", "foo;rm -rf /"],
    ["pipe", "foo|bar"],
    ["ampersand", "foo&bar"],
    ["redirect", "foo>bar"],
    ["quote", "foo'bar"],
    ["double quote", 'foo"bar'],
    ["dollar substitution", "$(whoami)"],
    ["backtick substitution", "`whoami`"],
    ["NUL", "foo\0bar"],
    ["BEL control", "foo\x07bar"],
    ["ANSI escape", "\x1b[31mred\x1b[0m"],
    ["newline", "foo\nbar"],
    ["carriage return", "foo\rbar"],
    ["tab", "foo\tbar"],
    ["unicode emoji", "wolf🐺pack"],
    ["unicode CJK", "テスト"],
    ["unicode RTL override", "\u202Eevil"],
  ])("rejects %s", (_label, name) => {
    expect(isValidSessionName(name)).toBe(false);
  });
});

describe("isValidProjectName", () => {
  test.each([
    "project",
    "my-project",
    "test_123",
    "foo.bar",
    ".hidden",
    "123project",
    "my-project_v2.0",
  ])("accepts %p", (name) => {
    expect(isValidProjectName(name)).toBe(true);
  });

  test.each([
    ["single dot", "."],
    ["dot dot", ".."],
    ["traversal", "../../etc/passwd"],
    ["slash", "foo/bar"],
    ["backslash", "foo\\bar"],
    ["empty", ""],
    ["space", "my project"],
    ["semicolon", "foo;rm -rf /"],
    ["pipe", "foo|bar"],
    ["ampersand", "foo&bar"],
    ["redirect", "foo>bar"],
    ["quote", "foo'bar"],
    ["double quote", 'foo"bar'],
    ["dollar substitution", "$(whoami)"],
    ["backtick substitution", "`whoami`"],
    ["script tag", "<script>"],
    ["newline", "project\nrm -rf /"],
    ["carriage return", "project\revil"],
    ["NUL", "foo\0bar"],
    ["BEL control", "foo\x07bar"],
    ["ANSI escape", "\x1b[31mred\x1b[0m"],
    ["unicode emoji", "wolf🐺pack"],
    ["unicode CJK", "プロジェクト"],
    ["URL-encoded traversal", "..%2F..%2Fetc"],
    ["URL-encoded backslash", "foo%5Cbar"],
  ])("rejects %s", (_label, name) => {
    expect(isValidProjectName(name)).toBe(false);
  });
});

describe("projectLabelToSessionName", () => {
  test.each([
    ["clean", "project_1", "project_1"],
    ["dot becomes underscore", "foo.bar", "foo_bar"],
    ["hostile chars become underscores", "../rm -rf /", "___rm_-rf__"],
    ["unicode becomes underscores", "wolf🐺pack", "wolf__pack"],
    ["empty fallback", "", "project"],
  ])("normalizes %s", (_label, input, expected) => {
    expect(projectLabelToSessionName(input)).toBe(expected);
  });
});

describe("CMD_REGEX", () => {
  test.each([
    "npm run build",
    "node src/index.js",
    "./bin/start --config=prod",
    "claude --dangerously-skip-permissions",
    "my_script.sh --flag=value /tmp/project",
  ])("accepts %p", (command) => {
    expect(CMD_REGEX.test(command)).toBe(true);
  });

  test.each([
    ["empty", ""],
    ["semicolon", "npm test; rm -rf /"],
    ["pipe", "cat file | grep secret"],
    ["ampersand", "cmd && evil"],
    ["backtick", "`whoami`"],
    ["dollar substitution", "$(cat /etc/passwd)"],
    ["redirect out", "echo hi > /tmp/out"],
    ["redirect in", "cmd < /etc/passwd"],
    ["newline", "cmd\nrm -rf /"],
    ["carriage return", "cmd\rrm -rf /"],
    ["backslash", "path\\to\\file"],
    ["single quote", "echo 'hello'"],
    ["double quote", 'echo "hello"'],
    ["exclamation", "!command"],
    ["NUL", "cmd\0evil"],
    ["ANSI escape", "\x1b[31mevil"],
  ])("rejects %s", (_label, command) => {
    expect(CMD_REGEX.test(command)).toBe(false);
  });
});

describe("clampCols / clampRows", () => {
  test.each([
    ["cols inside", clampCols, 120, 120],
    ["cols min", clampCols, 20, 20],
    ["cols max", clampCols, 300, 300],
    ["cols below min", clampCols, 19, 20],
    ["cols above max", clampCols, 301, 300],
    ["cols NaN default", clampCols, NaN, 80],
    ["cols Infinity default", clampCols, Infinity, 80],
    ["cols -Infinity default", clampCols, -Infinity, 80],
    ["rows inside", clampRows, 24, 24],
    ["rows min", clampRows, 5, 5],
    ["rows max", clampRows, 100, 100],
    ["rows below min", clampRows, 4, 5],
    ["rows above max", clampRows, 101, 100],
    ["rows NaN default", clampRows, NaN, 24],
    ["rows Infinity default", clampRows, Infinity, 24],
    ["rows -Infinity default", clampRows, -Infinity, 24],
  ] as const)("%s", (_label, clamp, input, expected) => {
    expect(clamp(input)).toBe(expected);
  });
});

describe("isValidPort", () => {
  test.each([1, 80, 443, 8080, 18790, 65535])("accepts %p", (port) => {
    expect(isValidPort(port)).toBe(true);
  });

  test.each([0, -1, 65536, 18790.5, NaN, Infinity, -Infinity])("rejects %p", (port) => {
    expect(isValidPort(port)).toBe(false);
  });
});
