import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRalphLog, pruneStaleRalphLock } from "../../src/server/ralph.js";

/**
 * Returns a PID that is known to be dead at call time. Spawns `true`,
 * waits for it to exit, then verifies via `kill(pid, 0)` that the kernel
 * agrees. Avoids the flakiness of hard-coding e.g. `999999`, which becomes
 * a valid PID on hosts with a raised `kernel.pid_max` (large containers /
 * big servers).
 */
function deadPid(): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (Bun as any).spawnSync({ cmd: ["true"] });
  const pid = proc.pid as number;
  // Sanity: kernel must report ESRCH for this PID.
  try {
    process.kill(pid, 0);
    // Still alive (extremely unlikely after spawnSync exit) — fall back
    // to a high PID; better than asserting nothing.
    return pid + 1_000_000;
  } catch {
    return pid;
  }
}

describe("ralph lock pruning", () => {
  test("parseRalphLog is read-only and does not delete stale lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-ralph-lock-"));
    const pid = deadPid();
    try {
      writeFileSync(join(dir, ".ralph.log"), [
        "started: now",
        "project: x",
        `pid: ${pid}`,
      ].join("\n"));
      writeFileSync(join(dir, ".ralph.lock"), `${pid}\n`);

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
    const pid = deadPid();
    try {
      writeFileSync(join(dir, ".ralph.lock"), `${pid}\n`);
      pruneStaleRalphLock(dir, pid);
      expect(existsSync(join(dir, ".ralph.lock"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pruneStaleRalphLock preserves lock when pid is alive", () => {
    // Use our own pid — guaranteed alive while this test runs.
    const dir = mkdtempSync(join(tmpdir(), "wf-ralph-lock-"));
    try {
      writeFileSync(join(dir, ".ralph.lock"), `${process.pid}\n`);
      pruneStaleRalphLock(dir, process.pid);
      expect(existsSync(join(dir, ".ralph.lock"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pruneStaleRalphLock is a no-op when no lock exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-ralph-lock-"));
    try {
      // No lock file present. Must not throw, must not create one.
      expect(() => pruneStaleRalphLock(dir, deadPid())).not.toThrow();
      expect(existsSync(join(dir, ".ralph.lock"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
