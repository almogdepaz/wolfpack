import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

const innerTestPath = join(process.cwd(), "tests", "unit", ".tmp-service-lifecycle-inner.test.ts");
const innerTest = String.raw`import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const execCommands: string[] = [];
const execFileCalls: Array<{ command: string; args: readonly string[] }> = [];
const askPrompts: string[] = [];
const ownerEvents: string[] = [];
let brokerActive = true;
let trackBrokerState = false;
let lingerStatus: string | Error = "yes\n";
let lingerAnswer = "y";
let failLingerElevation = false;
let curlBackendResponse = JSON.stringify({ counts: { broker: 3 } });
let serviceActive = false;
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
    if (command === "systemctl --user is-active wolfpack-broker 2>&1") return !trackBrokerState || brokerActive ? "active\n" : "inactive\n";
    ownerEvents.push(command);
    if (command === "systemctl --user stop wolfpack") {
      if (failServerStop) throw new Error("server stop failed");
      serviceActive = false;
    }
    if (command === "systemctl --user stop wolfpack-broker 2>/dev/null" && trackBrokerState) brokerActive = false;
    if (command === "systemctl --user start wolfpack") {
      if (failServerStart) throw new Error("server start failed");
      serviceActive = true;
    }
    if (command === "systemctl --user start wolfpack-broker" && trackBrokerState) brokerActive = true;
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
    ownerEvents.push("prompt:" + prompt);
    return lingerAnswer;
  }),
  isPortInUse: mock(() => true),
  killPortHolder: mock(() => undefined),
  loadConfig: mock(() => currentConfig),
  sleepSync: mock(() => undefined),
  waitForPortFree: mock(() => undefined),
}));

const { installCandidatePair, isBrokerServiceRunning, refreshInstalledServerService, removeManagedEntrypoints, serviceInstall, serviceRestart, serviceStop } = await import("../../src/cli/service.ts");

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

  afterEach(() => {
    rmSync(join(homedir(), ".wolfpack"), { recursive: true, force: true });
    rmSync(join(homedir(), ".config", "systemd", "user"), { recursive: true, force: true });
    prepareBroker();
    brokerActive = true;
    trackBrokerState = false;
    serviceActive = false;
    lingerStatus = "yes\n";
    lingerAnswer = "y";
    failLingerElevation = false;
    failServerStop = false;
    failServerStart = false;
    currentConfig = { devDir: "/tmp/old-dev", port: 18790 };
    setInteractive(true);
    serviceInstall();
    execCommands.length = 0;
    execFileCalls.length = 0;
    askPrompts.length = 0;
    ownerEvents.length = 0;
    serviceActive = false;
  });

  test("writes the broker descriptor without restarting an active broker", () => {
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

  function resetInstallationOwnerState(options: { serverActive?: boolean; brokerActive?: boolean; answer?: string } = {}): void {
    execCommands.length = 0;
    execFileCalls.length = 0;
    askPrompts.length = 0;
    ownerEvents.length = 0;
    serviceActive = options.serverActive ?? false;
    brokerActive = options.brokerActive ?? false;
    trackBrokerState = true;
    lingerStatus = "yes\n";
    lingerAnswer = options.answer ?? "y";
    failLingerElevation = false;
    failServerStop = false;
    failServerStart = false;
    currentConfig = { devDir: "/tmp/install-owner", port: 24444 };
    setInteractive(true);
  }

  function writeInstallationPair(directory: string, serverContents: string, brokerContents: string) {
    const server = join(directory, "wolfpack");
    const broker = join(directory, "wolfpack-broker");
    mkdirSync(directory, { recursive: true });
    writeFileSync(server, serverContents);
    writeFileSync(broker, brokerContents);
    chmodSync(server, 0o755);
    chmodSync(broker, 0o755);
    return { server, broker };
  }

  test("explicit install leaves a running broker untouched when its binary is unchanged", async () => {
    resetInstallationOwnerState({ serverActive: true, brokerActive: true });
    const managed = writeInstallationPair(join(homedir(), ".wolfpack", "bin"), "old server\n", "unchanged broker\n");
    const candidates = writeInstallationPair(join(homedir(), "candidate-unchanged"), "new server\n", "unchanged broker\n");

    expect(isBrokerServiceRunning()).toBe(true);
    await installCandidatePair(candidates, "explicit");

    expect(askPrompts).not.toContain("  Stop broker too? This kills broker-owned sessions. (y/n) ");
    expect(execCommands).toContain("systemctl --user stop wolfpack");
    expect(execCommands).not.toContain("systemctl --user stop wolfpack-broker 2>/dev/null");
    expect(execCommands).not.toContain("systemctl --user start wolfpack-broker");
    expect(readFileSync(managed.broker, "utf-8")).toBe("unchanged broker\n");
  });

  test("rejects an owner-inaccessible candidate before touching managed files or services", async () => {
    resetInstallationOwnerState();
    const managed = writeInstallationPair(join(homedir(), ".wolfpack", "bin"), "old server\n", "old broker\n");
    const candidates = writeInstallationPair(join(homedir(), "candidate-invalid"), "not executable\n", "new broker\n");
    chmodSync(candidates.server, 0o001);

    await expect(installCandidatePair(candidates, "explicit")).rejects.toThrow("not executable");
    expect(readFileSync(managed.server, "utf-8")).toBe("old server\n");
    expect(readFileSync(managed.broker, "utf-8")).toBe("old broker\n");
    expect(execCommands).toEqual([]);
  });

  test("explicit install activates a fresh pair and repairs a missing server descriptor", async () => {
    resetInstallationOwnerState();
    const managedDirectory = join(homedir(), ".wolfpack", "bin");
    rmSync(managedDirectory, { recursive: true, force: true });
    const candidates = writeInstallationPair(join(homedir(), "candidate-fresh"), "fresh server\n", "fresh broker\n");
    const unitDirectory = join(homedir(), ".config", "systemd", "user");
    rmSync(unitDirectory, { recursive: true, force: true });

    await installCandidatePair(candidates, "explicit");
    expect(execCommands).toContain("systemctl --user enable wolfpack");
    expect(execCommands).toContain("systemctl --user start wolfpack");

    resetInstallationOwnerState({ brokerActive: true });
    rmSync(join(unitDirectory, "wolfpack.service"), { force: true });
    await installCandidatePair(candidates, "explicit");
    expect(execCommands).toContain("systemctl --user enable wolfpack");
    expect(execCommands).not.toContain("systemctl --user stop wolfpack-broker 2>/dev/null");
  });

  test("rejects bootstrap without setup interaction before replacing managed bytes", async () => {
    resetInstallationOwnerState();
    const managed = writeInstallationPair(join(homedir(), ".wolfpack", "bin"), "old server\n", "old broker\n");
    const candidates = writeInstallationPair(join(homedir(), "candidate-no-tty"), "new server\n", "new broker\n");
    setInteractive(false);

    await expect(installCandidatePair(candidates, "bootstrap")).rejects.toThrow("TTY");
    expect(readFileSync(managed.server, "utf-8")).toBe("old server\n");
    expect(readFileSync(managed.broker, "utf-8")).toBe("old broker\n");
  });

  test("warns and obtains consent before replacing a running broker", async () => {
    resetInstallationOwnerState({ serverActive: true, brokerActive: true, answer: "n" });
    const managed = writeInstallationPair(join(homedir(), ".wolfpack", "bin"), "server\n", "old broker\n");
    const candidates = writeInstallationPair(join(homedir(), "candidate-replacement"), "server\n", "new broker\n");

    await expect(installCandidatePair(candidates, "explicit")).rejects.toThrow("aborted");
    expect(readFileSync(managed.broker, "utf-8")).toBe("old broker\n");
    expect(execCommands).not.toContain("systemctl --user stop wolfpack-broker 2>/dev/null");

    lingerAnswer = "y";
    await installCandidatePair(candidates, "explicit");
    const prompt = "prompt:  Continue with broker replacement? [y/N] ";
    const serverStop = ownerEvents.indexOf("systemctl --user stop wolfpack");
    const brokerStop = ownerEvents.indexOf("systemctl --user stop wolfpack-broker 2>/dev/null");
    expect(askPrompts).toContain("  Continue with broker replacement? [y/N] ");
    expect(ownerEvents.indexOf(prompt)).toBeLessThan(brokerStop);
    expect(serverStop).toBeGreaterThanOrEqual(0);
    expect(serverStop).toBeLessThan(brokerStop);
    expect(readFileSync(managed.broker, "utf-8")).toBe("new broker\n");
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
