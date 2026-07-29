import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";

const root = process.cwd();
const cliEntry = join(root, "src/cli/index.ts");
const emptyHome = mkdtempSync(join(tmpdir(), "wolfpack-cli-help-empty-"));

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[], env: Readonly<Record<string, string>> = {}): CliResult {
  const child = Bun.spawnSync([process.execPath, cliEntry, ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: emptyHome,
      NO_COLOR: "1",
      WOLFPACK_SERVICE: "1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

afterAll(() => {
  rmSync(emptyHome, { recursive: true, force: true });
});

describe("cli help dispatch", () => {
  for (const alias of [["--help"], ["-h"], ["help"]] as const) {
    test(`top-level ${alias[0]} is side-effect-free and discovers create and spawn`, () => {
      const child = runCli(alias);

      expect(child.exitCode).toBe(0);
      expect(child.stdout).toContain("Usage: wolfpack");
      expect(child.stdout).toContain("wolfpack session create");
      expect(child.stdout).toContain("wolfpack agent spawn");
      for (const command of [
        "setup",
        "service",
        "doctor",
        "list",
        "session",
        "kill",
        "attach",
        "uninstall",
      ]) {
        expect(child.stdout).toContain(command);
      }
      expect(child.stdout).not.toContain("migrate-plan");
      expect(child.stdout).not.toContain("worker");
      expect(child.stdout).not.toContain("Ralph");
      expect(child.stdout).not.toContain("No valid config found");
      expect(child.stdout).not.toContain("Scan to open on your phone");
      expect(child.stderr).toBe("");
    });
  }

  for (const alias of [["session", "--help"], ["session", "-h"], ["session", "help"]] as const) {
    test(`${alias.join(" ")} prints canonical session help`, () => {
      const child = runCli(alias);

      expect(child.exitCode).toBe(0);
      for (const command of ["create", "status", "open", "read", "send", "wait", "prompt", "current-context"]) {
        expect(child.stdout).toContain(`wolfpack session ${command}`);
      }
      expect(child.stdout).not.toContain("No valid config found");
      expect(child.stdout).not.toContain("Scan to open on your phone");
      expect(child.stderr).toBe("");
    });
  }

  for (const args of [["session", "create", "--help"], ["agent", "--help"], ["agent", "spawn", "--help"]] as const) {
    test(`${args.join(" ")} is side-effect-free`, () => {
      const child = runCli(args);
      expect(child.exitCode).toBe(0);
      expect(child.stdout).toContain(args[0] === "agent" ? "wolfpack agent spawn" : "wolfpack session create");
      expect(child.stdout).not.toContain("No valid config found");
      expect(child.stderr).toBe("");
    });
  }

  test("session open help needs no parent context and performs no HTTP request", async () => {
    let requestCount = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        requestCount++;
        return Response.json({ error: "unexpected request" }, { status: 500 });
      },
    });
    const home = mkdtempSync(join(tmpdir(), "wolfpack-cli-open-help-"));
    mkdirSync(join(home, ".wolfpack"), { recursive: true });
    writeFileSync(join(home, ".wolfpack/config.json"), JSON.stringify({
      devDir: root,
      port: server.port,
    }));
    const {
      WOLFPACK_SESSION_NAME: _sessionName,
      WOLFPACK_AGENT_KIND: _agentKind,
      ...envWithoutParent
    } = process.env;

    try {
      const child = Bun.spawn([process.execPath, cliEntry, "session", "open", "--help"], {
        cwd: root,
        env: {
          ...envWithoutParent,
          HOME: home,
          NO_COLOR: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: wolfpack session open <project>");
      expect(stdout).not.toContain("wolfpack session context is missing");
      expect(stderr).toBe("");
      expect(requestCount).toBe(0);
    } finally {
      server.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("non-interactive attach writes an uncolored diagnostic to stderr", () => {
    const child = runCli(["attach"]);

    expect(child.exitCode).not.toBe(0);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("requires an interactive tty");
    expect(child.stderr).not.toContain("\x1b[");
  });

  test("version is side-effect-free and machine-readable", () => {
    const child = runCli(["--version"]);

    expect(child.exitCode).toBe(0);
    expect(child.stdout).toBe(`${pkg.version}\n`);
    expect(child.stderr).toBe("");
  });

  test("unknown top-level commands fail on stderr without starting the dashboard", () => {
    const child = runCli(["definitely-not-a-command"]);

    expect(child.exitCode).not.toBe(0);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("Unknown command: definitely-not-a-command");
    expect(child.stderr).toContain("wolfpack --help");
    expect(child.stderr).not.toContain("\x1b[");
    expect(child.stderr).not.toContain("No valid config found");
    expect(child.stderr).not.toContain("Scan to open on your phone");
  });

  test("only zero arguments select dashboard startup", async () => {
    const cli = await import("../../src/cli/index.ts");

    expect(cli.shouldStartDashboard([])).toBe(true);
    expect(cli.shouldStartDashboard(["--help"])).toBe(false);
    expect(cli.shouldStartDashboard(["unknown"])).toBe(false);
  });
});
