import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function childFixture() {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-unhandled-"));
  const home = join(root, "home"), zdotdir = join(root, "zdotdir");
  mkdirSync(home); mkdirSync(zdotdir);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ZDOTDIR: zdotdir, WOLFPACK_TEST: "1",
    WOLFPACK_JWT_SECRET: "", WOLFPACK_SERVICE: "0", WOLFPACK_LOG_LEVEL: "info",
    WOLFPACK_DIR: join(root, "state"), WOLFPACK_TASK_ROOT: join(root, "tasks"),
    WOLFPACK_TASK_RELAY_ROOT: join(root, "relay"), WOLFPACK_TASK_RELAY_PROFILE: "volatile-v1",
    WOLFPACK_AGENT_RUNTIME_STATE_PATH: join(root, "runtime.json"),
  };
  delete env.ENV; delete env.BASH_ENV;
  return { root, env };
}

function runChild(mode: string, serviceLog = false, value: "error" | "null" | "closed-stderr" = "error") {
  const { root, env } = childFixture();
  let fd: number | undefined;
  try {
    const logPath = join(root, "wolfpack.log");
    if (serviceLog) fd = openSync(logPath, "w", 0o600);
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "fixtures", "server-unhandled-error.ts"), mode, value], {
      cwd: join(import.meta.dirname, "..", ".."), env, encoding: "utf8", timeout: 10000,
      stdio: fd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", fd, fd],
    });
    return { ...result, log: serviceLog ? readFileSync(logPath, "utf8") : "" };
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
}

async function runChildWithSlowPipe(mode: string, neverDrain = false) {
  const { root, env } = childFixture();
  const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures", "server-unhandled-error.ts"), mode, "large"], {
    cwd: join(import.meta.dirname, "..", ".."), env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  const chunks: Buffer[] = [];
  let resume: ReturnType<typeof setTimeout> | undefined;
  let readyAt: number | undefined;
  let exitAfterReadyMs: number | undefined;
  child.stderr.on("data", chunk => chunks.push(Buffer.from(chunk)));
  child.stderr.pause();
  child.stdout.on("data", chunk => {
    stdout += chunk.toString();
    if (readyAt === undefined && stdout.includes("SERVER_FATAL_PROBE_READY\n")) {
      readyAt = performance.now();
      if (neverDrain) {
        clearTimeout(timeout);
        timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
      } else {
        // Hold a real pipe closed to reads while the child emits >2 MiB.
        resume = setTimeout(() => child.stderr.resume(), 150);
      }
    }
  });
  child.once("exit", () => {
    if (readyAt !== undefined) exitAfterReadyMs = performance.now() - readyAt;
    // Drain only after exit so close/reaping can finish without relieving
    // backpressure while the never-draining producer is alive.
    if (neverDrain) child.stderr.resume();
  });
  let timeout = setTimeout(() => { child.kill("SIGKILL"); child.stderr.resume(); }, 10000);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    return { ...result, stdout, stderr: Buffer.concat(chunks).toString("utf8"), exitAfterReadyMs };
  } finally {
    clearTimeout(timeout);
    clearTimeout(resume);
    rmSync(root, { recursive: true, force: true });
  }
}

function records(output: string): Array<Record<string, unknown>> {
  return output.split("\n").flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

test("importing the server does not install process failure handlers", () => {
  const result = runChild("import-only");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr ?? "").toBe(0);
  const counts = records(result.stdout).find(row => "before" in row)!;
  expect(counts).toBeDefined();
  expect(counts.after).toEqual(counts.before);
});

for (const [mode, message] of [
  ["unhandledRejection", "unhandled rejection"],
  ["uncaughtException", "uncaught exception"],
] as const) {
  test(`${mode} completes a large record through a slow stderr pipe before exit`, async () => {
    const result = await runChildWithSlowPipe(mode);
    expect(result.stdout.split("\n")).toContain("SERVER_FATAL_PROBE_READY");
    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(Buffer.byteLength(result.stderr)).toBeGreaterThan(2 * 1024 * 1024);
    const errors = records(result.stderr).filter(row => row.level === "error" && row.component === "server");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ msg: message, error: "server-fatal-probe-" + mode });
    expect(errors[0]!.stack).toBe("large-stack-start\n" + "é".repeat(1024 * 1024) + "\nlarge-stack-end");
  }, 15000);
  test(`${mode} exits after the two-second write deadline when stderr never drains`, async () => {
    const result = await runChildWithSlowPipe(mode, true);
    expect(result.stdout.split("\n")).toContain("SERVER_FATAL_PROBE_READY");
    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.exitAfterReadyMs).toBeGreaterThanOrEqual(1900);
    expect(result.exitAfterReadyMs).toBeLessThan(3000);
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(2 * 1024 * 1024);
  }, 15000);
  test(`${mode} exits 1 even if stderr is closed`, () => {
    const result = runChild(mode, false, "closed-stderr");
    expect(result.error).toBeUndefined();
    expect(result.stdout.split("\n")).toContain("SERVER_FATAL_PROBE_READY");
    expect(result.status).toBe(1);
  });
  test(`${mode} logs non-Error values and exits 1`, () => {
    const result = runChild(mode, false, "null");
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(records(result.stderr)).toContainEqual(expect.objectContaining({
      level: "error", component: "server", msg: message, error: "null",
    }));
  });
  for (const serviceLog of [false, true]) {
    test(`${mode} logs a structured server error then exits 1 (${serviceLog ? "service log" : "pipes"})`, () => {
      const result = runChild(mode, serviceLog);
      const output = (result.stdout ?? "") + (result.stderr ?? "") + result.log;
      expect(result.error).toBeUndefined();
      expect(output.split("\n")).toContain("SERVER_FATAL_PROBE_READY");
      expect(result.status, output).toBe(1);
      expect(output.split("\n")).not.toContain("SERVER_FATAL_PROBE_CONTINUED");
      const errors = records(serviceLog ? result.log : result.stderr).filter(row => row.level === "error" && row.component === "server");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ msg: message, error: "server-fatal-probe-" + mode });
      expect(errors[0]!.ts).toEqual(expect.any(String));
      expect(errors[0]!.stack).toContain("triggerUnhandledFailure");
      if (!serviceLog) expect(result.stdout).not.toContain("server-fatal-probe-" + mode);
    });
  }
}
