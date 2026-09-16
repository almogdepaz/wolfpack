import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

const innerTestPath = join(process.cwd(), "tests", "unit", ".tmp-service-lifecycle-inner.test.ts");

const innerTest = String.raw`import { describe, expect, mock, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const fs = await import("node:fs");
const originalCopyFileSync = fs.copyFileSync;
let failedCopyDestination: string | undefined;
let ttyConsent = false;
let ttyWrites = "";
let trackActivationHealth = false;
await mock.module("node:fs", () => ({
  ...fs,
  copyFileSync: mock((source, destination, mode) => {
    if (destination === failedCopyDestination) throw new Error("fixture server copy failed");
    return originalCopyFileSync(source, destination, mode);
  }),
  openSync: mock(() => {
    if (!ttyConsent) throw new Error("fixture has no controlling tty");
    return 99;
  }),
  readSync: mock((_fd, buffer) => { buffer.write("y"); return 1; }),
  writeSync: mock((_fd, message) => { ttyWrites += String(message); return String(message).length; }),
  closeSync: mock(() => undefined),
}));

const execCommands: string[] = [];
const execFileCalls: Array<{ command: string; args: readonly string[] }> = [];
const askPrompts: string[] = [];
let lingerStatus: string | Error = "yes\n";
let lingerAnswer = "y";
let failLingerElevation = false;
let curlBackendResponse = JSON.stringify({ counts: { broker: 3 } });
let serviceActive = false;
let brokerActive = true;
let failServerStop = false;
let failServerStart = false;
let currentConfig = { devDir: "/tmp/old-dev", port: 18790 };

await mock.module("node:child_process", () => ({
  execFile: mock(() => undefined),
  execFileSync: mock((command: string, args?: string[]) => {
    execFileCalls.push({ command, args: args ?? [] });
    if (command === "sudo" && failLingerElevation) throw new Error("fixture elevation refused");
    if (command === "curl" && args?.some((arg) => arg.includes("/api/backend"))) return curlBackendResponse;
    if (command === "loginctl" && args?.[0] === "show-user") {
      if (lingerStatus instanceof Error) throw lingerStatus;
      return lingerStatus;
    }
    return "";
  }),
  execSync: mock((command: string) => {
    execCommands.push(command);
    if (command === "systemctl --user is-active wolfpack 2>&1") return serviceActive ? "active\n" : "inactive\n";
    if (command === "systemctl --user is-active wolfpack-broker 2>&1") return brokerActive ? "active\n" : "inactive\n";
    if (command === "systemctl --user stop wolfpack" && failServerStop) throw new Error("server stop failed");
    if (command === "systemctl --user stop wolfpack") { serviceActive = false; return ""; }
    if (command === "systemctl --user stop wolfpack-broker") { brokerActive = false; return ""; }
    if (command === "systemctl --user start wolfpack" && failServerStart) throw new Error("server start failed");
    if (command === "systemctl --user start wolfpack" && trackActivationHealth) { serviceActive = true; return ""; }
    if (command === "systemctl --user start wolfpack-broker" && trackActivationHealth) { brokerActive = true; return ""; }
    return "";
  }),
  spawn: mock(() => undefined),
  spawnSync: mock(() => ({ status: 0, stdout: "", stderr: "" })),
}));

await mock.module("../../src/cli/config.js", () => ({
  WOLFPACK_DIR: join(homedir(), ".wolfpack"),
  IS_MACOS: false,
  IS_LINUX: true,
  ask: mock((prompt: string) => {
    askPrompts.push(prompt);
    return lingerAnswer;
  }),
  isPortInUse: mock(() => true),
  killPortHolder: mock(() => undefined),
  loadConfig: mock(() => currentConfig),
  sleepSync: mock(() => undefined),
  waitForPortFree: mock(() => undefined),
}));

const { activatePackageRunnerPair, refreshInstalledServerService, removeManagedEntrypoints, replacePackageRunnerPair, serviceInstall, serviceRestart, serviceStop } = await import("../../src/cli/service.ts");

function systemdLifecycleCommands(): readonly string[] {
  return execCommands.filter(command =>
    command === "systemctl --user daemon-reload"
      || command.startsWith("systemctl --user enable ")
      || command.startsWith("systemctl --user start ")
  );
}

describe.serial("serviceInstall", () => {
  function prepareBroker(): void {
    const brokerBin = join(homedir(), ".wolfpack", "bin", "wolfpack-broker");
    mkdirSync(join(homedir(), ".wolfpack", "bin"), { recursive: true });
    writeFileSync(brokerBin, "broker\\n");
  }

  function setInteractive(value: boolean): void {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
  }

  test("writes and starts the broker before the server on Linux", () => {
    execCommands.length = 0;
    serviceActive = false;
    currentConfig = { devDir: "/tmp/new dev", port: 24444 };
    const serviceDir = join(homedir(), ".config", "systemd", "user");
    const brokerBin = join(homedir(), ".wolfpack", "bin", "wolfpack-broker");
    prepareBroker();

    serviceInstall();

    const brokerUnit = readFileSync(join(serviceDir, "wolfpack-broker.service"), "utf-8");
    const serverUnit = readFileSync(join(serviceDir, "wolfpack.service"), "utf-8");
    expect(brokerUnit).toContain("ExecStart=\"" + brokerBin + "\"");
    expect(serverUnit).toContain("Requires=wolfpack-broker.service");
    expect(systemdLifecycleCommands()).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable wolfpack-broker",
      "systemctl --user start wolfpack-broker",
      "systemctl --user daemon-reload",
      "systemctl --user enable wolfpack",
      "systemctl --user start wolfpack",
    ]);
  });

  test.each([
    ["already enabled", "yes\n", true, "y", false, 0, false, "Linger is already enabled."],
    ["declined", "no\n", true, "n", false, 1, false, "To enable it later:"],
    ["noninteractive", "no\n", false, "y", false, 0, false, "To enable it:"],
    ["query unavailable", new Error("query failed"), false, "y", false, 0, false, "persistence after logout is unverified"],
    ["accepted", "no\n", true, "y", false, 1, true, "Linger enable requested; verify with:"],
    ["elevation failed", "no\n", true, "y", true, 1, true, "Could not enable linger"],
  ] as const)("handles linger safely when %s", (_case, status, interactive, answer, failElevation, promptCount, sudoCalled, detail) => {
    execFileCalls.length = 0;
    askPrompts.length = 0;
    lingerStatus = status;
    lingerAnswer = answer;
    failLingerElevation = failElevation;
    setInteractive(interactive);
    prepareBroker();
    const lines: string[] = [];
    const output = spyOn(process.stdout, "write").mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    try {
      serviceInstall();
    } finally {
      output.mockRestore();
      lingerAnswer = "y";
      failLingerElevation = false;
    }

    expect(execFileCalls).toContainEqual({
      command: "loginctl",
      args: ["show-user", process.env.USER || "", "--property=Linger", "--value"],
    });
    expect(askPrompts).toHaveLength(promptCount);
    expect(execFileCalls.some((call) => call.command === "sudo")).toBe(sudoCalled);
    expect(lines.join("")).toContain(detail);
  });
});

describe.serial("package-runner pair staging", () => {
  test("reconciles both managed binaries from an exact package pair", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-package-pair-"));
    const packageBin = join(root, "node_modules", "wolfpack-bridge-linux-x64");
    const packageServer = join(packageBin, "wolfpack");
    const packageBroker = join(packageBin, "wolfpack-broker");
    const stableDir = join(homedir(), ".wolfpack", "bin");
    const stableServer = join(stableDir, "wolfpack");
    const stableBroker = join(stableDir, "wolfpack-broker");
    try {
      mkdirSync(packageBin, { recursive: true });
      mkdirSync(stableDir, { recursive: true });
      writeFileSync(packageServer, "new server\\n");
      writeFileSync(packageBroker, "new broker\\n");
      chmodSync(packageServer, 0o755);
      chmodSync(packageBroker, 0o755);
      writeFileSync(stableServer, "old server\\n");
      writeFileSync(stableBroker, "old broker\\n");

      const serviceDir = join(homedir(), ".config", "systemd", "user");
      mkdirSync(serviceDir, { recursive: true });
      writeFileSync(join(serviceDir, "wolfpack.service"), "old server descriptor\n");
      writeFileSync(join(serviceDir, "wolfpack-broker.service"), "old broker descriptor\n");
      serviceActive = true;
      brokerActive = true;
      const previousOverride = process.env.WOLFPACK_INSTALL_ALLOW_SESSION_LOSS;
      delete process.env.WOLFPACK_INSTALL_ALLOW_SESSION_LOSS;
      expect(() => replacePackageRunnerPair(packageServer)).toThrow("Refusing unattended broker replacement");
      expect(readFileSync(stableServer, "utf-8")).toBe("old server\\n");
      expect(readFileSync(stableBroker, "utf-8")).toBe("old broker\\n");
      process.env.WOLFPACK_INSTALL_ALLOW_SESSION_LOSS = "1";
      execCommands.length = 0;
      const lines: string[] = [];
      const output = spyOn(process.stdout, "write").mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
      try {
        expect(replacePackageRunnerPair(packageServer)).toEqual({ replaced: true, hadServices: true });
      } finally {
        output.mockRestore();
      }
      expect(lines.join("").match(/Warning: broker-owned sessions will end/g)).toHaveLength(1);
      expect(execCommands).toEqual([
        "systemctl --user is-active wolfpack 2>&1",
        "systemctl --user is-active wolfpack-broker 2>&1",
        "systemctl --user stop wolfpack",
        "systemctl --user stop wolfpack-broker",
        "systemctl --user is-active wolfpack 2>&1",
        "systemctl --user is-active wolfpack-broker 2>&1",
      ]);
      expect(existsSync(join(serviceDir, "wolfpack.service"))).toBe(false);
      expect(existsSync(join(serviceDir, "wolfpack-broker.service"))).toBe(false);
      if (previousOverride === undefined) delete process.env.WOLFPACK_INSTALL_ALLOW_SESSION_LOSS;
      else process.env.WOLFPACK_INSTALL_ALLOW_SESSION_LOSS = previousOverride;
      expect(readFileSync(stableServer, "utf-8")).toBe("new server\\n");
      expect(readFileSync(stableBroker, "utf-8")).toBe("new broker\\n");
      expect(statSync(stableServer).mode & 0o777).toBe(0o755);
      expect(statSync(stableBroker).mode & 0o777).toBe(0o755);
      brokerActive = true;

      const originalExecPath = process.execPath;
      Object.defineProperty(process, "execPath", { configurable: true, value: packageServer });
      try {
        execCommands.length = 0;
        serviceActive = false;
        serviceInstall();
        const serviceDir = join(homedir(), ".config", "systemd", "user");
        expect(readFileSync(join(serviceDir, "wolfpack.service"), "utf-8")).toContain("ExecStart=\"" + stableServer + "\"");
        expect(readFileSync(join(serviceDir, "wolfpack-broker.service"), "utf-8")).toContain("ExecStart=\"" + stableBroker + "\"");
        expect(systemdLifecycleCommands()).toEqual([
          "systemctl --user daemon-reload",
          "systemctl --user enable wolfpack-broker",
          "systemctl --user start wolfpack-broker",
          "systemctl --user daemon-reload",
          "systemctl --user enable wolfpack",
          "systemctl --user start wolfpack",
        ]);
      } finally {
        Object.defineProperty(process, "execPath", { configurable: true, value: originalExecPath });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recreates and health-checks a descriptor-less running pair", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-package-pair-running-"));
    const packageBin = join(root, "node_modules", "wolfpack-bridge-linux-x64");
    const packageServer = join(packageBin, "wolfpack");
    const packageBroker = join(packageBin, "wolfpack-broker");
    const stableDir = join(homedir(), ".wolfpack", "bin");
    const stableServer = join(stableDir, "wolfpack");
    const stableBroker = join(stableDir, "wolfpack-broker");
    const serviceDir = join(homedir(), ".config", "systemd", "user");
    try {
      mkdirSync(packageBin, { recursive: true });
      mkdirSync(stableDir, { recursive: true });
      rmSync(join(serviceDir, "wolfpack.service"), { force: true });
      rmSync(join(serviceDir, "wolfpack-broker.service"), { force: true });
      writeFileSync(packageServer, "new server\\n");
      writeFileSync(packageBroker, "new broker\\n");
      chmodSync(packageServer, 0o755);
      chmodSync(packageBroker, 0o755);
      writeFileSync(stableServer, "old server\\n");
      writeFileSync(stableBroker, "old broker\\n");
      serviceActive = true;
      brokerActive = true;
      process.env.WOLFPACK_INSTALL_ALLOW_SESSION_LOSS = "1";
      trackActivationHealth = true;
      execCommands.length = 0;

      expect(replacePackageRunnerPair(packageServer)).toEqual({ replaced: true, hadServices: true });
      activatePackageRunnerPair();

      expect(serviceActive).toBe(true);
      expect(brokerActive).toBe(true);
      expect(systemdLifecycleCommands()).toEqual(expect.arrayContaining([
        "systemctl --user start wolfpack-broker",
        "systemctl --user start wolfpack",
      ]));
    } finally {
      delete process.env.WOLFPACK_INSTALL_ALLOW_SESSION_LOSS;
      trackActivationHealth = false;
      serviceActive = false;
      brokerActive = true;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prints the package broker-loss consequence once with controlling-TTY consent", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-package-pair-tty-"));
    const packageBin = join(root, "node_modules", "wolfpack-bridge-linux-x64");
    const packageServer = join(packageBin, "wolfpack");
    const packageBroker = join(packageBin, "wolfpack-broker");
    const stableDir = join(homedir(), ".wolfpack", "bin");
    try {
      mkdirSync(packageBin, { recursive: true });
      mkdirSync(stableDir, { recursive: true });
      writeFileSync(packageServer, "new server\\n");
      writeFileSync(packageBroker, "new broker\\n");
      chmodSync(packageServer, 0o755);
      chmodSync(packageBroker, 0o755);
      writeFileSync(join(stableDir, "wolfpack"), "old server\\n");
      writeFileSync(join(stableDir, "wolfpack-broker"), "old broker\\n");
      serviceActive = true;
      brokerActive = true;
      ttyConsent = true;
      ttyWrites = "";
      const lines: string[] = [];
      const output = spyOn(process.stdout, "write").mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
      try {
        replacePackageRunnerPair(packageServer);
      } finally {
        output.mockRestore();
      }
      expect((lines.join("") + ttyWrites).match(/broker-owned sessions will end/gi)).toHaveLength(1);
    } finally {
      ttyConsent = false;
      ttyWrites = "";
      serviceActive = false;
      brokerActive = true;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not normalize a partial matching pair before broker-loss consent", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-package-pair-partial-"));
    const packageBin = join(root, "node_modules", "wolfpack-bridge-linux-x64");
    const packageServer = join(packageBin, "wolfpack");
    const packageBroker = join(packageBin, "wolfpack-broker");
    const stableDir = join(homedir(), ".wolfpack", "bin");
    const stableServer = join(stableDir, "wolfpack");
    const stableBroker = join(stableDir, "wolfpack-broker");
    try {
      mkdirSync(packageBin, { recursive: true });
      mkdirSync(stableDir, { recursive: true });
      writeFileSync(packageServer, "same server\\n");
      writeFileSync(packageBroker, "new broker\\n");
      chmodSync(packageServer, 0o755);
      chmodSync(packageBroker, 0o755);
      writeFileSync(stableServer, "same server\\n");
      writeFileSync(stableBroker, "old broker\\n");
      chmodSync(stableServer, 0o700);
      serviceActive = false;
      brokerActive = true;
      delete process.env.WOLFPACK_INSTALL_ALLOW_SESSION_LOSS;
      execCommands.length = 0;

      expect(() => replacePackageRunnerPair(packageServer)).toThrow("Refusing unattended broker replacement");

      expect(statSync(stableServer).mode & 0o777).toBe(0o700);
      expect(readFileSync(stableServer, "utf-8")).toBe("same server\\n");
      expect(execCommands).not.toContain("systemctl --user stop wolfpack-broker");
    } finally {
      serviceActive = false;
      brokerActive = true;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports broker-only and running service state for an unchanged package pair", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-package-pair-matching-state-"));
    const packageBin = join(root, "node_modules", "wolfpack-bridge-linux-x64");
    const packageServer = join(packageBin, "wolfpack");
    const packageBroker = join(packageBin, "wolfpack-broker");
    const stableDir = join(homedir(), ".wolfpack", "bin");
    const serviceDir = join(homedir(), ".config", "systemd", "user");
    try {
      mkdirSync(packageBin, { recursive: true });
      mkdirSync(stableDir, { recursive: true });
      mkdirSync(serviceDir, { recursive: true });
      writeFileSync(packageServer, "same server\\n");
      writeFileSync(packageBroker, "same broker\\n");
      chmodSync(packageServer, 0o755);
      chmodSync(packageBroker, 0o755);
      writeFileSync(join(stableDir, "wolfpack"), "same server\\n");
      writeFileSync(join(stableDir, "wolfpack-broker"), "same broker\\n");
      chmodSync(join(stableDir, "wolfpack"), 0o755);
      chmodSync(join(stableDir, "wolfpack-broker"), 0o755);
      rmSync(join(serviceDir, "wolfpack.service"), { force: true });
      writeFileSync(join(serviceDir, "wolfpack-broker.service"), "broker descriptor\\n");
      serviceActive = false;
      brokerActive = false;
      execCommands.length = 0;

      expect(replacePackageRunnerPair(packageServer)).toEqual({ replaced: false, hadServices: true });
      expect(execCommands).not.toContain("systemctl --user stop wolfpack");
      expect(execCommands).not.toContain("systemctl --user stop wolfpack-broker");

      rmSync(join(serviceDir, "wolfpack-broker.service"));
      serviceActive = true;
      brokerActive = true;
      execCommands.length = 0;
      expect(replacePackageRunnerPair(packageServer)).toEqual({ replaced: false, hadServices: true });
      expect(execCommands).not.toContain("systemctl --user stop wolfpack");
      expect(execCommands).not.toContain("systemctl --user stop wolfpack-broker");
    } finally {
      serviceActive = false;
      brokerActive = true;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects symlinked matches, repairs regular-file modes without stopping services, and propagates a second copy failure", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-package-pair-integrity-"));
    const packageBin = join(root, "node_modules", "wolfpack-bridge-linux-x64");
    const packageServer = join(packageBin, "wolfpack");
    const packageBroker = join(packageBin, "wolfpack-broker");
    const stableDir = join(homedir(), ".wolfpack", "bin");
    const stableServer = join(stableDir, "wolfpack");
    const stableBroker = join(stableDir, "wolfpack-broker");
    try {
      mkdirSync(packageBin, { recursive: true });
      mkdirSync(stableDir, { recursive: true });
      writeFileSync(packageServer, "new server\\n");
      writeFileSync(packageBroker, "new broker\\n");
      chmodSync(packageServer, 0o755);
      chmodSync(packageBroker, 0o755);
      writeFileSync(stableServer, "new server\\n");
      writeFileSync(stableBroker, "new broker\\n");
      chmodSync(stableServer, 0o700);
      chmodSync(stableBroker, 0o700);
      serviceActive = true;
      brokerActive = true;
      process.env.WOLFPACK_INSTALL_ALLOW_SESSION_LOSS = "1";
      execCommands.length = 0;

      expect(replacePackageRunnerPair(packageServer)).toEqual({ replaced: false, hadServices: true });
      expect(statSync(stableServer).mode & 0o777).toBe(0o755);
      expect(statSync(stableBroker).mode & 0o777).toBe(0o755);
      expect(execCommands).not.toContain("systemctl --user stop wolfpack");
      expect(execCommands).not.toContain("systemctl --user stop wolfpack-broker");

      rmSync(stableServer);
      rmSync(stableBroker);
      symlinkSync(packageServer, stableServer);
      symlinkSync(packageBroker, stableBroker);
      expect(replacePackageRunnerPair(packageServer)).toEqual({ replaced: true, hadServices: true });
      expect(lstatSync(stableServer).isSymbolicLink()).toBe(false);
      expect(lstatSync(stableBroker).isSymbolicLink()).toBe(false);

      writeFileSync(stableServer, "old server\\n");
      writeFileSync(stableBroker, "old broker\\n");
      failedCopyDestination = stableServer;
      serviceActive = false;
      brokerActive = false;
      expect(() => replacePackageRunnerPair(packageServer)).toThrow("fixture server copy failed");
      expect(readFileSync(stableBroker, "utf-8")).toBe("new broker\\n");
      expect(existsSync(stableServer)).toBe(false);
    } finally {
      failedCopyDestination = undefined;
      serviceActive = false;
      brokerActive = true;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stages a newer non-package executable before explicit service installation", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-stable-server-refresh-"));
    const newerServer = join(root, "wolfpack");
    const stableDir = join(homedir(), ".wolfpack", "bin");
    const stableServer = join(stableDir, "wolfpack");
    const stableBroker = join(stableDir, "wolfpack-broker");
    const originalExecPath = process.execPath;
    try {
      mkdirSync(stableDir, { recursive: true });
      writeFileSync(newerServer, "new server\\n");
      chmodSync(newerServer, 0o755);
      writeFileSync(stableServer, "old server\\n");
      writeFileSync(stableBroker, "broker\\n");
      serviceActive = false;
      brokerActive = false;
      Object.defineProperty(process, "execPath", { configurable: true, value: newerServer });

      serviceInstall();

      expect(readFileSync(stableServer, "utf-8")).toBe("new server\\n");
      expect(readFileSync(join(homedir(), ".config", "systemd", "user", "wolfpack.service"), "utf-8"))
        .toContain("ExecStart=\"" + stableServer + "\"");
    } finally {
      Object.defineProperty(process, "execPath", { configurable: true, value: originalExecPath });
      serviceActive = false;
      brokerActive = true;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("removeManagedEntrypoints", () => {
  test("removes only symlinks resolving to the managed binary", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-uninstall-"));
    const managedBinary = join(root, "managed", "wolfpack");
    const managedEntrypoint = join(root, "bin", "wolfpack");
    const foreignBinary = join(root, "foreign", "wolfpack");
    const foreignEntrypoint = join(root, "bin", "foreign-wolfpack");
    try {
      mkdirSync(join(root, "managed"), { recursive: true });
      mkdirSync(join(root, "foreign"), { recursive: true });
      mkdirSync(join(root, "bin"), { recursive: true });
      writeFileSync(managedBinary, "managed\\n");
      writeFileSync(foreignBinary, "foreign\\n");
      symlinkSync(managedBinary, managedEntrypoint);
      symlinkSync(foreignBinary, foreignEntrypoint);

      removeManagedEntrypoints([managedEntrypoint, foreignEntrypoint], managedBinary);

      expect(existsSync(managedEntrypoint)).toBe(false);
      expect(existsSync(foreignEntrypoint)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("refreshInstalledServerService", () => {
  test("rewrites an installed descriptor without activating server or broker when reload is deferred", () => {
    execCommands.length = 0;
    askPrompts.length = 0;
    serviceActive = true;
    currentConfig = { devDir: "/tmp/deferred dev", port: 25555 };
    const unitDir = join(homedir(), ".config", "systemd", "user");
    const unitPath = join(unitDir, "wolfpack.service");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(unitPath, "old unit\n");

    refreshInstalledServerService({ reload: false });

    const unit = readFileSync(unitPath, "utf-8");
    expect(unit).toContain('Environment="WOLFPACK_PORT=25555"');
    expect(unit).toContain('Environment="WOLFPACK_DEV_DIR=/tmp/deferred dev"');
    expect(execCommands).toContain("systemctl --user daemon-reload");
    expect(execCommands).not.toContain("systemctl --user restart wolfpack");
    expect(execCommands.some(command => command.includes("wolfpack-broker"))).toBe(false);
    expect(askPrompts).toEqual([]);
  });

  test("rewrites and restarts only the running server unit", () => {
    execCommands.length = 0;
    askPrompts.length = 0;
    serviceActive = true;
    currentConfig = { devDir: "/tmp/new dev", port: 24444 };
    const unitDir = join(homedir(), ".config", "systemd", "user");
    const unitPath = join(unitDir, "wolfpack.service");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(unitPath, "old unit\n");

    refreshInstalledServerService();

    const unit = readFileSync(unitPath, "utf-8");
    expect(unit).toContain('Environment="WOLFPACK_PORT=24444"');
    expect(unit).toContain('Environment="WOLFPACK_DEV_DIR=/tmp/new dev"');
    expect(execCommands).toContain("systemctl --user daemon-reload");
    expect(execCommands).toContain("systemctl --user restart wolfpack");
    expect(execCommands.some(command => command.includes("wolfpack-broker"))).toBe(false);
    expect(askPrompts).toEqual([]);
  });
});

describe("serviceStop", () => {
  test("attempts broker shutdown when broker-inclusive server stop fails", () => {
    execCommands.length = 0;
    failServerStop = true;

    expect(serviceStop({ broker: true, skipBrokerSessionWarning: true })).toBe(false);

    expect(execCommands).toContain("systemctl --user stop wolfpack");
    expect(execCommands).toContain("systemctl --user stop wolfpack-broker 2>/dev/null");
  });
});

describe("serviceRestart", () => {
  test("returns false without starting the server or touching the broker when server stop fails", () => {
    execCommands.length = 0;
    failServerStop = true;
    failServerStart = false;

    expect(serviceRestart({ broker: false, skipBrokerSessionWarning: true })).toBe(false);

    expect(execCommands).toContain("systemctl --user stop wolfpack");
    expect(execCommands).not.toContain("systemctl --user start wolfpack");
    expect(execCommands.some(command => command.includes("wolfpack-broker"))).toBe(false);
  });

  test("returns false without broker side effects when server start fails", () => {
    execCommands.length = 0;
    failServerStop = false;
    failServerStart = true;

    expect(serviceRestart({ broker: false, skipBrokerSessionWarning: true })).toBe(false);

    expect(execCommands).toContain("systemctl --user stop wolfpack");
    expect(execCommands).toContain("systemctl --user start wolfpack");
    expect(execCommands.filter(command => command.includes("wolfpack-broker"))).toEqual([
      "systemctl --user is-active wolfpack-broker 2>&1",
    ]);
  });

  test("uses one broker prompt that includes active session reset count", () => {
    execCommands.length = 0;
    askPrompts.length = 0;
    failServerStop = false;
    failServerStart = false;
    curlBackendResponse = JSON.stringify({ counts: { broker: 3 } });

    serviceRestart();

    expect(askPrompts).toEqual([
      "  Restart broker too? This will reset 3 active broker sessions. (y/n) ",
    ]);
    expect(execCommands).toContain("systemctl --user stop wolfpack-broker 2>/dev/null");
  });

  test("server-only update restart does not prompt for or stop a running broker", () => {
    execCommands.length = 0;
    askPrompts.length = 0;
    failServerStop = false;
    failServerStart = false;
    curlBackendResponse = JSON.stringify({ counts: { broker: 2 } });

    expect(serviceRestart({ broker: false, skipBrokerSessionWarning: true })).toBe(true);

    expect(askPrompts).toEqual([]);
    expect(execCommands).toContain("systemctl --user stop wolfpack");
    expect(execCommands).not.toContain("systemctl --user stop wolfpack-broker 2>/dev/null");
  });
});
`;

