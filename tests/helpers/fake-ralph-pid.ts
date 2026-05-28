/**
 * Test helper: spawn a long-lived stand-in process whose argv[0] contains
 * "ralph-macchio" so `parseRalphLog`'s PID-reuse-safe filter
 * (`isRalphProcessAlive`) treats it as a live ralph worker. Use the
 * returned PID in fixture log lines `pid: ${fakeRalphPid}` instead of
 * `process.pid`, which would (correctly) be rejected because the bun test
 * runner's argv does not contain "ralph-macchio".
 *
 * Lifecycle: call `startFakeRalph()` from `beforeAll`, store the pid,
 * call `stopFakeRalph()` from `afterAll`. The shell exec replaces argv[0]
 * via `exec -a NAME sleep`, then we pgrep for it (the spawn handle points
 * at the wrapper shell, not the sleep child).
 */
import { execFileSync } from "node:child_process";
import { __registerTestRalphProcess } from "../../src/test-hooks.js";

export interface FakeRalph {
  pid: number;
  proc: ReturnType<typeof Bun.spawn> | null;
  unregister: (() => void) | null;
  prevWolfpackTest: string | undefined;
}

export function startFakeRalph(): FakeRalph {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let unregister: (() => void) | null = null;
  const prevWolfpackTest = process.env.WOLFPACK_TEST;
  let pid = process.pid; // safe fallback; tests will fail loudly rather than silently
  try {
    // Use /bin/bash explicitly: `exec -a NAME` is a bash builtin, NOT in
    // POSIX sh. On most Linux distros /bin/sh → dash which silently
    // ignores `-a NAME` and exec's `sleep 3600` with its own argv — the
    // pgrep below would then never match "ralph-macchio worker" and
    // every dependent test would fail.
    proc = Bun.spawn({
      cmd: ["/bin/bash", "-c", `exec -a "ralph-macchio worker" sleep 3600`],
      stdout: "ignore",
      stderr: "ignore",
    });
    if (proc.pid && proc.pid > 1) pid = proc.pid;
    // The Bun.spawn handle is the shell pid; the actual sleep is a child.
    // pgrep so isRalphProcessAlive() (which inspects ps cmdline) sees the
    // right argv. Brief busy-wait — exec is near-instant.
    const start = Date.now();
    while (Date.now() - start < 1000) {
      try {
        const out = execFileSync("pgrep", ["-f", "ralph-macchio worker"], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const found = Number(out.trim().split("\n")[0]);
        if (Number.isFinite(found) && found > 1) { pid = found; break; }
      } catch { /* not yet visible */ }
      Bun.sleepSync(20);
    }
  } catch { /* leave pid = process.pid — affected tests will fail */ }
  if (proc && pid !== process.pid) {
    process.env.WOLFPACK_TEST = "1";
    unregister = __registerTestRalphProcess(pid);
  }
  return { pid, proc, unregister, prevWolfpackTest };
}

export function stopFakeRalph(handle: FakeRalph): void {
  try { handle.unregister?.(); } catch { /* gone */ }
  if (handle.prevWolfpackTest === undefined) delete process.env.WOLFPACK_TEST;
  else process.env.WOLFPACK_TEST = handle.prevWolfpackTest;
  try { if (handle.pid !== process.pid) process.kill(handle.pid, "SIGKILL"); } catch { /* gone */ }
  try { handle.proc?.kill("SIGKILL"); } catch { /* gone */ }
}
