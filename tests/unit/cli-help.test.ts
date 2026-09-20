import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function runPackageRunnerReadOnlyCli(args: readonly string[]): { readonly result: CliResult; readonly mutated: boolean } {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-cli-package-read-only-"));
  const marker = join(home, "mutated");
  const preloadPath = join(home, "package-runner-fixture.ts");
  writeFileSync(preloadPath, `
    import { mock } from "bun:test";
    import { writeFileSync } from "node:fs";
    Object.defineProperty(process, "execPath", {
      configurable: true,
      value: "/tmp/node_modules/wolfpack-bridge-linux-x64/wolfpack",
    });
    mock.module(${JSON.stringify(join(root, "src", "cli", "service.ts"))}, () => ({
      serviceInstall: () => {},
      serviceUninstall: () => {},
      serviceStop: () => true,
      serviceStart: () => true,
      serviceRestart: () => true,
      serviceStatus: () => {},
      isServiceInstalled: () => false,
      isServiceRunning: () => false,
      isBrokerServiceRunning: () => false,
      isPackageRunnerPairExecutable: () => true,
      replacePackageRunnerPair: () => ({ replaced: false, hadServices: false }),
      activatePackageRunnerPair: () => {},
      activateManagedServicePair: () => {},
      updateStableBinary: () => { writeFileSync(${JSON.stringify(marker)}, "mutated"); return true; },
      uninstall: () => {},
      generatePlist: () => "",
      generateSystemdUnit: () => "",
    }));
  `);
  try {
    const child = Bun.spawnSync([process.execPath, "--preload", preloadPath, cliEntry, ...args], {
      cwd: root,
      env: { ...process.env, HOME: home, NO_COLOR: "1", WOLFPACK_SERVICE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      result: { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() },
      mutated: existsSync(marker),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runMatchingPackageSetupCli(
  serviceInstalled: boolean = true,
  hadServices: boolean = true,
  args: readonly string[] = [],
  packageRunner: boolean = true,
): { readonly result: CliResult; readonly setupOptions: string } {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-cli-package-setup-"));
  const executable = packageRunner
    ? join(home, "node_modules", `wolfpack-bridge-${process.platform}-${process.arch}`, "wolfpack")
    : join(home, ".wolfpack", "bin", "wolfpack");
  const marker = join(home, "setup-options.json");
  const preloadPath = join(home, "matching-package-setup-fixture.ts");
  writeFileSync(preloadPath, `
    import { mock } from "bun:test";
    import { writeFileSync } from "node:fs";
    Object.defineProperty(process, "execPath", { configurable: true, value: ${JSON.stringify(executable)} });
    mock.module(${JSON.stringify(join(root, "src", "cli", "service.ts"))}, () => ({
      serviceInstall: () => { throw new Error("unexpected lifecycle activation"); },
      serviceUninstall: () => {}, serviceStop: () => true, serviceStart: () => true,
      serviceRestart: () => true, serviceStatus: () => {}, isServiceInstalled: () => ${JSON.stringify(serviceInstalled)},
      isServiceRunning: () => true, isBrokerServiceRunning: () => true, isPackageRunnerPairExecutable: () => ${JSON.stringify(packageRunner)},
      replacePackageRunnerPair: () => ({ replaced: false, hadServices: ${JSON.stringify(hadServices)} }),
      activatePackageRunnerPair: () => { throw new Error("unexpected pair activation"); },
      activateManagedServicePair: () => { throw new Error("unexpected lifecycle activation"); },
      updateStableBinary: () => false, uninstall: () => {}, generatePlist: () => "", generateSystemdUnit: () => "",
    }));
    mock.module(${JSON.stringify(join(root, "src", "cli", "setup.ts"))}, () => ({
      assertSetupInteraction: () => true,
      setup: async (options: unknown) => writeFileSync(${JSON.stringify(marker)}, JSON.stringify(options)),
    }));
  `);
  try {
    const child = Bun.spawnSync([process.execPath, "--preload", preloadPath, cliEntry, "setup", ...args], {
      cwd: root,
      env: { ...process.env, HOME: home, NO_COLOR: "1", WOLFPACK_SERVICE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      result: { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() },
      setupOptions: readFileSync(marker, "utf-8"),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runMatchingPackageServiceInstallCli(
  hadServices: boolean,
  serverRunning: boolean,
  brokerRunning: boolean,
  packageRunner: boolean = true,
): { readonly result: CliResult; readonly activation: string | null } {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-cli-package-service-install-"));
  const marker = join(home, "service-install");
  const preloadPath = join(home, "matching-package-service-install-fixture.ts");
  const executable = packageRunner
    ? join(home, "node_modules", `wolfpack-bridge-${process.platform}-${process.arch}`, "wolfpack")
    : join(home, "direct", "wolfpack");
  writeFileSync(preloadPath, `
    import { mock } from "bun:test";
    import { writeFileSync } from "node:fs";
    Object.defineProperty(process, "execPath", { configurable: true, value: ${JSON.stringify(executable)} });
    mock.module(${JSON.stringify(join(root, "src", "cli", "service.ts"))}, () => ({
      serviceInstall: () => writeFileSync(${JSON.stringify(marker)}, "raw"),
      serviceUninstall: () => {}, serviceStop: () => true, serviceStart: () => true,
      serviceRestart: () => true, serviceStatus: () => {}, isServiceInstalled: () => ${JSON.stringify(hadServices)},
      isServiceRunning: () => ${JSON.stringify(serverRunning)},
      isBrokerServiceRunning: () => ${JSON.stringify(brokerRunning)},
      isPackageRunnerPairExecutable: () => ${JSON.stringify(packageRunner)},
      replacePackageRunnerPair: () => ({ replaced: false, hadServices: ${JSON.stringify(hadServices)} }),
      activatePackageRunnerPair: () => writeFileSync(${JSON.stringify(marker)}, "activation"),
      activateManagedServicePair: () => writeFileSync(${JSON.stringify(marker)}, "activation"),
      updateStableBinary: () => false, uninstall: () => {},
      generatePlist: () => "", generateSystemdUnit: () => "",
    }));
  `);
  try {
    const child = Bun.spawnSync([process.execPath, "--preload", preloadPath, cliEntry, "service", "install"], {
      cwd: root,
      env: { ...process.env, HOME: home, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      result: { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() },
      activation: existsSync(marker) ? readFileSync(marker, "utf-8") : null,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runChangedPackageSetupWithRedirectedStreams(
  argv: readonly string[] = ["setup"],
  brokerActiveAtStart: boolean = true,
  installDescriptors: boolean = true,
): {
  readonly result: CliResult;
  readonly commandLog: string;
  readonly stableServer: string | null;
  readonly stableBroker: string | null;
  readonly serverDescriptorExists: boolean;
  readonly brokerDescriptorExists: boolean;
} {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-cli-package-setup-preflight-"));
  const packageBin = join(home, "node_modules", `wolfpack-bridge-${process.platform}-${process.arch}`);
  const packageServer = join(packageBin, "wolfpack");
  const packageBroker = join(packageBin, "wolfpack-broker");
  const stableBin = join(home, ".wolfpack", "bin");
  const stableServerPath = join(stableBin, "wolfpack");
  const stableBrokerPath = join(stableBin, "wolfpack-broker");
  const serviceDir = join(home, ".config", "systemd", "user");
  const serverDescriptor = join(serviceDir, "wolfpack.service");
  const brokerDescriptor = join(serviceDir, "wolfpack-broker.service");
  const commandLog = join(home, "commands.log");
  const preloadPath = join(home, "package-setup-preflight-fixture.ts");
  mkdirSync(packageBin, { recursive: true });
  mkdirSync(stableBin, { recursive: true });
  mkdirSync(serviceDir, { recursive: true });
  writeFileSync(packageServer, "new server\n");
  writeFileSync(packageBroker, "new broker\n");
  chmodSync(packageServer, 0o755);
  chmodSync(packageBroker, 0o755);
  writeFileSync(stableServerPath, "old server\n");
  writeFileSync(stableBrokerPath, "old broker\n");
  if (installDescriptors) {
    writeFileSync(serverDescriptor, "server descriptor\n");
    writeFileSync(brokerDescriptor, "broker descriptor\n");
  }
  writeFileSync(commandLog, "");
  writeFileSync(preloadPath, `
    import { mock } from "bun:test";
    import { appendFileSync } from "node:fs";
    import { join } from "node:path";
    Object.defineProperty(process, "execPath", { configurable: true, value: ${JSON.stringify(packageServer)} });
    let brokerActive = ${JSON.stringify(brokerActiveAtStart)};
    await mock.module("node:child_process", () => ({
      execFile: mock(() => undefined),
      execFileSync: mock(() => ""),
      execSync: mock((command: string) => {
        appendFileSync(${JSON.stringify(commandLog)}, command + "\\n");
        if (command.startsWith("systemctl --user is-active wolfpack-broker")) return brokerActive ? "active\\n" : "inactive\\n";
        if (command.startsWith("systemctl --user is-active wolfpack")) return "inactive\\n";
        if (command.startsWith("systemctl --user stop wolfpack-broker")) brokerActive = false;
        return "";
      }),
      spawn: mock(() => undefined),
      spawnSync: mock(() => ({ status: 0, stdout: "", stderr: "" })),
    }));
    const config = await import(${JSON.stringify(join(root, "src", "cli", "config.ts"))});
    await mock.module(${JSON.stringify(join(root, "src", "cli", "config.ts"))}, () => ({
      ...config,
      WOLFPACK_DIR: join(process.env.HOME!, ".wolfpack"),
      IS_MACOS: false,
      IS_LINUX: true,
      ask: () => "n",
      isPortInUse: () => false,
      killPortHolder: () => undefined,
      loadConfig: () => undefined,
      remoteUrl: () => undefined,
      waitForPortFree: () => undefined,
    }));
  `);
  try {
    const child = Bun.spawnSync([process.execPath, "--preload", preloadPath, cliEntry, ...argv], {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        NO_COLOR: "1",
        WOLFPACK_INSTALL_ALLOW_SESSION_LOSS: "1",
        WOLFPACK_SERVICE: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      result: { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() },
      commandLog: readFileSync(commandLog, "utf-8"),
      stableServer: existsSync(stableServerPath) ? readFileSync(stableServerPath, "utf-8") : null,
      stableBroker: existsSync(stableBrokerPath) ? readFileSync(stableBrokerPath, "utf-8") : null,
      serverDescriptorExists: existsSync(serverDescriptor),
      brokerDescriptorExists: existsSync(brokerDescriptor),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

interface MatchingPackageSetupFixture {
  readonly args: readonly string[];
  readonly serverDescriptor: boolean;
  readonly brokerDescriptor: boolean;
  readonly serverRunning: boolean;
  readonly brokerRunning: boolean;
}

function runMatchingPackageSetupReconciliation(fixture: MatchingPackageSetupFixture): {
  readonly result: CliResult;
  readonly serviceLog: string;
  readonly serverDescriptor: string | null;
} {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-cli-matching-package-setup-"));
  const packageBin = join(home, "node_modules", `wolfpack-bridge-${process.platform}-${process.arch}`);
  const packageServer = join(packageBin, "wolfpack");
  const packageBroker = join(packageBin, "wolfpack-broker");
  const stableBin = join(home, ".wolfpack", "bin");
  const stableServer = join(stableBin, "wolfpack");
  const stableBroker = join(stableBin, "wolfpack-broker");
  const serviceDir = join(home, ".config", "systemd", "user");
  const serverDescriptor = join(serviceDir, "wolfpack.service");
  const serviceLog = join(home, "service.log");
  const bin = join(home, "bin");
  const systemctl = join(bin, "systemctl");
  const preloadPath = join(home, "matching-package-setup-fixture.ts");
  const existingConfig = { devDir: join(home, "Dev"), port: 18790 };
  mkdirSync(packageBin, { recursive: true });
  mkdirSync(stableBin, { recursive: true });
  mkdirSync(serviceDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const path of [packageServer, packageBroker, stableServer, stableBroker]) {
    writeFileSync(path, path.endsWith("broker") ? "broker\n" : "server\n");
    chmodSync(path, 0o755);
  }
  if (fixture.serverDescriptor) writeFileSync(serverDescriptor, "server descriptor\n");
  if (fixture.brokerDescriptor) writeFileSync(join(serviceDir, "wolfpack-broker.service"), "broker descriptor\n");
  writeFileSync(serviceLog, "");
  writeFileSync(systemctl, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(serviceLog)}
case "$*" in
  "--user is-active wolfpack") ${fixture.serverRunning ? "printf 'active\\n'" : "exit 3"} ;;
  "--user is-active wolfpack-broker") ${fixture.brokerRunning ? "printf 'active\\n'" : "exit 3"} ;;
esac
`);
  chmodSync(systemctl, 0o755);
  writeFileSync(preloadPath, `
    import { mock } from "bun:test";
    import { join } from "node:path";
    Object.defineProperty(process, "execPath", { configurable: true, value: ${JSON.stringify(packageServer)} });
    const config = await import(${JSON.stringify(join(root, "src", "cli", "config.ts"))});
    let currentConfig = ${JSON.stringify(existingConfig)};
    await mock.module(${JSON.stringify(join(root, "src", "cli", "config.ts"))}, () => ({
      ...config,
      WOLFPACK_DIR: join(process.env.HOME!, ".wolfpack"),
      IS_MACOS: false,
      IS_LINUX: true,
      ask: () => "n",
      isPortInUse: () => false,
      killPortHolder: () => undefined,
      loadConfig: () => currentConfig,
      saveConfig: (nextConfig) => { currentConfig = nextConfig; },
      remoteUrl: () => null,
      tailscaleBin: () => null,
      waitForPortFree: () => undefined,
    }));
  `);
  try {
    const child = Bun.spawnSync([process.execPath, "--preload", preloadPath, cliEntry, "setup", ...fixture.args], {
      cwd: root,
      env: { ...process.env, HOME: home, NO_COLOR: "1", PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      result: { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() },
      serviceLog: readFileSync(serviceLog, "utf-8"),
      serverDescriptor: existsSync(serverDescriptor) ? readFileSync(serverDescriptor, "utf-8") : null,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runPackageActivationCli(
  args: readonly string[],
  source: "bunx" | "npx",
  failure: "command" | "health",
): CliResult {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-cli-package-activation-"));
  const packageBin = join(home, "node_modules", `wolfpack-bridge-${process.platform}-${process.arch}`);
  const server = join(packageBin, "wolfpack");
  const broker = join(packageBin, "wolfpack-broker");
  const preloadPath = join(home, "package-activation-fixture.ts");
  const bin = join(home, "bin");
  const systemctl = join(bin, "systemctl");
  mkdirSync(bin, { recursive: true });
  writeFileSync(systemctl, `#!/bin/sh
if [ ${JSON.stringify(failure)} = command ] && [ "$1 $2 $3" = "--user start wolfpack" ]; then
  echo "fixture server activation command failed" >&2
  exit 1
fi
if [ "$1 $2" = "--user is-active" ]; then
  echo inactive
fi
`);
  chmodSync(systemctl, 0o755);
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "wolfpack.service"), "server\n");
  writeFileSync(join(home, ".config", "systemd", "user", "wolfpack-broker.service"), "broker\n");
  mkdirSync(packageBin, { recursive: true });
  writeFileSync(server, "server\n");
  writeFileSync(broker, "broker\n");
  chmodSync(server, 0o755);
  chmodSync(broker, 0o755);
  writeFileSync(preloadPath, `
    import { mock } from "bun:test";
    import { join } from "node:path";
    Object.defineProperty(process, "execPath", { configurable: true, value: ${JSON.stringify(server)} });
    process.env.WOLFPACK_PACKAGE_RUNNER = ${JSON.stringify(source)};
    const config = await import(${JSON.stringify(join(root, "src", "cli", "config.ts"))});
    await mock.module(${JSON.stringify(join(root, "src", "cli", "config.ts"))}, () => ({
      ...config,
      WOLFPACK_DIR: join(process.env.HOME!, ".wolfpack"),
      IS_MACOS: false,
      IS_LINUX: true,
      ask: () => "n",
      isPortInUse: () => false,
      killPortHolder: () => undefined,
      loadConfig: () => ({ devDir: "/tmp/projects", port: 18790 }),
      remoteUrl: () => undefined,
      waitForPortFree: () => undefined,
    }));
    await mock.module(${JSON.stringify(join(root, "src", "cli", "setup.ts"))}, () => ({
      assertSetupInteraction: () => true,
      setup: async () => undefined,
    }));
  `);
  try {
    const child = Bun.spawnSync([process.execPath, "--preload", preloadPath, cliEntry, ...args], {
      cwd: root,
      env: { ...process.env, HOME: home, NO_COLOR: "1", PATH: `${bin}:${process.env.PATH ?? ""}` },
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

function runDirectServiceStartCli(): CliResult {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-cli-service-start-"));
  const bin = join(home, "bin");
  const systemctl = join(bin, "systemctl");
  const preloadPath = join(home, "service-start-fixture.ts");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".wolfpack"), { recursive: true });
  writeFileSync(join(home, ".wolfpack", "config.json"), JSON.stringify({ devDir: root, port: 18790 }));
  writeFileSync(systemctl, `#!/bin/sh
if [ "$1 $2 $3" = "--user is-active wolfpack-broker" ]; then
  echo active
  exit 0
fi
if [ "$1 $2 $3" = "--user start wolfpack" ]; then
  echo "fixture direct service start failed" >&2
  exit 1
fi
`);
  chmodSync(systemctl, 0o755);
  writeFileSync(preloadPath, `
    import { mock } from "bun:test";
    import { join } from "node:path";
    const config = await import(${JSON.stringify(join(root, "src", "cli", "config.ts"))});
    await mock.module(${JSON.stringify(join(root, "src", "cli", "config.ts"))}, () => ({
      ...config,
      WOLFPACK_DIR: join(process.env.HOME!, ".wolfpack"),
      IS_MACOS: false,
      IS_LINUX: true,
      isPortInUse: () => false,
      waitForPortFree: () => undefined,
    }));
  `);
  try {
    const child = Bun.spawnSync([process.execPath, "--preload", preloadPath, cliEntry, "service", "start"], {
      cwd: root,
      env: { ...process.env, HOME: home, NO_COLOR: "1", PATH: `${bin}:${process.env.PATH ?? ""}` },
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

interface DashboardServiceFixture {
  readonly serviceStartThrows: boolean;
  readonly running: readonly boolean[];
}

function runServiceRestartCli(serviceRestartResult: boolean): CliResult {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-cli-service-restart-"));
  const preloadPath = join(home, "service-fixture.ts");
  writeFileSync(preloadPath, `
    import { mock } from "bun:test";
    mock.module(${JSON.stringify(join(root, "src", "cli", "service.ts"))}, () => ({
      serviceInstall: () => {},
      serviceUninstall: () => {},
      serviceStop: () => true,
      serviceStart: () => true,
      serviceRestart: () => ${serviceRestartResult},
      serviceStatus: () => {},
      isServiceInstalled: () => true,
      isServiceRunning: () => true,
      isBrokerServiceRunning: () => true,
      isPackageRunnerPairExecutable: () => false,
      replacePackageRunnerPair: () => ({ replaced: false, hadServices: false }),
      activatePackageRunnerPair: () => {},
      activateManagedServicePair: () => {},
      updateStableBinary: () => false,
      uninstall: () => {},
    }));
  `);
  try {
    const child = Bun.spawnSync([
      process.execPath,
      "--preload",
      preloadPath,
      cliEntry,
      "service",
      "restart",
      "--server-only",
    ], {
      cwd: root,
      env: { ...process.env, HOME: home, NO_COLOR: "1", WOLFPACK_SERVICE: "1" },
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
      isBrokerServiceRunning: () => true,
      isPackageRunnerPairExecutable: () => false,
      replacePackageRunnerPair: () => ({ replaced: false, hadServices: false }),
      activatePackageRunnerPair: () => {},
      activateManagedServicePair: () => {},
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
      expect(child.stdout).toContain("--defer-service-restart");
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

  test("package-runner help and version do not reconcile the managed pair", () => {
    for (const args of [["--help"], ["--version"]]) {
      const { result, mutated } = runPackageRunnerReadOnlyCli(args);
      expect(result.exitCode, args.join(" ")).toBe(0);
      expect(mutated, args.join(" ")).toBe(false);
    }
  });

  test("package setup validates redirected interaction before replacement", () => {
    const fixture = runChangedPackageSetupWithRedirectedStreams();

    expect(fixture.result.exitCode).toBe(1);
    expect(fixture.result.stderr).toContain("setup requires a TTY");
    expect(fixture.stableServer).toBe("old server\n");
    expect(fixture.stableBroker).toBe("old broker\n");
    expect(fixture.serverDescriptorExists).toBe(true);
    expect(fixture.brokerDescriptorExists).toBe(true);
    expect(fixture.commandLog).toBe("");
  });

  test("package setup accepts explicit non-interactive mode and bare invocation reaches the real preflight", () => {
    const nonInteractive = runChangedPackageSetupWithRedirectedStreams(["setup", "--non-interactive"], false, false);
    expect(nonInteractive.result.exitCode, nonInteractive.result.stderr).toBe(0);

    const bare = runChangedPackageSetupWithRedirectedStreams([]);
    expect(bare.result.exitCode).toBe(1);
    expect(bare.result.stderr).toContain("setup requires a TTY");
    expect(bare.stableServer).toBe("old server\n");
    expect(bare.stableBroker).toBe("old broker\n");
    expect(bare.serverDescriptorExists).toBe(true);
    expect(bare.brokerDescriptorExists).toBe(true);
    expect(bare.commandLog).toBe("");
  });

  test.each([
    ["stdin", false, true],
    ["stdout", true, false],
  ])("setup interaction requires a TTY on %s", async (missing, stdinTty, stdoutTty) => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdinTty });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdoutTty });
    try {
      const { assertSetupInteraction } = await import("../../src/cli/setup.ts");
      expect(() => assertSetupInteraction({ nonInteractive: false }), `${missing} is not a TTY`).toThrow("setup requires a TTY");
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      else Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });

  test.each([
    [["--non-interactive", "--port", "24444"], 'Environment="WOLFPACK_PORT=24444"'],
    [["--non-interactive", "--dev-dir", "/tmp/changed-dev"], 'Environment="WOLFPACK_DEV_DIR=/tmp/changed-dev"'],
  ] as const)("matching package setup refreshes changed %s server settings without touching the broker", (args, descriptorSetting) => {
    const fixture = runMatchingPackageSetupReconciliation({
      args,
      serverDescriptor: true,
      brokerDescriptor: true,
      serverRunning: true,
      brokerRunning: true,
    });

    expect(fixture.result.exitCode, fixture.result.stderr).toBe(0);
    expect(fixture.serverDescriptor).toContain(descriptorSetting);
    expect(fixture.serviceLog).toContain("--user restart wolfpack");
    expect(fixture.serviceLog).not.toContain("restart wolfpack-broker");
    expect(fixture.result.stdout).toContain("Refreshed installed server service descriptor and reloaded it.");
  });

  test.each([
    [["--non-interactive"], "unchanged settings"],
    [["--non-interactive", "--port", "25555", "--defer-service-restart"], "explicit deferral"],
  ] as const)("matching package setup avoids server lifecycle work for %s", (args, state) => {
    const fixture = runMatchingPackageSetupReconciliation({
      args,
      serverDescriptor: true,
      brokerDescriptor: true,
      serverRunning: true,
      brokerRunning: true,
    });

    expect(fixture.result.exitCode, `${state}: ${fixture.result.stderr}`).toBe(0);
    expect(fixture.serviceLog).not.toContain("--user restart wolfpack");
    expect(fixture.serviceLog).not.toContain("restart wolfpack-broker");
  });

  test.each([
    ["broker-only descriptor", true, false, false, true],
    ["descriptor-less running pair", false, false, true, true],
  ] as const)("matching package setup preserves %s without acquiring a server service", (
    _state,
    brokerDescriptor,
    serverDescriptor,
    serverRunning,
    brokerRunning,
  ) => {
    const fixture = runMatchingPackageSetupReconciliation({
      args: ["--non-interactive", "--port", "25555"],
      serverDescriptor,
      brokerDescriptor,
      serverRunning,
      brokerRunning,
    });

    expect(fixture.result.exitCode, fixture.result.stderr).toBe(0);
    expect(fixture.serverDescriptor).toBeNull();
    expect(fixture.serviceLog).not.toMatch(/--user (daemon-reload|enable|start|restart|stop)/);
  });

  test("matching package service install skips a healthy pair but activates fresh and partial state", () => {
    const healthy = runMatchingPackageServiceInstallCli(true, true, true);
    expect(healthy.result.exitCode, healthy.result.stderr).toBe(0);
    expect(healthy.activation).toBeNull();

    for (const state of [
      [false, false, false],
      [true, false, true],
      [true, true, false],
    ] as const) {
      const partial = runMatchingPackageServiceInstallCli(state[0], state[1], state[2]);
      expect(partial.result.exitCode, partial.result.stderr).toBe(0);
      expect(partial.activation).toBe("activation");
    }
  });

  test("direct service install stays on the ordinary direct-executable path", () => {
    const direct = runMatchingPackageServiceInstallCli(false, false, false, false);

    expect(direct.result.exitCode, direct.result.stderr).toBe(0);
    expect(direct.activation).toBe("raw");
  });

  test.each([
    [[], false],
    [["--defer-service-restart"], true],
  ] as const)("non-package installed-service setup retains explicit defer behavior", (args, deferServiceRestart) => {
    const { result, setupOptions } = runMatchingPackageSetupCli(true, false, args, false);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(setupOptions)).toEqual({
      nonInteractive: false,
      deferServiceRestart,
    });
  });

  test.each([
    [[], "bunx", "command"],
    [["setup"], "npx", "command"],
    [["service", "install"], "bunx", "health"],
    [[], "npx", "health"],
    [["setup"], "bunx", "health"],
    [["service", "install"], "npx", "command"],
  ] as const)("package %s activation failure exits nonzero with the exact %s retry", (args, source, failure) => {
    const child = runPackageActivationCli(args, source, failure);
    const retry = source === "npx"
      ? `npx --yes wolfpack-bridge@${pkg.version} service install`
      : `bunx --bun wolfpack-bridge@${pkg.version} service install`;

    const activationError = failure === "command"
      ? "Failed to start service: Command failed: systemctl --user start wolfpack"
      : "managed service activation did not start both server and broker";
    expect(child.exitCode, `${child.stdout}\n${child.stderr}`).toBe(1);
    expect(`${child.stdout}\n${child.stderr}`).toContain(`Package pair activation failed: ${activationError}`);
    if (failure === "command") expect(`${child.stdout}\n${child.stderr}`).toContain("fixture server activation command failed");
    expect(`${child.stdout}\n${child.stderr}`).toContain(`Reinstall: ${retry}`);
    expect(child.stderr).toContain("Fatal error:");
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

  test("direct service start exits nonzero when activation fails", () => {
    const child = runDirectServiceStartCli();

    expect(child.exitCode, child.stderr).toBe(1);
    expect(child.stdout).toContain("Failed to start service.");
    expect(child.stderr).toContain("fixture direct service start failed");
  });

  test("service restart exits nonzero when the lifecycle reports failure", () => {
    const child = runServiceRestartCli(false);

    expect(child.exitCode).toBe(1);
  });

  test("service help documents the restart-only server option", () => {
    const child = runCli(["service", "--help"]);

    expect(child.exitCode).toBe(0);
    expect(child.stdout).toContain("Usage: wolfpack service [install|uninstall|start|stop|restart|status] [--broker]");
    expect(child.stdout).toContain("wolfpack service restart --server-only");
    expect(child.stderr).toBe("");
  });

  test("invalid service usage writes its diagnostic to stderr", () => {
    const child = runCli(["service"]);

    expect(child.exitCode).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("Usage: wolfpack service [install|uninstall|start|stop|restart|status] [--broker]");
    expect(child.stderr).toContain("wolfpack service restart --server-only");
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
      nonInteractive: true, deferServiceRestart: false, devDir: "/tmp/projects", port: 19000,
    });
    expect(parseSetupOptions(["--defer-service-restart"])).toEqual({
      nonInteractive: false, deferServiceRestart: true,
    });
    expect(parseSetupOptions(["--non-interactive", "--port", "80"])).toBeNull();
  });
});
