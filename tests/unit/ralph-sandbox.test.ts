import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSrtSettings } from "../../src/validation.js";
import { parseRalphLog } from "../../src/server/ralph.js";

describe("buildSrtSettings", () => {
  test("allowWrite contains the resolved working directory", () => {
    const settings = buildSrtSettings("/tmp/my-project");
    expect(settings.filesystem.allowWrite).toContain("/tmp/my-project");
  });

  test("allowWrite always includes /tmp for package manager caches", () => {
    const settings = buildSrtSettings("/home/user/project");
    expect(settings.filesystem.allowWrite).toContain("/tmp");
  });

  test("resolves relative paths to absolute", () => {
    const settings = buildSrtSettings("./relative-dir");
    const expected = resolve("./relative-dir");
    expect(settings.filesystem.allowWrite[0]).toBe(expected);
  });

  test("denyRead blocks sensitive directories", () => {
    const settings = buildSrtSettings("/tmp/test");
    expect(settings.filesystem.denyRead).toContain("~/.ssh");
    expect(settings.filesystem.denyRead).toContain("~/.gnupg");
    expect(settings.filesystem.denyRead).toContain("~/.aws/credentials");
  });

  test("denyWrite blocks env and key files", () => {
    const settings = buildSrtSettings("/tmp/test");
    expect(settings.filesystem.denyWrite).toContain(".env");
    expect(settings.filesystem.denyWrite).toContain(".env.*");
    expect(settings.filesystem.denyWrite).toContain("*.pem");
    expect(settings.filesystem.denyWrite).toContain("*.key");
  });

  test("network allows common package registries", () => {
    const settings = buildSrtSettings("/tmp/test");
    const domains = settings.network.allowedDomains;
    expect(domains).toContain("github.com");
    expect(domains).toContain("registry.npmjs.org");
    expect(domains).toContain("bun.sh");
    expect(domains).toContain("api.anthropic.com");
  });

  test("network disallows local binding", () => {
    const settings = buildSrtSettings("/tmp/test");
    expect(settings.network.allowLocalBinding).toBe(false);
  });

  test("settings structure matches srt schema", () => {
    const settings = buildSrtSettings("/tmp/test");
    // verify top-level keys (ripgrep is optional)
    const keys = Object.keys(settings).sort();
    expect(keys).toContain("filesystem");
    expect(keys).toContain("network");
    // verify network keys
    expect(settings.network).toHaveProperty("allowedDomains");
    expect(settings.network).toHaveProperty("deniedDomains");
    expect(settings.network).toHaveProperty("allowLocalBinding");
    // verify filesystem keys
    expect(settings.filesystem).toHaveProperty("denyRead");
    expect(settings.filesystem).toHaveProperty("allowWrite");
    expect(settings.filesystem).toHaveProperty("denyWrite");
  });

  test("serializes to valid JSON", () => {
    const settings = buildSrtSettings("/tmp/test");
    const json = JSON.stringify(settings, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(settings);
  });
});

describe("parseRalphLog sandbox field", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ralph-sandbox-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("parses sandbox: srt from log header", () => {
    writeFileSync(
      join(tmpDir, ".ralph.log"),
      [
        "🥋 ralph — 5 iterations",
        "agent: claude",
        "plan: PLAN.md",
        "progress: progress.txt",
        "phase_cleanup: on",
        "phase_audit_fix: off",
        "worktree: false",
        "sandbox: srt",
        "pid: 99999",
        "bin: /usr/local/bin/claude",
        "started: Mon Mar 25 2026 10:00:00 GMT-0700",
        "",
      ].join("\n"),
    );
    const status = parseRalphLog(tmpDir);
    expect(status).not.toBeNull();
    expect(status!.sandbox).toBe("srt");
  });

  test("parses sandbox: srt-not-found from log header", () => {
    writeFileSync(
      join(tmpDir, ".ralph.log"),
      [
        "🥋 ralph — 3 iterations",
        "agent: codex",
        "plan: PLAN.md",
        "progress: progress.txt",
        "phase_cleanup: on",
        "phase_audit_fix: off",
        "worktree: false",
        "sandbox: srt-not-found",
        "pid: 99999",
        "bin: /usr/local/bin/codex",
        "started: Mon Mar 25 2026 10:00:00 GMT-0700",
        "",
      ].join("\n"),
    );
    const status = parseRalphLog(tmpDir);
    expect(status).not.toBeNull();
    expect(status!.sandbox).toBe("srt-not-found");
  });

  test("sandbox is empty string when not present in log", () => {
    writeFileSync(
      join(tmpDir, ".ralph.log"),
      [
        "🥋 ralph — 5 iterations",
        "agent: claude",
        "plan: PLAN.md",
        "pid: 99999",
        "started: Mon Mar 25 2026 10:00:00 GMT-0700",
        "",
      ].join("\n"),
    );
    const status = parseRalphLog(tmpDir);
    expect(status).not.toBeNull();
    expect(status!.sandbox).toBe("");
  });

  test("sandbox line excluded from lastOutput", () => {
    writeFileSync(
      join(tmpDir, ".ralph.log"),
      [
        "🥋 ralph — 1 iterations",
        "agent: claude",
        "sandbox: srt",
        "pid: 99999",
        "started: Mon Mar 25 2026 10:00:00 GMT-0700",
        "some actual output here",
        "",
      ].join("\n"),
    );
    const status = parseRalphLog(tmpDir);
    expect(status).not.toBeNull();
    expect(status!.lastOutput).not.toContain("sandbox:");
  });
});