const macInnerTest = String.raw`import { expect, mock, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const execCommands: string[] = [];
await mock.module("node:child_process", () => ({
  execFile: mock(() => undefined),
  execFileSync: mock(() => ""),
  execSync: mock((command: string) => {
    execCommands.push(command);
    // A loaded KeepAlive launchd job can legitimately be between process
    // instances and therefore have no pid in launchctl's output.
    if (command.includes("launchctl print gui/")) return "state = waiting\n";
    return "";
  }),
  spawn: mock(() => undefined),
  spawnSync: mock(() => ({ status: 0, stdout: "", stderr: "" })),
}));

await mock.module("../../src/cli/config.js", () => ({
  WOLFPACK_DIR: join(homedir(), ".wolfpack"),
  IS_MACOS: true,
  IS_LINUX: false,
  ask: mock(() => "y"),
  isPortInUse: mock(() => true),
  killPortHolder: mock(() => undefined),
  loadConfig: mock(() => ({ devDir: "/tmp/new dev", port: 24444 })),
  sleepSync: mock(() => undefined),
  waitForPortFree: mock(() => undefined),
}));

const { refreshInstalledServerService, serviceInstall } = await import("../../src/cli/service.ts");

function launchdLifecycleCommands(): readonly string[] {
  return execCommands.filter(command =>
    command.startsWith("launchctl bootout ")
      || command.startsWith("launchctl bootstrap ")
      || command.startsWith("launchctl kickstart ")
  );
}

test("writes and starts the broker before the server on macOS", () => {
  execCommands.length = 0;
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  const brokerBin = join(homedir(), ".wolfpack", "bin", "wolfpack-broker");
  mkdirSync(join(homedir(), ".wolfpack", "bin"), { recursive: true });
  writeFileSync(brokerBin, "broker\n");

  serviceInstall();

  const brokerPlistPath = join(plistDir, "com.wolfpack.broker.plist");
  const serverPlistPath = join(plistDir, "com.wolfpack.server.plist");
  const brokerPlist = readFileSync(brokerPlistPath, "utf-8");
  const serverPlist = readFileSync(serverPlistPath, "utf-8");
  const domain = "gui/" + process.getuid!();
  expect(brokerPlist).toContain("<string>com.wolfpack.broker</string>");
  expect(brokerPlist).toContain("<string>" + brokerBin + "</string>");
  expect(serverPlist).toContain("<string>com.wolfpack.server</string>");
  expect(launchdLifecycleCommands()).toEqual([
    "launchctl bootout " + domain + "/com.wolfpack.broker 2>/dev/null",
    "launchctl bootstrap " + domain + " \"" + brokerPlistPath + "\"",
    "launchctl kickstart " + domain + "/com.wolfpack.broker",
    "launchctl bootout " + domain + "/com.wolfpack.server 2>/dev/null",
    "launchctl bootstrap " + domain + " \"" + serverPlistPath + "\"",
    "launchctl kickstart " + domain + "/com.wolfpack.server",
  ]);
});

test("re-bootstraps a loaded launchd KeepAlive job even when it has no pid", () => {
  execCommands.length = 0;
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(plistDir, "com.wolfpack.server.plist");
  mkdirSync(plistDir, { recursive: true });
  writeFileSync(plistPath, "old plist\n");

  refreshInstalledServerService();

  expect(readFileSync(plistPath, "utf-8")).toContain("24444");
  expect(execCommands.some(command => command.includes("launchctl bootout gui/") && command.includes("com.wolfpack.server"))).toBe(true);
  expect(execCommands.some(command => command.includes("launchctl bootstrap gui/") && command.includes("com.wolfpack.server.plist"))).toBe(true);
  expect(execCommands.some(command => command.includes("launchctl kickstart gui/") && command.includes("com.wolfpack.server"))).toBe(true);
  expect(execCommands.some(command => command.includes("com.wolfpack.broker"))).toBe(false);
});
`;

describe("service lifecycle", () => {
  test("covers service installation, isolated broker shutdown, and server refresh", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-service-home-"));
    writeFileSync(innerTestPath, innerTest);
    try {
      const output = execFileSync(process.execPath, ["test", innerTestPath], {
        cwd: process.cwd(),
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"],
        env: { ...process.env, HOME: home, USER: "wolfpack_test" },
        timeout: 10_000,
      });
      expect(output).toContain("Wolfpack broker stopped");

      writeFileSync(innerTestPath, macInnerTest);
      execFileSync(process.execPath, ["test", innerTestPath], {
        cwd: process.cwd(),
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"],
        env: { ...process.env, HOME: home, USER: "wolfpack_test" },
        timeout: 10_000,
      });
    } finally {
      rmSync(innerTestPath, { force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 25_000);
});
