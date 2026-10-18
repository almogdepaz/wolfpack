import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveWolfpackDir } from "../../src/wolfpack-dir.ts";

describe("resolveWolfpackDir", () => {
  test("defaults to ~/.wolfpack when WOLFPACK_DIR is unset, so installed services see unchanged paths", () => {
    expect(resolveWolfpackDir({})).toBe(join(homedir(), ".wolfpack"));
    expect(resolveWolfpackDir({ WOLFPACK_DIR: "" })).toBe(join(homedir(), ".wolfpack"));
    expect(resolveWolfpackDir({ WOLFPACK_DIR: "   " })).toBe(join(homedir(), ".wolfpack"));
  });

  test("uses a trimmed absolute WOLFPACK_DIR", () => {
    expect(resolveWolfpackDir({ WOLFPACK_DIR: " /srv/wolfpack-state " })).toBe("/srv/wolfpack-state");
  });

  test("refuses a relative WOLFPACK_DIR instead of falling back to the real state dir", () => {
    expect(() => resolveWolfpackDir({ WOLFPACK_DIR: "relative/state" })).toThrow("WOLFPACK_DIR must be an absolute path");
    expect(() => resolveWolfpackDir({ WOLFPACK_DIR: "/tmp/a\0b" })).toThrow("WOLFPACK_DIR must be an absolute path");
  });
});
