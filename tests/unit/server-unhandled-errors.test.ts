import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runChild(mode: string, serviceLog = false, value: "error" | "null" = "error") {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-unhandled-"));
  let fd: number | undefined;
  try {
    const home = join(root, "home"), zdotdir = join(root, "zdotdir");
    mkdirSync(home); mkdirSync(zdotdir);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ZDOTDIR: zdotdir, WOLFPACK_TEST: "1",
      WOLFPACK_JWT_SECRET: "", WOLFPACK_SERVICE: "0", WOLFPACK_LOG_LEVEL: "info",
      WOLFPACK_DIR: join(root, "state"), WOLFPACK_TASK_ROOT: join(root, "tasks"),
      WOLFPACK_TASK_RELAY_ROOT: join(root, "relay"), WOLFPACK_TASK_RELAY_PROFILE: "volatile-v1",
      WOLFPACK_AGENT_RUNTIME_STATE_PATH: join(root, "runtime.json"),
    };
    delete env.ENV; delete env.BASH_ENV;
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
