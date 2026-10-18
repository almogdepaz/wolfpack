import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLoginShellPath } from "../../src/server/login-shell-path.ts";

const base = {
  shell: "/bin/zsh",
  currentPath: "/usr/bin:/bin",
  home: "/home/u",
  exists: (path: string) => path !== "/opt/homebrew/bin",
};

describe("resolveLoginShellPath", () => {
  test("uses the login shell's PATH, with stdin detached and a timeout", () => {
    const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    const result = resolveLoginShellPath({
      ...base,
      run: (file, args, options) => { calls.push({ file, args, options: { ...options } }); return "/a:/b\n"; },
    });
    expect(result).toEqual({ path: "/a:/b", source: "login-shell" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: "/bin/zsh", args: ["-lic", "echo $PATH"] });
    expect(calls[0]!.options).toMatchObject({ timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
  });

  test("falls back with the reason when the login shell exits nonzero", () => {
    const result = resolveLoginShellPath({ ...base, run: () => { throw new Error("Command failed: /bin/zsh -lic echo $PATH"); } });
    expect(result).toEqual({
      path: "/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin",
      source: "fallback",
      reason: "Command failed: /bin/zsh -lic echo $PATH",
    });
  });

  test("falls back when the login shell prints nothing", () => {
    const result = resolveLoginShellPath({ ...base, run: () => "  \n" });
    expect(result).toEqual({ path: "/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin", source: "fallback", reason: "login shell printed an empty PATH" });
  });

  test("does not duplicate fallback dirs already on PATH", () => {
    const result = resolveLoginShellPath({ ...base, currentPath: "/usr/local/bin:/usr/bin", run: () => "" });
    expect(result.path).toBe("/home/u/.local/bin:/usr/local/bin:/usr/bin");
  });

  test("a login shell that hangs is killed at the timeout and falls back", () => {
    const dir = mkdtempSync(join(tmpdir(), "wolfpack-login-shell-"));
    try {
      const shell = join(dir, "slow-shell");
      writeFileSync(shell, "#!/bin/sh\nsleep 10\n");
      chmodSync(shell, 0o755);
      const started = Date.now();
      const result = resolveLoginShellPath({ ...base, shell, timeoutMs: 200 });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result.source).toBe("fallback");
      if (result.source === "fallback") expect(result.reason).toMatch(/ETIMEDOUT|timed out/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
