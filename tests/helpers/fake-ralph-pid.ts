/**
 * Test helper: spawn a long-lived stand-in process whose argv[0] contains
 * "ralph-macchio" so `parseRalphLog`'s PID-reuse-safe filter
 * (`isRalphProcessAlive` — issues.md H6 in edc-context/reports/issues.md)
 * treats it as a live ralph worker. Use the returned PID in fixture log
 * lines `pid: ${fakeRalphPid}` instead of `process.pid`, which would (now
 * correctly) be rejected because the bun test runner's argv does not
 * contain "ralph-macchio".
 *
 * Lifecycle: call `startFakeRalph()` from `beforeAll`, store the pid,
 * call `stopFakeRalph()` from `afterAll`. The shell exec replaces argv[0]
 * via `exec -a NAME sleep`, then we pgrep for it (the spawn handle points
 * at the wrapper shell, not the sleep child).
 */
import { execFileSync } from "node:child_process";

export interface FakeRalph {
  pid: number;
  proc: ReturnType<typeof Bun.spawn> | null;
}

export function startFakeRalph(): FakeRalph {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let pid = process.pid; // safe fallback; tests will fail loudly rather than silently
  try {
    proc = Bun.spawn({
      cmd: ["/bin/sh", "-c", `exec -a "ralph-macchio worker" sleep 3600`],
      stdout: "ignore",
      stderr: "ignore",
    });
    // The Bun.spawn handle is the shell pid; the actual sleep is a child.
    // pgrep so isRalphProcessAlive() (which inspects ps cmdline) sees the
    // right argv. Brief busy-wait — exec is near-instant.
    const start = Date.now();
    while (Date.now() - start < 1000) {
      try {
        const out = execFileSync("pgrep", ["-f", "ralph-macchio worker"], { encoding: "utf-8" });
        const found = Number(out.trim().split("\n")[0]);
        if (Number.isFinite(found) && found > 1) { pid = found; break; }
      } catch { /* not yet visible */ }
      Bun.sleepSync(20);
    }
  } catch { /* leave pid = process.pid — affected tests will fail */ }
  return { pid, proc };
}

export function stopFakeRalph(handle: FakeRalph): void {
  try { if (handle.pid !== process.pid) process.kill(handle.pid, "SIGKILL"); } catch { /* gone */ }
  try { handle.proc?.kill("SIGKILL"); } catch { /* gone */ }
}
