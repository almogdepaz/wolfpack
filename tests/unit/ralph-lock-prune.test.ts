import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRalphLog, pruneStaleRalphLock } from "../../src/server/ralph.js";

describe("ralph lock pruning", () => {
  test("parseRalphLog is read-only and does not delete stale lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-ralph-lock-"));
    try {
      writeFileSync(join(dir, ".ralph.log"), [
        "started: now",
        "project: x",
        "pid: 999999", // guaranteed dead in test env
      ].join("\n"));
      writeFileSync(join(dir, ".ralph.lock"), "999999\n");

      const status = parseRalphLog(dir);
      expect(status).not.toBeNull();
      expect(status!.active).toBe(false);
      expect(existsSync(join(dir, ".ralph.lock"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pruneStaleRalphLock removes lock for dead pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-ralph-lock-"));
    try {
      writeFileSync(join(dir, ".ralph.lock"), "999999\n");
      pruneStaleRalphLock(dir, 999999);
      expect(existsSync(join(dir, ".ralph.lock"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
