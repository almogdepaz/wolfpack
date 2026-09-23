import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fixtureRoot = "";

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function packageFixtureEnvironment(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: join(root, "home"),
    PATH: "/usr/bin:/bin",
    TMPDIR: join(root, "tmp"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(root, "npmrc"),
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    ...extra,
  };
}

interface PackageRunnerFixture {
  readonly packageRoot: string;
  readonly packageBin: string;
  readonly platformPackage: string;
  readonly platformRoot: string;
  readonly server: string;
  readonly broker: string;
}

interface PackageFixtureCommands {
  readonly environment: NodeJS.ProcessEnv;
  readonly npm: string;
  readonly tar: string;
}

function packageFixtureCommands(root: string): PackageFixtureCommands {
  const toolBin = join(root, "tool-bin");
  const userConfig = join(root, "npmrc");
  const globalConfig = join(root, "npm-globalrc");
  const resolveTool = (name: "node" | "npm" | "tar"): string => {
    const tool = Bun.which(name);
    if (!tool) throw new Error(`missing fixture tool: ${name}`);
    return realpathSync(tool);
  };
  const node = resolveTool("node");
  const npm = resolveTool("npm");
  const tar = resolveTool("tar");
  mkdirSync(toolBin, { recursive: true });
  for (const directory of ["home", "tmp", "cache", "config", "npm-cache"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  for (const [name, target] of [["node", node], ["npm", npm], ["tar", tar]] as const) {
    symlinkSync(target, join(toolBin, name));
  }
  writeFileSync(globalConfig, "");
  writeFileSync(userConfig, [
    "offline=true",
    "audit=false",
    "fund=false",
    "update-notifier=false",
    "ignore-scripts=true",
    `cache=${join(root, "npm-cache")}`,
    `globalconfig=${globalConfig}`,
    "",
  ].join("\n"));
  return {
    npm: join(toolBin, "npm"),
    tar: join(toolBin, "tar"),
    environment: packageFixtureEnvironment(root, {
      PATH: `${toolBin}:/usr/bin:/bin`,
      npm_config_cache: join(root, "npm-cache"),
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      npm_config_ignore_scripts: "true",
    }),
  };
}

function runOwnedPackageCommand(
  command: string,
  args: readonly string[],
  root: string,
  environment: NodeJS.ProcessEnv,
): string {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf-8",
    env: environment,
    timeout: 2500,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function createPackageRunnerFixture(
  root: string,
  { target = `${process.platform}-${process.arch}` }: { readonly target?: string } = {},
): PackageRunnerFixture {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
  const packageRoot = join(root, "node_modules", manifest.name);
  const packageBin = join(packageRoot, "bin");
  const platformPackage = `wolfpack-bridge-${target}`;
  const platformVersion = manifest.optionalDependencies[platformPackage];
  if (typeof platformVersion !== "string") throw new Error(`missing fixture platform dependency: ${platformPackage}`);
  const platformRoot = join(root, "node_modules", platformPackage);
  const server = join(platformRoot, "wolfpack");
  const broker = join(platformRoot, "wolfpack-broker");

  mkdirSync(packageBin, { recursive: true });
  mkdirSync(platformRoot, { recursive: true });
  for (const directory of ["home", "tmp", "cache", "config", "npm-cache"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  copyFileSync(join(process.cwd(), "bin", "run.cjs"), join(packageBin, "run.cjs"));
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    bin: manifest.bin,
    optionalDependencies: { [platformPackage]: platformVersion },
  }));
  writeFileSync(join(platformRoot, "package.json"), JSON.stringify({
    name: platformPackage,
    version: platformVersion,
  }));
  writeExecutable(server, "#!/bin/sh\nprintf 'wolfpack %s\\n' \"$*\"\n");
  writeExecutable(broker, "#!/bin/sh\nprintf 'broker\\n'\n");

  return { packageRoot, packageBin, platformPackage, platformRoot, server, broker };
}

function prepareFixture(): {
  readonly home: string;
  readonly bin: string;
  readonly systemBin: string;
  readonly log: string;
  readonly commandLog: string;
  readonly installDir: string;
  readonly checksums: string;
} {
  fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-install-")));
  const home = join(fixtureRoot, "home");
  const bin = join(fixtureRoot, "bin");
  const systemBin = join(fixtureRoot, "system-bin");
  const log = join(fixtureRoot, "downloads.log");
  const commandLog = join(fixtureRoot, "commands.log");
  const installDir = join(home, ".wolfpack", "bin");
  const checksums = join(fixtureRoot, "checksums-sha256.txt");
  mkdirSync(installDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(systemBin, { recursive: true });
  writeFileSync(log, "");
  writeFileSync(commandLog, "");
  const serverAsset = "#!/bin/sh\n[ -z \"$INSTALL_TEST_COMMAND_LOG\" ] || printf \"%s\\n\" \"$*\" >> \"$INSTALL_TEST_COMMAND_LOG\"\nif [ \"$INSTALL_TEST_UNSUPPORTED_INSTALL\" = \"1\" ] && [ \"$1\" = \"install\" ]; then exit 44; fi\nif [ \"$INSTALL_TEST_FAIL_SETUP\" = \"1\" ] && [ \"$1\" = \"setup\" ]; then exit 42; fi\nif [ \"$INSTALL_TEST_FAIL_RESTART\" = \"1\" ] && [ \"$1\" = \"service\" ] && [ \"$2\" = \"restart\" ]; then exit 43; fi\nprintf \"new server\\n\"\n";
  const brokerAsset = "#!/bin/sh\nprintf \"new broker\\n\"\n";
  const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");
  writeFileSync(checksums, `${sha256(serverAsset)}  wolfpack-linux-x64\n${sha256(brokerAsset)}  wolfpack-broker-linux-x64\n`);

  writeExecutable(join(installDir, "wolfpack"), "#!/bin/sh\nprintf 'old server\\n'\n");
  writeExecutable(join(installDir, "wolfpack-broker"), "#!/bin/sh\nprintf 'old broker\\n'\n");
  writeExecutable(join(bin, "tmux"), "#!/bin/sh\nprintf 'tmux 3.4\\n'\n");
  writeExecutable(join(bin, "uname"), `#!/bin/sh
case "$1" in
  -s) printf 'Linux\\n' ;;
  -m) printf 'x86_64\\n' ;;
esac
`);
  writeExecutable(join(bin, "curl"), `#!/bin/sh
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; output="$1" ;;
    http*) url="$1" ;;
  esac
  shift
done
printf '%s\\n' "$url" >> "$INSTALL_TEST_LOG"
case "$url" in
  *checksums-sha256.txt)
    if [ "$INSTALL_TEST_CORRUPT_CHECKSUM" = "1" ]; then
      printf '%064d  wolfpack-linux-x64\\n' 0 > "$output"
      cat "$INSTALL_TEST_CHECKSUMS" | grep wolfpack-broker-linux-x64 >> "$output"
    else
      cat "$INSTALL_TEST_CHECKSUMS" > "$output"
    fi
    ;;
  *wolfpack-broker-linux-x64)
    if [ "$INSTALL_TEST_FAIL_BROKER" = "1" ]; then exit 22; fi
    if [ -n "$INSTALL_TEST_BROKER_ASSET" ]; then cat "$INSTALL_TEST_BROKER_ASSET" > "$output"
    elif [ "$INSTALL_TEST_EMPTY_BROKER" != "1" ]; then printf '#!/bin/sh\\nprintf "new broker\\\\n"\\n' > "$output"; fi
    ;;
  *wolfpack-linux-x64)
    if [ -n "$INSTALL_TEST_SERVER_ASSET" ]; then cat "$INSTALL_TEST_SERVER_ASSET" > "$output"
    else printf '#!/bin/sh\\n[ -z "$INSTALL_TEST_COMMAND_LOG" ] || printf "%%s\\\\n" "$*" >> "$INSTALL_TEST_COMMAND_LOG"\\nif [ "$INSTALL_TEST_UNSUPPORTED_INSTALL" = "1" ] && [ "$1" = "install" ]; then exit 44; fi\\nif [ "$INSTALL_TEST_FAIL_SETUP" = "1" ] && [ "$1" = "setup" ]; then exit 42; fi\\nif [ "$INSTALL_TEST_FAIL_RESTART" = "1" ] && [ "$1" = "service" ] && [ "$2" = "restart" ]; then exit 43; fi\\nprintf "new server\\\\n"\\n' > "$output"; fi
    ;;
  *) exit 22 ;;
esac
`);

  return { home, bin, systemBin, log, commandLog, installDir, checksums };
}

function installerEnvironment(
  fixture: ReturnType<typeof prepareFixture>,
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fixture.home,
    OSTYPE: "linux-gnu",
    PATH: `${fixture.installDir}:${fixture.bin}:/usr/bin:/bin`,
    INSTALL_TEST_LOG: fixture.log,
    INSTALL_TEST_COMMAND_LOG: fixture.commandLog,
    INSTALL_TEST_CHECKSUMS: fixture.checksums,
    INSTALL_TEST_CORRUPT_CHECKSUM: "0",
    INSTALL_TEST_FAIL_SETUP: "0",
    INSTALL_TEST_FAIL_RESTART: "0",
    INSTALL_TEST_UNSUPPORTED_INSTALL: "0",
    WOLFPACK_SYMLINK_DIR: fixture.systemBin,
    WOLFPACK_INSTALL_SKIP_SETUP: "1",
    ...extraEnv,
  };
  if (!("WOLFPACK_RELEASE_TAG" in extraEnv)) delete environment.WOLFPACK_RELEASE_TAG;
  return environment;
}

function runInstaller(
  fixture: ReturnType<typeof prepareFixture>,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [join(process.cwd(), "install.sh")], {
    encoding: "utf-8",
    env: installerEnvironment(fixture, extraEnv),
  });
}

interface ScriptInvocation {
  readonly args: readonly string[];
  readonly cwd: string;
}

function scriptInvocation(platform: NodeJS.Platform, repositoryCwd: string): ScriptInvocation {
  const args = platform === "darwin"
    ? ["-q", "/dev/null", "bash", join(repositoryCwd, "install.sh")]
    : ["-q", "-e", "-c", "bash install.sh", "/dev/null"];
  return { args, cwd: repositoryCwd };
}

function runInstallerWithSetup(
  fixture: ReturnType<typeof prepareFixture>,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  const invocation = scriptInvocation(process.platform, process.cwd());
  return spawnSync("script", invocation.args, {
    cwd: invocation.cwd,
    encoding: "utf-8",
    env: installerEnvironment(fixture, { WOLFPACK_INSTALL_SKIP_SETUP: "0", ...extraEnv }),
  });
}

const PYTHON_PTY_SPAWN = `import errno,os,pty,sys
# Python 3.9 pty.spawn waits forever on macOS zero-byte PTY EOF; normalize it to EIO.
def read_pty(fd):
    chunk=os.read(fd,4096)
    if not chunk: raise OSError(errno.EIO,"PTY EOF")
    return chunk
sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:],master_read=read_pty)))`;

function runWithControllingTty(
  root: string,
  command: readonly string[],
  environment: NodeJS.ProcessEnv,
  input: string,
): ReturnType<typeof spawnSync> {
  const python = Bun.which("python3");
  if (!python) throw new Error("python3 is required for the controlling-TTY fixture");
  return spawnSync(python, ["-c", PYTHON_PTY_SPAWN, ...command], {
    cwd: root,
    encoding: "utf-8",
    env: environment,
    input,
    timeout: 20_000,
  });
}

function expectClosedManagerPath(
  managerBin: string,
  environment: NodeJS.ProcessEnv,
  commands: readonly string[],
): void {
  for (const command of commands) {
    const executable = join(managerBin, command);
    expect(Bun.which(command, { PATH: environment.PATH })).toBe(executable);
    renameSync(executable, `${executable}.disabled`);
    try { expect(Bun.which(command, { PATH: environment.PATH })).toBeNull(); }
    finally { renameSync(`${executable}.disabled`, executable); }
  }
}

function prepareSetupPair(root: string, server: string, broker: string, managerBin = join(root, "manager-bin")): NodeJS.ProcessEnv {
  mkdirSync(managerBin, { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  const serviceManager = process.platform === "darwin" ? "launchctl" : "systemctl";
  const inactiveCommand = process.platform === "darwin" ? "print" : "is-active";
  writeExecutable(join(managerBin, serviceManager), `#!/bin/sh
printf '${serviceManager} %s\\n' "$*" >> "$INSTALL_TEST_MANAGER_LOG"
case "$*" in *${inactiveCommand}*) exit 3 ;; esac
exit 0
`);
  writeExecutable(join(managerBin, "tailscale"), `#!/bin/sh
printf 'tailscale %s\\n' "$*" >> "$INSTALL_TEST_MANAGER_LOG"
exit 1
`);
  if (process.platform === "linux") {
    writeExecutable(join(managerBin, "loginctl"), "#!/bin/sh\nprintf 'yes\\n'\n");
  }
  for (const command of process.platform === "linux"
    ? ["launchctl", "sudo", "brew", "apt", "open"]
    : ["systemctl", "loginctl", "sudo", "brew", "apt", "open"]) {
    writeExecutable(join(managerBin, command), `#!/bin/sh
printf 'unexpected ${command} %s\\n' "$*" >> "$INSTALL_TEST_MANAGER_LOG"
exit 97
`);
  }
  const built = spawnSync(process.execPath, ["build", "--compile", "src/cli/index.ts", "--outfile", server], {
    cwd: process.cwd(), encoding: "utf-8", timeout: 20_000,
  });
  expect(built.status, built.stderr).toBe(0);
  writeExecutable(broker, "#!/bin/sh\nprintf 'new broker\\n'\n");
  const environment = packageFixtureEnvironment(root, {
    PATH: managerBin,
    INSTALL_TEST_MANAGER_LOG: join(root, "manager.log"),
  });
  expectClosedManagerPath(managerBin, environment, [
    "launchctl", "tailscale", "systemctl", "loginctl", "sudo", "brew", "apt", "open",
  ]);
  return environment;
}

function installedOutput(path: string): string {
  return spawnSync(path, [], { encoding: "utf-8" }).stdout;
}

function installerStagingDirectories(installDir: string): readonly string[] {
  return readdirSync(installDir).filter((entry) => entry.startsWith(".install."));
}

const setsidLookup = process.platform === "linux"
  ? spawnSync("/bin/sh", ["-c", "command -v setsid"], { encoding: "utf-8" })
  : null;
const setsidPath = setsidLookup?.stdout?.trim() || undefined;

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
});

describe("install entrypoint parity", () => {
  test("package exposes both the installed CLI name and the bunx package-name alias", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));

    expect(manifest.bin).toEqual({
      wolfpack: "./bin/run.cjs",
      "wolfpack-bridge": "./bin/run.cjs",
    });
    expect(Object.keys(manifest.optionalDependencies).sort()).toEqual([
      "wolfpack-bridge-darwin-arm64",
      "wolfpack-bridge-darwin-x64",
      "wolfpack-bridge-linux-arm64",
      "wolfpack-bridge-linux-x64",
    ]);
    expect([...new Set(Object.values(manifest.optionalDependencies))]).toEqual([manifest.version]);
  });

  test("actual root tar contains the launcher contract without local platform payloads", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-root-tar-")));
    const packs = join(fixtureRoot, "packs");
    const packedRoot = join(fixtureRoot, "packed-root");
    mkdirSync(packs, { recursive: true });
    mkdirSync(packedRoot, { recursive: true });
    const commands = packageFixtureCommands(fixtureRoot);
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));

    const mainPack = JSON.parse(runOwnedPackageCommand(commands.npm, [
      "pack", process.cwd(), "--pack-destination", packs, "--json", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
    ], fixtureRoot, commands.environment))[0];
    const packedFiles = mainPack.files.map((file: { path: string }) => file.path).sort();
    expect(mainPack.name).toBe(manifest.name);
    expect(mainPack.version).toBe(manifest.version);
    expect(packedFiles).toEqual(expect.arrayContaining([
      "bin/run.cjs",
      "package.json",
    ]));
    expect(packedFiles).not.toContain("bin/install.cjs");
    expect(packedFiles).not.toContain("bin/wolfpack");
    expect(packedFiles).not.toContain("bin/wolfpack-broker");

    runOwnedPackageCommand(commands.tar, ["-xzf", join(packs, mainPack.filename), "-C", packedRoot], fixtureRoot, commands.environment);
    const packedManifest = JSON.parse(readFileSync(join(packedRoot, "package", "package.json"), "utf-8"));
    expect(packedManifest.bin).toEqual(manifest.bin);
    expect(packedManifest.engines).toEqual({ node: ">=22" });
    expect(packedManifest.scripts.postinstall).toBeUndefined();
    expect(packedManifest.optionalDependencies).toEqual(manifest.optionalDependencies);
  }, 7500);

  test.each([false, true])("package runner repairs its pair and retries activation (existing descriptor: %p)", (installed) => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-package-owner-")));
    const { packageBin, platformRoot, server, broker } = createPackageRunnerFixture(fixtureRoot);
    const managerBin = join(fixtureRoot, "manager-bin");
    const commands = join(fixtureRoot, "manager.log");
    const managedBin = join(fixtureRoot, "home", ".wolfpack", "bin");
    const descriptorDirectory = process.platform === "darwin"
      ? join(fixtureRoot, "home", "Library", "LaunchAgents") : join(fixtureRoot, "home", ".config", "systemd", "user");
    const descriptor = join(descriptorDirectory, process.platform === "darwin" ? "com.wolfpack.server.plist" : "wolfpack.service");
    mkdirSync(managerBin);
    mkdirSync(join(fixtureRoot, "home", ".wolfpack"));
    writeFileSync(join(fixtureRoot, "home", ".wolfpack", "config.json"), JSON.stringify({ devDir: join(fixtureRoot, "home", "Dev"), port: 24444 }));
    if (installed) {
      mkdirSync(descriptorDirectory, { recursive: true });
      writeFileSync(descriptor, "installed\n");
      mkdirSync(managedBin);
      for (const name of ["wolfpack", "wolfpack-broker"]) writeExecutable(join(managedBin, name), "#!/bin/sh\nexit 17\n");
    }
    writeExecutable(join(managerBin, "systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$INSTALL_TEST_MANAGER_LOG"
[ "$INSTALL_TEST_FAIL_SERVER_START" = "1" ] && [ "$*" = "--user start wolfpack" ] && exit 1
case "$*" in
  '--user start wolfpack-broker') : > "$HOME/broker-started" ;;
  '--user is-active wolfpack-broker') [ -f "$HOME/broker-started" ] && printf 'active\\n' && exit 0; exit 3 ;;
  *is-active*) exit 3 ;;
