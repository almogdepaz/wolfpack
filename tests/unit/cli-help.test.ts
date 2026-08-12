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

interface DashboardServiceFixture {
  readonly serviceStartThrows: boolean;
  readonly running: readonly boolean[];
}

function runDashboard(fixture: DashboardServiceFixture): CliResult {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-cli-dashboard-"));
  const preloadPath = join(home, "service-fixture.ts");
  mkdirSync(join(home, ".wolfpack"), { recursive: true });
  writeFileSync(join(home, ".wolfpack", "config.json"), JSON.stringify({ devDir: root, port: 18790 }));
  writeFileSync(preloadPath, `
    import { mock } from "bun:test";
    const running = ${JSON.stringify(fixture.running)};
    let runningCall = 0;
    mock.module(${JSON.stringify(join(root, "src", "cli", "service.ts"))}, () => ({
      serviceInstall: () => {},
      serviceUninstall: () => {},
      serviceStop: () => {},
      serviceStart: ${fixture.serviceStartThrows ? '() => { throw new Error("simulated dashboard service start failure"); }' : "() => {}"},
      serviceRestart: () => {},
      serviceStatus: () => {},
      isServiceInstalled: () => true,
      isServiceRunning: () => running[runningCall++] ?? false,
      updateStableBinary: () => false,
      uninstall: () => {},
      generatePlist: () => "",
      generateSystemdUnit: () => "",
    }));
  `);
  const { WOLFPACK_SERVICE: _serviceMode, ...environment } = process.env;
  try {
    const child = Bun.spawnSync([process.execPath, "--preload", preloadPath, cliEntry], {
      cwd: root,
      env: { ...environment, HOME: home, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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

  for (const alias of [["setup", "--help"], ["setup", "-h"], ["setup", "help"]] as const) {
    test(`${alias.join(" ")} is side-effect-free`, () => {
      const child = runCli(alias);

      expect(child.exitCode).toBe(0);
      expect(child.stdout).toContain("Usage: wolfpack setup");
      expect(child.stdout).not.toContain("Checking prerequisites");
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

  test("global machine help is side-effect-free and documents the selector", () => {
    for (const args of [
      ["--machine", "peer", "--help"],
      ["--machine", "peer", "session", "--help"],
      ["--machine", "peer", "session", "status", "--help"],
      ["--machine", "peer", "session", "prompt", "--help"],
      ["--machine", "peer", "agent", "spawn", "--help"],
      ["--machine", "peer", "list", "--help"],
    ]) {
      const child = runCli(args);
      expect(child.exitCode, args.join(" ")).toBe(0);
      expect(child.stdout).toContain("--machine <short-name-or-fqdn>");
      expect(child.stderr).toBe("");
    }
  });

  test("rejects malformed and unsupported global machine combinations before any probe", () => {
    for (const args of [
      ["--machine"],
      ["--machine", "peer", "--machine", "other", "list"],
      ["list", "--machine", "peer"],
      ["session", "send", "local-session", "--machine", "peer"],
      ["session", "send", "local-session", "--machine=peer"],
      ["--machine", "peer", "session", "send", "remote-session", "--machine", "other"],
      ["--machine", "peer", "session", "send", "remote-session", "--machine=other"],
      ["--machine", "peer", "doctor", "--json"],
      ["--machine", "peer", "agent", "notify-parent", "--json"],
      ["--machine", "peer", "session", "current-context", "--json"],
    ]) {
      const child = runCli(args);
      expect(child.exitCode, args.join(" ")).toBe(2);
      expect(child.stderr, args.join(" ")).not.toContain("No valid config found");
    }
  });

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

  test("dashboard service-start diagnostics and retry help use stderr", () => {
    const child = runDashboard({ serviceStartThrows: true, running: [false] });

    expect(child.exitCode).toBe(0);
    expect(child.stdout).toContain("WOLFPACK");
    expect(child.stdout).not.toContain("Service startup failed");
    expect(child.stdout).not.toContain("Wolfpack service is not running");
    expect(child.stderr).toContain("Service startup failed: Error: simulated dashboard service start failure");
    expect(child.stderr).toContain("Run 'wolfpack service install' to retry.");
    expect(child.stderr).toContain("Wolfpack service is not running.");
    expect(child.stderr).toContain("wolfpack service start");
    expect(child.stderr).not.toContain("\x1b[");
  });

  test("dashboard restart warning uses stderr without contaminating dashboard output", () => {
    const child = runDashboard({ serviceStartThrows: false, running: [true, false] });

    expect(child.exitCode).toBe(0);
    expect(child.stdout).toContain("WOLFPACK");
    expect(child.stdout).not.toContain("Service was running but didn't restart.");
    expect(child.stderr).toContain("Service was running but didn't restart.");
    expect(child.stderr).toContain("Run wolfpack service start to restart it.");
    expect(child.stderr).not.toContain("\x1b[");
  });

  test("invalid service usage writes its diagnostic to stderr", () => {
    const child = runCli(["service"]);

    expect(child.exitCode).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("Usage: wolfpack service [install|uninstall|start|stop|restart|status] [--broker]");
    expect(child.stderr).not.toContain("\x1b[");
  });

  test("uninstall refusal writes its diagnostic to stderr", () => {
    const child = runCli(["uninstall"]);

    expect(child.exitCode).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("Refusing to uninstall without confirmation.");
    expect(child.stderr).toContain("This will recursively delete ~/.wolfpack/ (keys, secrets, config).");
    expect(child.stderr).toContain("Re-run with: wolfpack uninstall --yes");
    expect(child.stderr).not.toContain("\x1b[");
  });

  test("only zero arguments select dashboard startup", async () => {
    const cli = await import("../../src/cli/index.ts");

    expect(cli.shouldStartDashboard([])).toBe(true);
    expect(cli.shouldStartDashboard(["--help"])).toBe(false);
    expect(cli.shouldStartDashboard(["unknown"])).toBe(false);
  });
});


describe("setup option parsing", () => {
  test("requires explicit non-interactive mode for unattended overrides", async () => {
    const { parseSetupOptions } = await import("../../src/cli/index.ts");
    expect(parseSetupOptions(["--dev-dir", "/tmp/projects"])).toBeNull();
    expect(parseSetupOptions(["--non-interactive", "--dev-dir", "/tmp/projects", "--port", "19000"])).toEqual({
      nonInteractive: true, devDir: "/tmp/projects", port: 19000,
    });
    expect(parseSetupOptions(["--non-interactive", "--port", "80"])).toBeNull();
  });
});
