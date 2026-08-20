import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

const innerTestPath = join(process.cwd(), "tests", "unit", ".tmp-service-lifecycle-inner.test.ts");

const innerTest = String.raw`import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const execCommands: string[] = [];
const askPrompts: string[] = [];
let curlBackendResponse = JSON.stringify({ counts: { broker: 3 } });
let serviceActive = false;
let currentConfig = { devDir: "/tmp/old-dev", port: 18790 };

await mock.module("node:child_process", () => ({
  execFile: mock(() => undefined),
  execFileSync: mock((command: string, args?: string[]) => {
    if (command === "curl" && args?.some((arg) => arg.includes("/api/backend"))) return curlBackendResponse;
    return "";
  }),
  execSync: mock((command: string) => {
    execCommands.push(command);
    if (command === "systemctl --user is-active wolfpack 2>&1") return serviceActive ? "active\n" : "inactive\n";
    if (command === "systemctl --user stop wolfpack") {
      throw new Error("server unit missing");
    }
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
    return "y";
  }),
  isPortInUse: mock(() => true),
  killPortHolder: mock(() => undefined),
  loadConfig: mock(() => currentConfig),
  sleepSync: mock(() => undefined),
  waitForPortFree: mock(() => undefined),
}));

const { refreshInstalledServerService, removeManagedEntrypoints, serviceInstall, serviceRestart, serviceStop } = await import("../../src/cli/service.ts");

function systemdLifecycleCommands(): readonly string[] {
  return execCommands.filter(command =>
    command === "systemctl --user daemon-reload"
      || command.startsWith("systemctl --user enable ")
      || command.startsWith("systemctl --user start ")
  );
}

describe("serviceInstall", () => {
  test("writes and starts the broker before the server on Linux", () => {
    execCommands.length = 0;
    serviceActive = false;
    currentConfig = { devDir: "/tmp/new dev", port: 24444 };
    const serviceDir = join(homedir(), ".config", "systemd", "user");
    const brokerBin = join(homedir(), ".wolfpack", "bin", "wolfpack-broker");
    mkdirSync(join(homedir(), ".wolfpack", "bin"), { recursive: true });
    writeFileSync(brokerBin, "broker\n");

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

    expect(serviceStop({ broker: true, skipBrokerSessionWarning: true })).toBe(false);

    expect(execCommands).toContain("systemctl --user stop wolfpack");
    expect(execCommands).toContain("systemctl --user stop wolfpack-broker 2>/dev/null");
  });
});

describe("serviceRestart", () => {
  test("uses one broker prompt that includes active session reset count", () => {
    execCommands.length = 0;
    askPrompts.length = 0;
    curlBackendResponse = JSON.stringify({ counts: { broker: 3 } });

    serviceRestart();

    expect(askPrompts).toEqual([
      "  Restart broker too? This will reset 3 active broker sessions. (y/n) ",
    ]);
    expect(execCommands).toContain("systemctl --user stop wolfpack-broker 2>/dev/null");
  });

  test("server-only update restart does not prompt for or stop the broker", () => {
    execCommands.length = 0;
    askPrompts.length = 0;
    curlBackendResponse = JSON.stringify({ counts: { broker: 2 } });

    serviceRestart({ broker: false, skipBrokerSessionWarning: true });

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
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: home },
      });
      expect(output).toContain("Wolfpack broker stopped");

      writeFileSync(innerTestPath, macInnerTest);
      execFileSync(process.execPath, ["test", innerTestPath], {
        cwd: process.cwd(),
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: home },
      });
    } finally {
      rmSync(innerTestPath, { force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