esac
`);
    writeExecutable(join(managerBin, "loginctl"), "#!/bin/sh\nprintf 'yes\\n'\n");
    writeExecutable(join(managerBin, "launchctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$INSTALL_TEST_MANAGER_LOG"
if [ "$INSTALL_TEST_FAIL_SERVER_START" = "1" ]; then
  case "$*" in *com.wolfpack.server*) exit 1 ;; esac
fi
case "$*" in
  bootstrap*com.wolfpack.broker.plist) : > "$HOME/broker-started" ;;
  print*com.wolfpack.broker) [ -f "$HOME/broker-started" ] && printf 'pid = 42\\n' ;;
esac
`);
    const built = spawnSync(process.execPath, ["build", "--compile", "src/cli/index.ts", "--outfile", server], {
      cwd: process.cwd(), encoding: "utf-8", timeout: 20_000,
    });
    expect(built.status, built.stderr).toBe(0);
    writeExecutable(broker, "#!/bin/sh\nexit 0\n");
    const environment = packageFixtureEnvironment(fixtureRoot, {
      PATH: managerBin, INSTALL_TEST_MANAGER_LOG: commands,
    });
    // A missing fake must never fall through to the host service manager.
    expectClosedManagerPath(managerBin, environment, ["launchctl", "systemctl", "loginctl"]);

    for (const fails of [true, true, false]) {
      const attempt = spawnSync(process.execPath, [join(packageBin, "run.cjs")], {
        cwd: fixtureRoot, encoding: "utf-8", env: { ...environment, INSTALL_TEST_FAIL_SERVER_START: fails ? "1" : "0" }, timeout: 20_000,
      });
      expect(attempt.status, `${attempt.stdout}\n${attempt.stderr}`).toBe(fails ? 1 : 0);
      expect(existsSync(join(managedBin, "wolfpack")), attempt.stderr).toBe(true);
      expect(readFileSync(join(managedBin, "wolfpack"))).toEqual(readFileSync(server));
      expect(readFileSync(join(managedBin, "wolfpack-broker"))).toEqual(readFileSync(broker));
      expect(existsSync(descriptor)).toBe(true);
    }
    const managerLog = readFileSync(commands, "utf-8");
    for (const [macAction, linuxAction, count] of [
      ["bootstrap", "start", 1],
      ["bootout", "stop", process.platform === "darwin" ? 1 : 0],
    ] as const) {
      const brokerCalls = managerLog.split("\n").filter(line => process.platform === "darwin"
        ? line.startsWith(`${macAction} `) && line.includes("com.wolfpack.broker")
        : line === `--user ${linuxAction} wolfpack-broker`);
      expect(brokerCalls).toHaveLength(count);
    }
    expect(platformRoot).toContain("wolfpack-bridge-");
  }, 45_000);

  test.each([
    ["accepted", [], "n\n\ny\n24444\n\n\n", true],
    ["declined", [], "n\n\ny\n24444\nn\n", false],
    ["deferred", ["--defer-service-restart"], "n\n\ny\n24444\n", false],
  ] as const)("package runner setup %s installs its colocated pair only after acceptance", (_case, setupArgs, input, installsPair) => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-package-setup-owner-")));
    const { packageBin, server, broker } = createPackageRunnerFixture(fixtureRoot);
    const commands = join(fixtureRoot, "manager.log");
    const stableBin = join(fixtureRoot, "home", ".wolfpack", "bin");
    mkdirSync(stableBin, { recursive: true });
    writeExecutable(join(stableBin, "wolfpack-broker"), "#!/bin/sh\nprintf 'old broker\\n'\n");
    const environment = prepareSetupPair(fixtureRoot, server, broker);

    const result = runWithControllingTty(fixtureRoot,
      [process.execPath, join(packageBin, "run.cjs"), "setup", ...setupArgs], environment, input);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(String(result.stdout)).toContain("Phone and remote access stay unavailable");
    const stableServer = join(stableBin, "wolfpack");
    if (installsPair) {
      expect(readFileSync(stableServer)).toEqual(readFileSync(server));
      expect(readFileSync(join(stableBin, "wolfpack-broker"))).toEqual(readFileSync(broker));
    } else {
      expect(existsSync(stableServer)).toBe(false);
      expect(readFileSync(join(stableBin, "wolfpack-broker"), "utf-8")).toContain("old broker");
    }
    const managerLog = readFileSync(commands, "utf-8");
    expect(managerLog).toContain("tailscale version");
    expect(managerLog).not.toContain("unexpected");
    if (!installsPair) expect(managerLog).not.toMatch(/(?:bootstrap|enable|start)/);
  }, 45_000);

  test.each(["wolfpack", "wolfpack-broker"] as const)("package runner rejects a non-executable exact-pair payload: %s", (payload) => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-direct-non-executable-")));
    const { packageBin, platformPackage, server, broker } = createPackageRunnerFixture(fixtureRoot);
    const target = payload === "wolfpack" ? server : broker;
    chmodSync(target, 0o644);

    const invoked = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot),
      timeout: 2500,
    });

    expect(invoked.status).toBe(1);
    expect(invoked.stdout).toBe("");
    expect(invoked.stderr).toContain(`wolfpack: platform package ${platformPackage} has non-executable ${payload}`);
    expect(existsSync(join(fixtureRoot, "cache", "wolfpack-bridge"))).toBe(false);
  });

  test("rejects unsupported Node before loading node builtins", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-old-node-")));
    const packageBin = join(fixtureRoot, "bin");
    mkdirSync(packageBin, { recursive: true });
    writeFileSync(join(packageBin, "run.cjs"), readFileSync(join(process.cwd(), "bin", "run.cjs")));
    writeExecutable(join(packageBin, "wolfpack"), "#!/bin/sh\nprintf 'wolfpack %s\\n' \"$*\"\n");

    const result = spawnSync("node", ["-e", `
      Object.defineProperty(process.versions, "node", { value: "14.16.0" });
      require(process.argv[1]);
    `, join(packageBin, "run.cjs"), "--version"], { encoding: "utf-8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires Node.js 22 or later");
    expect(result.stderr).toContain("bunx --bun wolfpack-bridge@latest");
    expect(result.stdout).toBe("");
  });

  test("curl install does not require or mention obsolete tmux", () => {
    const fixture = prepareFixture();
    rmSync(join(fixture.bin, "tmux"));

    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    expect(String(result.stdout).toLowerCase()).not.toContain("tmux");
    expect(readFileSync(fixture.commandLog, "utf-8")).toContain("install");
  });

  test("installer explains the missing-Tailscale local-only fallback without surfacing JWT setup", () => {
    const installer = readFileSync(join(process.cwd(), "install.sh"), "utf-8");

    expect(installer).toContain("setup will offer to install it for secure phone and remote access");
    expect(installer).not.toContain("optional — needed for remote access");
    expect(installer).not.toContain("WOLFPACK_JWT_SECRET");
  });

  test("package runner accepts an exact release-policy build-metadata version", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-build-metadata-version-")));
    const { packageBin, packageRoot, platformPackage, platformRoot } = createPackageRunnerFixture(fixtureRoot);
    const version = "1.6.20-rc.1+build.7";
    const mainManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8"));
    mainManifest.version = version;
    mainManifest.optionalDependencies[platformPackage] = version;
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify(mainManifest));
    writeFileSync(join(platformRoot, "package.json"), JSON.stringify({ name: platformPackage, version }));

    const invoked = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot),
      timeout: 2500,
    });

    expect(invoked.status, invoked.stderr).toBe(0);
    expect(invoked.stdout).toBe("wolfpack --version\n");
  });

  test("package runner refuses a platform package with a different exact version", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-version-mismatch-")));
    const { packageBin, platformRoot, platformPackage } = createPackageRunnerFixture(fixtureRoot);
    writeFileSync(join(platformRoot, "package.json"), JSON.stringify({ name: platformPackage, version: "0.0.0-fixture-mismatch" }));

    const invoked = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot),
      timeout: 2500,
    });

    expect(invoked.status).toBe(1);
    expect(invoked.stderr).toContain(`platform package ${platformPackage} does not match declared version`);
    expect(invoked.stderr).not.toContain("optional dependencies enabled");
  });

  test("package runner gives optional-dependency guidance for genuine absence", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-package-missing-")));
    const { packageBin, platformRoot, platformPackage } = createPackageRunnerFixture(fixtureRoot);
    rmSync(platformRoot, { recursive: true });
    writeExecutable(join(packageBin, "wolfpack"), "#!/bin/sh\nprintf 'STALE LOCAL BINARY\\n'\n");

    const invoked = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot),
      timeout: 2500,
    });

    expect(invoked.status).toBe(1);
    expect(invoked.stderr).toContain(`missing optional platform package ${platformPackage}`);
    expect(invoked.stderr).toContain("optional dependencies enabled");
  });

  test("package runner preserves non-ENOENT payload inspection errors", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-package-inspection-error-")));
    const { packageBin, platformPackage, broker } = createPackageRunnerFixture(fixtureRoot);
    const nodeRuntime = Bun.which("node");
    if (!nodeRuntime) throw new Error("missing Node for the owned payload inspection fixture");
    const injection = `
      const Module = require("node:module");
      const load = Module._load;
      Module._load = function(request, parent, isMain) {
        const loaded = load.call(this, request, parent, isMain);
        if (request !== "node:fs") return loaded;
        return { ...loaded, lstatSync(path, ...args) {
          if (path === process.env.WOLFPACK_INSPECTION_TARGET) {
            throw Object.assign(new Error("owned fixture denies inspection"), { code: "EACCES" });
          }
          return loaded.lstatSync(path, ...args);
        }};
      };
      require(process.argv[1]);
    `;
    const invoked = spawnSync(realpathSync(nodeRuntime), ["--eval", injection, join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot, { WOLFPACK_INSPECTION_TARGET: broker }),
      timeout: 2500,
    });

    expect(invoked.status).toBe(1);
    expect(invoked.stdout).toBe("");
    expect(invoked.stderr).toContain(`wolfpack: could not inspect wolfpack-broker in platform package ${platformPackage} (EACCES)`);
    expect(invoked.stderr).not.toContain("missing wolfpack-broker");
  });

  test.each(["directory", "symlink"] as const)("package runner reports a non-regular payload: %s", (kind) => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-package-non-regular-")));
    const { packageBin, platformPackage, broker, server } = createPackageRunnerFixture(fixtureRoot);
    rmSync(broker);
    if (kind === "directory") mkdirSync(broker);
    else symlinkSync(server, broker);

    const invoked = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot),
      timeout: 2500,
    });

    expect(invoked.status).toBe(1);
    expect(invoked.stdout).toBe("");
    expect(invoked.stderr).toContain(`wolfpack: platform package ${platformPackage} has non-regular wolfpack-broker`);
  });

  test.each([
    ["main", "null"],
    ["main", "array"],
    ["platform", "null"],
    ["platform", "array"],
  ] as const)("package runner rejects a %s %s manifest shape", (owner, shape) => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-package-manifest-shape-")));
    const { packageRoot, packageBin, platformPackage, platformRoot } = createPackageRunnerFixture(fixtureRoot);
    writeFileSync(join(owner === "main" ? packageRoot : platformRoot, "package.json"), shape === "null" ? "null\n" : "[]\n");

    const invoked = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot),
      timeout: 2500,
    });

    expect(invoked.status).toBe(1);
    expect(invoked.stdout).toBe("");
    expect(invoked.stderr).toContain(owner === "main"
      ? "wolfpack: invalid main package manifest"
      : `wolfpack: invalid platform package manifest for ${platformPackage}`);
  });

  test("package runner reports an incomplete optional platform pair distinctly", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-package-runner-incomplete-")));
    const { packageBin, platformPackage, broker } = createPackageRunnerFixture(fixtureRoot);
    rmSync(broker);

    const result = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      encoding: "utf-8",
      cwd: fixtureRoot,
      env: packageFixtureEnvironment(fixtureRoot),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`wolfpack: incomplete platform package ${platformPackage}`);
    expect(result.stderr).toContain("missing wolfpack-broker");
    expect(result.stderr).not.toContain("optional dependencies enabled");
  });

});

