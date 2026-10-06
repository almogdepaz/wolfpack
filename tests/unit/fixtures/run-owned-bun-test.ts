import { spawn } from "node:child_process";

export type OwnedBunTestDiagnostic = Readonly<{
  phase: "group-probe";
  code: string | undefined;
  message: string;
}>;

export type OwnedBunTestResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  cleanupDiagnostics: readonly OwnedBunTestDiagnostic[];
}>;

type Completion =
  | Readonly<{ kind: "exit"; code: number | null; signal: NodeJS.Signals | null }>
  | Readonly<{ kind: "spawn-error"; error: Error }>;

export type OwnedBunTestOptions = Readonly<{
  inheritOwnerGroup?: boolean;
  cleanupDelayMsForTests?: number;
  beforeGroupCleanupForTests?: () => Promise<void>;
}>;

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
const monotonicNow = (): number => performance.now();
function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error: any) { if (error?.code === "ESRCH") return false; throw error; }
}
function killGroup(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); }
  catch (error: any) { if (error?.code !== "ESRCH") throw error; }
}
function describe(result: Omit<OwnedBunTestResult, "cleanupDiagnostics">): string {
  return `exit=${result.code} signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return code === undefined ? error.message : `${error.message} [${code}]`;
}
function probeDiagnostic(error: unknown): OwnedBunTestDiagnostic {
  const errno = error as NodeJS.ErrnoException;
  return { phase: "group-probe", code: errno?.code, message: describeError(error) };
}
function recoveredProbeError(diagnostics: readonly OwnedBunTestDiagnostic[]): Error {
  return new Error(`owned Bun test recovered group probe diagnostics: ${diagnostics.map(diagnostic => diagnostic.message).join("; ")}`);
}

/**
 * Runs a Bun test with bounded root handling. Only the top owner detaches and
 * owns a process group. Nested invocations inherit that group: they never make
 * an escaping group and never kill their verifier's group during inner cleanup.
 */
export async function runOwnedBunTest(
  fixture: string,
  deadlineMs: number,
  env: NodeJS.ProcessEnv = process.env,
  options: OwnedBunTestOptions = {},
): Promise<OwnedBunTestResult> {
  const inheritedGroup = options.inheritOwnerGroup === true;
  const successDeadline = monotonicNow() + deadlineMs;
  const child = spawn(process.execPath, ["test", fixture], {
    cwd: process.cwd(), env: { ...env }, stdio: ["ignore", "pipe", "pipe"], detached: !inheritedGroup,
  });
  let stdout = "", stderr = "", rootExited = false;
  child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", chunk => { stdout += chunk; }); child.stderr?.on("data", chunk => { stderr += chunk; });
  const completion = new Promise<Completion>(resolve => {
    child.once("error", error => resolve({ kind: "spawn-error", error }));
    child.once("exit", (code, signal) => { rootExited = true; resolve({ kind: "exit", code, signal }); });
  });
  const terminateAndReap = async (): Promise<readonly OwnedBunTestDiagnostic[]> => {
    const pid = child.pid;
    if (pid === undefined) return [];
    const cleanupErrors: unknown[] = [];
    const probeErrors: unknown[] = [];
    if (!rootExited) {
      try { if (inheritedGroup) child.kill("SIGKILL"); else killGroup(pid); }
      catch (error) { cleanupErrors.push(error); }
      const rootReaped = await Promise.race([completion.then(() => true), delay(1_000).then(() => false)]);
      if (!rootReaped || !rootExited) cleanupErrors.push(new Error(`owned Bun test root did not reap within 1000ms (pid ${pid})`));
    }
    // An inherited child shares its verifier's group. Its verifier's top owner
    // proves that group absent on every terminal path; killing it here would
    // kill the verifier itself.
    if (inheritedGroup) {
      if (options.cleanupDelayMsForTests !== undefined) await delay(options.cleanupDelayMsForTests);
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `owned inherited Bun test cleanup failed (pid ${pid}): ${cleanupErrors.map(describeError).join("; ")}`);
      return [];
    }
    if (options.cleanupDelayMsForTests !== undefined) await delay(options.cleanupDelayMsForTests);
    if (options.beforeGroupCleanupForTests !== undefined) {
      // Test diagnostics run while the resource is deliberately still alive,
      // but cannot delay teardown indefinitely or bypass it on assertion I/O.
      try {
        await Promise.race([
          options.beforeGroupCleanupForTests(),
          delay(100).then(() => { throw new Error("pre-cleanup test hook exceeded 100ms"); }),
        ]);
      } catch (error) { cleanupErrors.push(error); }
    }
    // A failed liveness probe is uncertainty, not absence. Teardown of the
    // known-owned group is independent of probes and ESRCH is the only source
    // confirmation that may recover earlier read-only probe diagnostics.
    try { killGroup(pid); }
    catch (error) { cleanupErrors.push(error); }
    const groupDeadline = monotonicNow() + 1_000;
    let absent = false;
    while (monotonicNow() < groupDeadline) {
      try {
        if (!groupExists(pid)) { absent = true; break; }
      } catch (error) {
        probeErrors.push(error);
      }
      await delay(20);
    }
    if (!absent) cleanupErrors.push(new Error(`owned Bun test process group absence was not confirmed (pgid ${pid})`));
    if (cleanupErrors.length > 0) {
      const errors = [...cleanupErrors, ...probeErrors];
      throw new AggregateError(errors, `owned Bun test group cleanup failed (pgid ${pid}): ${errors.map(describeError).join("; ")}`);
    }
    return probeErrors.map(probeDiagnostic);
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let failure: unknown;
  let outcome: Completion | undefined;
  let cleanupDiagnostics: readonly OwnedBunTestDiagnostic[] = [];
  try {
    // Startup time consumes the same absolute success/lifecycle budget; a
    // timer scheduled after spawn must not grant another full interval.
    const remainingMs = Math.max(0, successDeadline - monotonicNow());
    outcome = await Promise.race([completion, new Promise<undefined>(resolve => { deadline = setTimeout(() => resolve(undefined), remainingMs); })]);
    if (outcome === undefined) throw new Error(`owned Bun test exceeded its ${deadlineMs}ms lifecycle deadline`);
    if (outcome.kind === "spawn-error") throw outcome.error;
    if (outcome.code !== 0 || outcome.signal !== null) throw new Error(describe({ code: outcome.code, signal: outcome.signal, stdout, stderr }));
  } catch (error) { failure = error; }
  finally {
    if (deadline !== undefined) clearTimeout(deadline);
    try { cleanupDiagnostics = await terminateAndReap(); }
    catch (cleanupError) {
      failure = failure === undefined ? cleanupError : new AggregateError(
        [failure, cleanupError],
        `${describeError(failure)}\nowned Bun test group cleanup was not confirmed: ${describeError(cleanupError)}`,
      );
    }
  }
  if (failure === undefined && monotonicNow() > successDeadline) {
    failure = new Error(`owned Bun test exceeded its ${deadlineMs}ms success ceiling during cleanup`);
  }
  if (failure !== undefined && cleanupDiagnostics.length > 0) {
    failure = new AggregateError([failure, recoveredProbeError(cleanupDiagnostics)], `${describeError(failure)}\n${recoveredProbeError(cleanupDiagnostics).message}`);
  }
  if (failure !== undefined) throw failure;
  if (outcome === undefined || outcome.kind !== "exit") throw new Error("owned Bun test completed without an exit outcome");
  return { code: outcome.code, signal: outcome.signal, stdout, stderr, cleanupDiagnostics };
}
