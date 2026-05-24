/**
 * Process tree cleanup utilities.
 * Sends SIGTERM, polls for exit, escalates to SIGKILL.
 */

import { spawnSync, execFileSync } from "node:child_process";

const POLL_INTERVAL_MS = 200;

/** Inline JSON warn to avoid circular dep with log.ts (which re-exports errMsg from here). */
function _warn(msg: string, extra?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level: "warn", component: "pty", msg, ...extra };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

/** Extract a human-readable message from an unknown catch value. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch { /* expected: kill(0) throws ESRCH when process is dead */
    return false;
  }
}

const testRalphProcessPids = new Set<number>();

export function __registerTestRalphProcess(pid: number): () => void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__registerTestRalphProcess() is only available in test mode");
  testRalphProcessPids.add(pid);
  return () => { testRalphProcessPids.delete(pid); };
}

/**
 * PID-reuse-safe liveness check for a ralph worker. `kill(pid, 0)` alone
 * returns true for ANY process at that PID, so a recycled PID (the OS
 * reusing the slot for an unrelated process after the ralph worker
 * exited) would make parseRalphLog report `active: true` for a dead loop.
 *
 * Uses `ps -o command=` to confirm the process at `pid` is actually a
 * ralph-macchio worker. Returns false on:
 *   - ESRCH (process is gone)
 *   - ps fails / times out
 *   - cmdline does not contain "ralph-macchio" or "worker"
 *
 * Sync (intentionally) so it can be used from `parseRalphLog` which is
 * called from sync read paths. Keep callers low-frequency — each
 * invocation forks `ps`.
 */
export function isRalphProcessAlive(pid: number): boolean {
  if (pid <= 1 || !isProcessAlive(pid)) return false;
  if (process.env.WOLFPACK_TEST && testRalphProcessPids.has(pid)) return true;
  try {
    const cmdline = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 3000,
    });
    return cmdline.includes("ralph-macchio") || cmdline.includes("worker");
  } catch { /* ps failed or process exited between kill(0) and ps */
    return false;
  }
}

/**
 * Kill a process. SIGTERM first, SIGKILL after timeout.
 * Resolves once the process is confirmed dead (or timeout+SIGKILL).
 */
export async function killProcessTree(
  pid: number,
  timeoutMs = 5000,
): Promise<void> {
  // Send SIGTERM to individual pid
  try { process.kill(pid, "SIGTERM"); } catch (e) { _warn("killProcessTree: SIGTERM to pid failed", { pid, error: errMsg(e) }); }

  // Poll until dead or timeout
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Escalate to SIGKILL
  try { process.kill(pid, "SIGKILL"); } catch (e) { _warn("killProcessTree: SIGKILL to pid failed", { pid, error: errMsg(e) }); }

  // Brief wait for SIGKILL to take effect
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}

/**
 * Synchronous best-effort kill for use in signal handlers where async won't complete.
 * Sends SIGTERM to pid, waits briefly for graceful shutdown, then SIGKILL.
 * Uses spawnSync sleep so the child's SIGTERM handler gets ~500ms to run.
 */
export function killProcessTreeSync(pid: number): void {
  try { process.kill(pid, "SIGTERM"); } catch { /* best effort */ }
  // Give child's SIGTERM handler a moment before escalating
  try { spawnSync("sleep", ["0.5"]); } catch { /* best effort */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* best effort */ }
}