describe("install.sh release binary staging", () => {
  test.each([
    ["fresh acceptance", false, true, "n\n\ny\n24444\n\n"],
    ["fresh decline", false, false, "n\n\ny\n24444\nn\n"],
    ["managed deferred setup", true, true, "n\n\ny\n24444\n"],
  ] as const)("piped installer %s runs real setup and the pair owner", (_case, managed, activates, input) => {
    const fixture = prepareFixture();
    const server = join(fixtureRoot, "candidate-server");
    const broker = join(fixtureRoot, "candidate-broker");
    const environment = prepareSetupPair(fixtureRoot, server, broker, fixture.bin);
    for (const command of ["awk", "bash", "cat", "chmod", "ln", "mkdir", "mktemp", "rm", "readlink", process.platform === "darwin" ? "shasum" : "sha256sum"]) {
      const executable = Bun.which(command, { PATH: "/usr/bin:/bin" });
      if (!executable) throw new Error(`missing installer fixture utility: ${command}`);
      symlinkSync(executable, join(fixture.bin, command));
    }
    const assets = [[server, "wolfpack-linux-x64"], [broker, "wolfpack-broker-linux-x64"]] as const;
    writeFileSync(fixture.checksums, assets.map(([path, name]) =>
      `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${name}\n`,
    ).join(""));
    if (managed) {
      const descriptorDirectory = process.platform === "darwin"
        ? join(fixture.home, "Library", "LaunchAgents") : join(fixture.home, ".config", "systemd", "user");
      mkdirSync(descriptorDirectory, { recursive: true });
      writeFileSync(join(descriptorDirectory, process.platform === "darwin" ? "com.wolfpack.broker.plist" : "wolfpack-broker.service"), "installed\n");
      writeFileSync(join(fixture.home, ".wolfpack", "config.json"), JSON.stringify({ devDir: join(fixture.home, "Dev"), port: 24443 }));
    } else {
      rmSync(fixture.installDir, { recursive: true });
    }
    const result = runWithControllingTty(fixtureRoot,
      ["/bin/bash", "-c", 'cat "$1" | bash', "piped-installer", join(process.cwd(), "install.sh")], {
        ...environment,
        OSTYPE: "linux-gnu",
        INSTALL_TEST_LOG: fixture.log,
        INSTALL_TEST_CHECKSUMS: fixture.checksums,
        INSTALL_TEST_SERVER_ASSET: server,
        INSTALL_TEST_BROKER_ASSET: broker,
        WOLFPACK_SYMLINK_DIR: fixture.systemBin,
      }, input);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(String(result.stdout)).toContain("Setup complete — next steps:");
    expect(JSON.parse(readFileSync(join(fixture.home, ".wolfpack", "config.json"), "utf-8")).port).toBe(24444);
    expect(readFileSync(join(fixture.installDir, "wolfpack"))).toEqual(readFileSync(server));
    expect(readFileSync(join(fixture.installDir, "wolfpack-broker"))).toEqual(readFileSync(broker));
    const managerLog = readFileSync(join(fixtureRoot, "manager.log"), "utf-8");
    expect(managerLog).toContain("tailscale version");
    expect(managerLog).not.toContain("unexpected");
    for (const [label, unit] of [["com.wolfpack.server", "wolfpack"], ["com.wolfpack.broker", "wolfpack-broker"]]) {
      const starts = managerLog.split("\n").filter(line => process.platform === "darwin"
        ? line.startsWith("launchctl bootstrap ") && line.endsWith(`/${label}.plist`)
        : line === `systemctl --user start ${unit}`);
      expect(starts).toHaveLength(activates ? 1 : 0);
    }
    if (managed) {
      expect(String(result.stdout)).toContain("Service activation deferred.");
      expect(String(result.stdout)).not.toContain("Start wolfpack automatically on login?");
    }
    expect(installerStagingDirectories(fixture.installDir)).toEqual([]);
  }, 45_000);

  test("Linux pseudo-tty invocation keeps spaced repository paths out of the shell command", () => {
    const repositoryCwd = "/tmp/wolfpack checkout with spaces";
    const invocation = scriptInvocation("linux", repositoryCwd);

    expect(invocation.cwd).toBe(repositoryCwd);
    expect(invocation.args).toEqual(["-q", "-e", "-c", "bash install.sh", "/dev/null"]);
  });

  test("normal completion delegates lifecycle work to the staged installation owner", () => {
    const fixture = prepareFixture();
    const result = runInstallerWithSetup(fixture);

    expect(result.status).toBe(0);
    const commands = readFileSync(fixture.commandLog, "utf-8");
    expect(commands).toContain("install");
    expect(commands).not.toContain("setup\n");
    expect(commands).not.toContain("service restart");
    expect(installerStagingDirectories(fixture.installDir)).toEqual([]);
  });

  test("a normal upgrade delegates installation and setup without shell-managed restart", () => {
    const fixture = prepareFixture();
    const serviceDir = join(fixture.home, ".config", "systemd", "user");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "wolfpack.service"), "installed\n");
    writeFileSync(join(fixture.home, ".wolfpack", "config.json"), JSON.stringify({
      devDir: join(fixture.home, "Dev"),
      port: 18790,
    }));

    const result = runInstallerWithSetup(fixture);

    expect(result.status).toBe(0);
    const commands = readFileSync(fixture.commandLog, "utf-8");
    expect(commands).toContain("install");
    expect(commands).not.toContain("setup\n");
    expect(commands).not.toContain("service restart");
    expect(installerStagingDirectories(fixture.installDir)).toEqual([]);
  });

  test.skipIf(!setsidPath)("does not invoke setup or restart without a controlling tty on Linux", () => {
    const fixture = prepareFixture();
    const serviceDir = join(fixture.home, ".config", "systemd", "user");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "wolfpack.service"), "installed\n");
    writeFileSync(join(fixture.home, ".wolfpack", "config.json"), JSON.stringify({
      devDir: join(fixture.home, "Dev"),
      port: 18790,
    }));

    const result = spawnSync(setsidPath!, ["--wait", "bash", join(process.cwd(), "install.sh")], {
      encoding: "utf-8",
      env: installerEnvironment(fixture, { WOLFPACK_INSTALL_SKIP_SETUP: "0" }),
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.log, "utf-8")).toContain("wolfpack-linux-x64");
    const commands = readFileSync(fixture.commandLog, "utf-8");
    expect(commands).not.toContain("install");
    expect(commands).not.toContain("setup");
    expect(commands).not.toContain("service restart");
  });

  test("propagates an owner failure with ordinary rerun guidance", () => {
    const fixture = prepareFixture();
    const serviceDir = join(fixture.home, ".config", "systemd", "user");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "wolfpack.service"), "installed\n");
    writeFileSync(join(fixture.home, ".wolfpack", "config.json"), JSON.stringify({
      devDir: join(fixture.home, "Dev"),
      port: 18790,
    }));

    const result = runInstallerWithSetup(fixture, { INSTALL_TEST_UNSUPPORTED_INSTALL: "1" });

    expect(result.status).not.toBe(0);
    expect(String(result.stdout)).toContain("Fix the reported error and rerun this installer.");
    const commands = readFileSync(fixture.commandLog, "utf-8");
    expect(commands).toContain("install");
    expect(commands).not.toContain("setup");
    expect(commands).not.toContain("service restart");
  });

  test("does not request a shell-managed final restart", () => {
    const fixture = prepareFixture();
    const serviceDir = join(fixture.home, ".config", "systemd", "user");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "wolfpack.service"), "installed\n");
    writeFileSync(join(fixture.home, ".wolfpack", "config.json"), JSON.stringify({
      devDir: join(fixture.home, "Dev"),
      port: 18790,
    }));

    const result = runInstallerWithSetup(fixture);

    expect(result.status).toBe(0);
    const commands = readFileSync(fixture.commandLog, "utf-8");
    expect(commands).toContain("install");
    expect(commands).not.toContain("setup\n");
    expect(commands).not.toContain("service restart");
  });

  test("a skip-setup upgrade leaves service decisions to the installation owner", () => {
    const fixture = prepareFixture();
    const serviceDir = join(fixture.home, ".config", "systemd", "user");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "wolfpack.service"), "installed\n");
    writeFileSync(join(fixture.home, ".wolfpack", "config.json"), "{}\n");

    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    const commands = readFileSync(fixture.commandLog, "utf-8");
    expect(commands).toContain("install");
    expect(commands).not.toContain("setup");
    expect(commands).not.toContain("service restart");
  });

  test("rejects a candidate without an installation dispatch before managed cutover", () => {
    const fixture = prepareFixture();

    const result = runInstaller(fixture, { INSTALL_TEST_UNSUPPORTED_INSTALL: "1" });

    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.commandLog, "utf-8")).toContain("install");
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("old server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("old broker\n");
  });

  test("downloads and installs the matching wolfpack and broker assets from latest by default", () => {
    const fixture = prepareFixture();
    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.log, "utf-8").trim().split("\n")).toEqual([
      "https://github.com/almogdepaz/wolfpack/releases/latest/download/checksums-sha256.txt",
      "https://github.com/almogdepaz/wolfpack/releases/latest/download/wolfpack-linux-x64",
      "https://github.com/almogdepaz/wolfpack/releases/latest/download/wolfpack-broker-linux-x64",
    ]);
    expect(readFileSync(fixture.commandLog, "utf-8")).toContain("install");
    expect(installerStagingDirectories(fixture.installDir)).toEqual([]);
  });

  test("downloads checksums and both binaries from one validated release tag", () => {
    const fixture = prepareFixture();
    const result = runInstaller(fixture, { WOLFPACK_RELEASE_TAG: "v1.6.20-rc.1" });

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.log, "utf-8").trim().split("\n")).toEqual([
      "https://github.com/almogdepaz/wolfpack/releases/download/v1.6.20-rc.1/checksums-sha256.txt",
      "https://github.com/almogdepaz/wolfpack/releases/download/v1.6.20-rc.1/wolfpack-linux-x64",
      "https://github.com/almogdepaz/wolfpack/releases/download/v1.6.20-rc.1/wolfpack-broker-linux-x64",
    ]);
  });

  test.each([
    "",
    "1.6.20",
    "v1..20",
    "v1.6.20-rc..1",
    "v1.6.20-01",
    "../v1.6.20",
    "https://example.com/v1.6.20",
  ])("rejects invalid release tag %p before downloads or installed-state mutation", (releaseTag) => {
    const fixture = prepareFixture();
    const result = runInstaller(fixture, { WOLFPACK_RELEASE_TAG: releaseTag });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Invalid WOLFPACK_RELEASE_TAG");
    expect(readFileSync(fixture.log, "utf-8")).toBe("");
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("old server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("old broker\n");
    expect(installerStagingDirectories(fixture.installDir)).toEqual([]);
  });

  test("rejects a checksum mismatch before either binary is replaced", () => {
    const fixture = prepareFixture();
    const result = runInstaller(fixture, { INSTALL_TEST_CORRUPT_CHECKSUM: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Checksum verification failed");
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("old server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("old broker\n");
    expect(installerStagingDirectories(fixture.installDir)).toEqual([]);
  });

  test("preserves a foreign wolfpack command and never invokes it for setup", () => {
    const fixture = prepareFixture();
    const foreignWolfpack = join(fixture.bin, "wolfpack");
    writeExecutable(foreignWolfpack, "#!/bin/sh\nprintf 'foreign wolfpack\\n'\n");

    const result = runInstaller(fixture, {
      PATH: `${fixture.bin}:${fixture.installDir}:/usr/bin:/bin`,
    });

    expect(result.status).toBe(0);
    expect(existsSync(foreignWolfpack)).toBe(true);
    expect(readFileSync(join(process.cwd(), "install.sh"), "utf-8")).not.toContain("exec wolfpack setup");
  });

  test("a broker download failure preserves both existing binaries", () => {
    const fixture = prepareFixture();
    const result = runInstaller(fixture, { INSTALL_TEST_FAIL_BROKER: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("wolfpack-broker-linux-x64");
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("old server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("old broker\n");
  });

  test("an empty broker artifact is rejected before either binary is replaced", () => {
    const fixture = prepareFixture();
    const result = runInstaller(fixture, { INSTALL_TEST_EMPTY_BROKER: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Downloaded artifact is empty");
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("old server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("old broker\n");
  });
});
