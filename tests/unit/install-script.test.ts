import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
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

function runOwnedLauncher(
  launcher: string,
  root: string,
  environment: NodeJS.ProcessEnv,
  timeout: number,
): Promise<{ readonly status: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [launcher, "--version"], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ status: null, signal: null, stdout: "", stderr: String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    child.once("error", (error) => { stderr += String(error); });
    child.once("close", (status, signal) => {
      clearTimeout(deadline);
      resolve({ status, signal, stdout, stderr: timedOut ? `${stderr}\nlauncher deadline exceeded: ${launcher}` : stderr });
    });
  });
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
  copyFileSync(join(process.cwd(), "bin", "stage-platform-pair.cjs"), join(packageBin, "stage-platform-pair.cjs"));
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
  const serverAsset = "#!/bin/sh\n[ -z \"$INSTALL_TEST_COMMAND_LOG\" ] || printf \"%s\\n\" \"$*\" >> \"$INSTALL_TEST_COMMAND_LOG\"\nif [ \"$INSTALL_TEST_FAIL_SETUP\" = \"1\" ] && [ \"$1\" = \"setup\" ]; then exit 42; fi\nif [ \"$INSTALL_TEST_FAIL_RESTART\" = \"1\" ] && [ \"$1\" = \"service\" ] && [ \"$2\" = \"restart\" ]; then exit 43; fi\nprintf \"new server\\n\"\n";
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
    if [ "$INSTALL_TEST_EMPTY_BROKER" != "1" ]; then printf '#!/bin/sh\\nprintf "new broker\\\\n"\\n' > "$output"; fi
    ;;
  *wolfpack-linux-x64)
    printf '#!/bin/sh\\n[ -z "$INSTALL_TEST_COMMAND_LOG" ] || printf "%%s\\\\n" "$*" >> "$INSTALL_TEST_COMMAND_LOG"\\nif [ "$INSTALL_TEST_FAIL_SETUP" = "1" ] && [ "$1" = "setup" ]; then exit 42; fi\\nif [ "$INSTALL_TEST_FAIL_RESTART" = "1" ] && [ "$1" = "service" ] && [ "$2" = "restart" ]; then exit 43; fi\\nprintf "new server\\\\n"\\n' > "$output"
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
      "bin/stage-platform-pair.cjs",
      "bin/install.cjs",
      "package.json",
    ]));
    expect(packedFiles).not.toContain("bin/wolfpack");
    expect(packedFiles).not.toContain("bin/wolfpack-broker");

    runOwnedPackageCommand(commands.tar, ["-xzf", join(packs, mainPack.filename), "-C", packedRoot], fixtureRoot, commands.environment);
    const packedManifest = JSON.parse(readFileSync(join(packedRoot, "package", "package.json"), "utf-8"));
    expect(packedManifest.bin).toEqual(manifest.bin);
    expect(packedManifest.engines).toEqual({ node: ">=22" });
    expect(packedManifest.scripts.postinstall).toBeUndefined();
    expect(packedManifest.optionalDependencies).toEqual(manifest.optionalDependencies);
  }, 7500);

  test("reduced offline package fixture executes the packed launcher/helper pair repeatedly", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-reduced-package-")));
    const packs = join(fixtureRoot, "packs");
    const installRoot = join(fixtureRoot, "install-root");
    mkdirSync(packs, { recursive: true });
    mkdirSync(installRoot, { recursive: true });
    const fixture = createPackageRunnerFixture(fixtureRoot);
    const commands = packageFixtureCommands(fixtureRoot);

    const platformPack = JSON.parse(runOwnedPackageCommand(commands.npm, [
      "pack", fixture.platformRoot, "--pack-destination", packs, "--json", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
    ], fixtureRoot, commands.environment))[0].filename;
    const launcherPack = JSON.parse(runOwnedPackageCommand(commands.npm, [
      "pack", fixture.packageRoot, "--pack-destination", packs, "--json", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
    ], fixtureRoot, commands.environment))[0].filename;
    writeFileSync(join(installRoot, "package.json"), JSON.stringify({
      name: "wolfpack-reduced-package-fixture",
      version: "1.0.0",
      private: true,
      dependencies: {
        "wolfpack-bridge": `file:${join(packs, launcherPack)}`,
        [fixture.platformPackage]: `file:${join(packs, platformPack)}`,
      },
    }));
    runOwnedPackageCommand(commands.npm, [
      "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
    ], installRoot, commands.environment);

    const installed = join(installRoot, "node_modules", ".bin", "wolfpack");
    const first = spawnSync(installed, ["--version"], {
      cwd: installRoot,
      encoding: "utf-8",
      env: commands.environment,
      timeout: 2500,
    });
    const repeated = spawnSync(installed, ["--version"], {
      cwd: installRoot,
      encoding: "utf-8",
      env: commands.environment,
      timeout: 2500,
    });
    expect(first.status, `${first.error ?? ""}\n${first.stderr}`).toBe(0);
    expect(repeated.status, `${repeated.error ?? ""}\n${repeated.stderr}`).toBe(0);
    expect(first.stdout).toBe("wolfpack --version\n");
    expect(repeated.stdout).toBe("wolfpack --version\n");
    expect(statSync(join(installRoot, "node_modules", fixture.platformPackage, "wolfpack-broker")).mode & 0o100).toBe(0o100);
  }, 7500);

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
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("new server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("new broker\n");
  });

  test("installer explains the missing-Tailscale local-only fallback without surfacing JWT setup", () => {
    const installer = readFileSync(join(process.cwd(), "install.sh"), "utf-8");

    expect(installer).toContain("setup will offer to install it for secure phone and remote access");
    expect(installer).not.toContain("optional — needed for remote access");
    expect(installer).not.toContain("WOLFPACK_JWT_SECRET");
  });

  test("staging regression: package runner does not mutate the resolved platform pair", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-package-runner-")));
    const { packageBin, platformRoot, server, broker } = createPackageRunnerFixture(fixtureRoot);
    chmodSync(server, 0o644);
    chmodSync(broker, 0o644);
    const sourceServer = readFileSync(server);
    const sourceBroker = readFileSync(broker);
    const sourceModes = [statSync(server).mode, statSync(broker).mode];

    const result = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot),
      timeout: 2500,
    });

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toBe("wolfpack --version\n");
    expect(readFileSync(server)).toEqual(sourceServer);
    expect(readFileSync(broker)).toEqual(sourceBroker);
    expect([statSync(server).mode, statSync(broker).mode]).toEqual(sourceModes);

    const stagedRoot = join(fixtureRoot, "cache", "wolfpack-bridge", "platform-pairs");
    const generation = readdirSync(stagedRoot).find((entry) => !entry.startsWith("."));
    expect(generation).toBeDefined();
    const invalidGeneration = join(stagedRoot, generation!);
    rmSync(join(invalidGeneration, "pair.json"));
    rmSync(join(invalidGeneration, "wolfpack"));
    rmSync(join(invalidGeneration, "wolfpack-broker"));
    const inode = statSync(invalidGeneration).ino;
    const retry = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot),
      timeout: 10_000,
    });
    expect(retry.status).toBe(1);
    expect(statSync(invalidGeneration).ino).toBe(inode);
    expect(readdirSync(invalidGeneration)).toEqual([]);
  }, 20_000);

  test.each(["packageName", "version", "target", "serverHash", "brokerHash"] as const)("staging regression: warm metadata refuses changed source %s", (field) => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-stage-warm-source-")));
    const { packageBin } = createPackageRunnerFixture(fixtureRoot);
    const environment = packageFixtureEnvironment(fixtureRoot);
    const initial = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: environment,
      timeout: 2500,
    });
    expect(initial.status, String(initial.stderr)).toBe(0);

    const stagedRoot = join(fixtureRoot, "cache", "wolfpack-bridge", "platform-pairs");
    const generation = readdirSync(stagedRoot).find((entry) => !entry.startsWith("."));
    expect(generation).toBeDefined();
    const stagedGeneration = join(stagedRoot, generation!);
    const metadataPath = join(stagedGeneration, "pair.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
    metadata.source[field] = `mismatched-${field}`;
    writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
    const invalidBytes = readFileSync(metadataPath);
    const inode = statSync(stagedGeneration).ino;

    const retry = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: environment,
      timeout: 2500,
    });
    expect(retry.status).toBe(1);
    expect(retry.stderr).toContain(`wolfpack: staged generation is invalid: ${stagedGeneration}`);
    expect(readFileSync(metadataPath)).toEqual(invalidBytes);
    expect(statSync(stagedGeneration).ino).toBe(inode);
  });

  test("staging regression: warm metadata rejects null without rewriting the generation", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-stage-warm-null-")));
    const { packageBin } = createPackageRunnerFixture(fixtureRoot);
    const environment = packageFixtureEnvironment(fixtureRoot);
    const initial = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: environment,
      timeout: 2500,
    });
    expect(initial.status, String(initial.stderr)).toBe(0);

    const stagedRoot = join(fixtureRoot, "cache", "wolfpack-bridge", "platform-pairs");
    const generation = readdirSync(stagedRoot).find((entry) => !entry.startsWith("."));
    expect(generation).toBeDefined();
    const stagedGeneration = join(stagedRoot, generation!);
    const metadataPath = join(stagedGeneration, "pair.json");
    writeFileSync(metadataPath, "null\n");
    const invalidBytes = readFileSync(metadataPath);
    const inode = statSync(stagedGeneration).ino;

    const retry = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: environment,
      timeout: 2500,
    });
    expect(retry.status).toBe(1);
    expect(retry.stderr).toContain(`wolfpack: staged generation is invalid: ${stagedGeneration}`);
    expect(readFileSync(metadataPath)).toEqual(invalidBytes);
    expect(statSync(stagedGeneration).ino).toBe(inode);
  });

  test.each(["wolfpack", "wolfpack-broker"])("staging regression: warm metadata rejects %s without owner execute", (payload) => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-stage-warm-mode-")));
    const { packageBin } = createPackageRunnerFixture(fixtureRoot);
    const environment = packageFixtureEnvironment(fixtureRoot);
    const initial = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: environment,
      timeout: 2500,
    });
    expect(initial.status, String(initial.stderr)).toBe(0);

    const stagedRoot = join(fixtureRoot, "cache", "wolfpack-bridge", "platform-pairs");
    const generation = readdirSync(stagedRoot).find((entry) => !entry.startsWith("."));
    expect(generation).toBeDefined();
    const stagedGeneration = join(stagedRoot, generation!);
    const stagedServer = join(stagedGeneration, payload);
    chmodSync(stagedServer, 0o655);
    const inode = statSync(stagedGeneration).ino;

    const retry = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: environment,
      timeout: 2500,
    });
    expect(retry.status).toBe(1);
    expect(retry.stderr).toContain(`wolfpack: staged generation is not executable: ${stagedGeneration}`);
    expect(statSync(stagedServer).mode & 0o777).toBe(0o655);
    expect(statSync(stagedGeneration).ino).toBe(inode);
  });

  test.each(["malformed", "symlink"] as const)("staging regression: warm metadata rejects %s metadata without rewriting the generation", (kind) => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-stage-warm-metadata-")));
    const { packageBin } = createPackageRunnerFixture(fixtureRoot);
    const environment = packageFixtureEnvironment(fixtureRoot);
    const initial = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: environment,
      timeout: 2500,
    });
    expect(initial.status, String(initial.stderr)).toBe(0);

    const stagedRoot = join(fixtureRoot, "cache", "wolfpack-bridge", "platform-pairs");
    const generation = readdirSync(stagedRoot).find((entry) => !entry.startsWith("."));
    expect(generation).toBeDefined();
    const stagedGeneration = join(stagedRoot, generation!);
    const metadataPath = join(stagedGeneration, "pair.json");
    let immutablePath = metadataPath;
    if (kind === "malformed") {
      writeFileSync(metadataPath, "{\n");
    } else {
      immutablePath = join(stagedGeneration, "pair-target.json");
      writeFileSync(immutablePath, readFileSync(metadataPath));
      rmSync(metadataPath);
      symlinkSync("pair-target.json", metadataPath);
    }
    const invalidBytes = readFileSync(immutablePath);
    const inode = statSync(stagedGeneration).ino;

    const retry = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: environment,
      timeout: 2500,
    });
    expect(retry.status).toBe(1);
    expect(retry.stderr).toContain(`wolfpack: staged generation is invalid: ${stagedGeneration}`);
    expect(readFileSync(immutablePath)).toEqual(invalidBytes);
    expect(statSync(stagedGeneration).ino).toBe(inode);
  });

  test("staging regression: warm metadata rejects a corrupt prepared payload without rewriting the generation", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-stage-warm-payload-")));
    const { packageBin } = createPackageRunnerFixture(fixtureRoot);
    const environment = packageFixtureEnvironment(fixtureRoot);
    const initial = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: environment,
      timeout: 2500,
    });
    expect(initial.status, String(initial.stderr)).toBe(0);

    const stagedRoot = join(fixtureRoot, "cache", "wolfpack-bridge", "platform-pairs");
    const generation = readdirSync(stagedRoot).find((entry) => !entry.startsWith("."));
    expect(generation).toBeDefined();
    const stagedGeneration = join(stagedRoot, generation!);
    const stagedServer = join(stagedGeneration, "wolfpack");
    writeFileSync(stagedServer, "corrupt\n");
    const invalidBytes = readFileSync(stagedServer);
    const inode = statSync(stagedGeneration).ino;

    const retry = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: environment,
      timeout: 2500,
    });
    expect(retry.status).toBe(1);
    expect(retry.stderr).toContain(`wolfpack: staged generation is invalid: ${stagedGeneration}`);
    expect(readFileSync(stagedServer)).toEqual(invalidBytes);
    expect(statSync(stagedGeneration).ino).toBe(inode);
  });

  test("staging regression: rejects a relative cache base before descendant writes", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-stage-relative-cache-")));
    const { packageBin } = createPackageRunnerFixture(fixtureRoot);
    const result = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot, { XDG_CACHE_HOME: "relative-cache" }),
      timeout: 2500,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("wolfpack: cache base must be absolute: relative-cache");
    expect(existsSync(join(fixtureRoot, "relative-cache"))).toBe(false);
  });

  test.each([false, true])("staging regression: refuses writable cache ancestry (symlink ancestor: %s)", (alias) => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-stage-ancestry-")));
    const { packageBin } = createPackageRunnerFixture(fixtureRoot);
    const unsafeParent = join(fixtureRoot, "unsafe-parent");
    mkdirSync(unsafeParent, { mode: 0o777 });
    chmodSync(unsafeParent, 0o777);
    const base = join(unsafeParent, "cache");
    mkdirSync(base, { mode: 0o700 });
    const aliasPath = join(fixtureRoot, "alias");
    if (alias) symlinkSync(unsafeParent, aliasPath);
    const invoked = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot, { XDG_CACHE_HOME: alias ? join(aliasPath, "cache") : base }),
      timeout: 2500,
    });
    expect(invoked.status, invoked.stderr).toBe(1);
    expect(invoked.stderr).toContain(`unsafe cache ancestor: ${unsafeParent}`);
    expect(existsSync(join(base, "wolfpack-bridge"))).toBe(false);
  });

  test("staging regression: concurrent first users receive one complete prepared generation", async () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-stage-concurrent-first-use-")));
    const { packageBin } = createPackageRunnerFixture(fixtureRoot);
    rmSync(join(fixtureRoot, "cache"), { recursive: true, force: true });
    const environment = packageFixtureEnvironment(fixtureRoot);
    const launcher = join(packageBin, "run.cjs");

    const [first, second] = await Promise.all([
      runOwnedLauncher(launcher, fixtureRoot, environment, 10_000),
      runOwnedLauncher(launcher, fixtureRoot, environment, 10_000),
    ]);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(first.signal).toBeNull();
    expect(second.signal).toBeNull();
    expect(first.stdout).toBe("wolfpack --version\n");
    expect(second.stdout).toBe("wolfpack --version\n");
    const stagedRoot = join(fixtureRoot, "cache", "wolfpack-bridge", "platform-pairs");
    const generations = readdirSync(stagedRoot).filter((entry) => !entry.startsWith("."));
    expect(generations).toHaveLength(1);
    const generation = join(stagedRoot, generations[0]!);
    expect(readdirSync(generation).sort()).toEqual(["pair.json", "wolfpack", "wolfpack-broker"]);
  }, 20_000);

  test("staging regression: boundary collision preserves an injected invalid generation", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-stage-publication-collision-")));
    const { packageBin } = createPackageRunnerFixture(fixtureRoot);
    const environment = packageFixtureEnvironment(fixtureRoot);
    const launcher = join(packageBin, "run.cjs");
    const seed = spawnSync(process.execPath, [launcher, "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: environment,
      timeout: 10_000,
    });
    expect(seed.status, String(seed.stderr)).toBe(0);
    const stagedRoot = join(fixtureRoot, "cache", "wolfpack-bridge", "platform-pairs");
    const generationName = readdirSync(stagedRoot).find((entry) => !entry.startsWith("."));
    expect(generationName).toBeDefined();
    const generation = join(stagedRoot, generationName!);
    rmSync(generation, { recursive: true, force: true });
    const receiptPath = join(fixtureRoot, "collision-receipt.json");
    const injectedLauncher = `
      const Module = require("node:module");
      const load = Module._load;
      const generation = ${JSON.stringify(generation)};
      const stagedRoot = ${JSON.stringify(stagedRoot)};
      const receiptPath = ${JSON.stringify(receiptPath)};
      let injected = false;
      Module._load = function(request, parent, isMain) {
        const fs = load.call(this, request, parent, isMain);
        if (request !== "node:fs") return fs;
        return {
          ...fs,
          mkdirSync(path, options) {
            if (!injected && path === generation) {
              injected = true;
              fs.mkdirSync(path, { mode: 0o700 });
              fs.writeFileSync(receiptPath, JSON.stringify({ kind: "generation-collision", target: path, inode: fs.statSync(path).ino }) + "\\n");
            }
            return fs.mkdirSync(path, options);
          },
        };
      };
      require(process.argv[1]);
    `;
    const nodeRuntime = Bun.which("node");
    if (!nodeRuntime) throw new Error("missing node runtime for child-local filesystem injection");
    const collided = spawnSync(realpathSync(nodeRuntime), ["--eval", injectedLauncher, launcher, "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: environment,
      timeout: 10_000,
    });
    const receipt = JSON.parse(readFileSync(receiptPath, "utf-8")) as { readonly kind: string; readonly target: string; readonly inode: number };
    expect(receipt).toEqual({ kind: "generation-collision", target: generation, inode: receipt.inode });
    expect(collided.status).toBe(1);
    expect(collided.stderr).toContain(`wolfpack: staged generation is invalid: ${generation}`);
    expect(statSync(generation).ino).toBe(receipt.inode);
    expect(readdirSync(generation)).toEqual([]);
  }, 20_000);

  test("staging regression: rejects a redirected cache namespace before publication", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-stage-namespace-")));
    const { packageBin } = createPackageRunnerFixture(fixtureRoot);
    mkdirSync(join(fixtureRoot, "alternate"), { recursive: true });
    symlinkSync(join(fixtureRoot, "alternate"), join(fixtureRoot, "cache", "wolfpack-bridge"));

    const result = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot),
      timeout: 2500,
    });

    expect(result.status).toBe(1);
    expect(existsSync(join(fixtureRoot, "alternate", "platform-pairs"))).toBe(false);
  });

  test.each(["EACCES", "EROFS", "ENOSPC"] as const)("staging regression: reports cache %s without missing-package advice", (code) => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-stage-error-")));
    const { packageBin } = createPackageRunnerFixture(fixtureRoot);
    const namespace = join(fixtureRoot, "cache", "wolfpack-bridge");
    const receiptPath = join(fixtureRoot, "fault.json");
    const nodeRuntime = Bun.which("node");
    if (!nodeRuntime) throw new Error("missing Node for child-local filesystem failure injection");
    const launcher = `
      const Module = require("node:module");
      const load = Module._load;
      Module._load = function(request, parent, isMain) {
        const fs = load.call(this, request, parent, isMain);
        if (request !== "node:fs") return fs;
        return { ...fs, mkdirSync(path, options) {
          if (path === ${JSON.stringify(namespace)}) {
            fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ code: ${JSON.stringify(code)}, path }));
            throw Object.assign(new Error("injected filesystem failure"), { code: ${JSON.stringify(code)}, path });
          }
          return fs.mkdirSync(path, options);
        }};
      };
      require(process.argv[1]);
    `;
    const invoked = spawnSync(realpathSync(nodeRuntime), ["--eval", launcher, join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot),
      timeout: 2500,
    });
    expect(JSON.parse(readFileSync(receiptPath, "utf-8"))).toEqual({ code, path: namespace });
    expect(invoked.status).toBe(1);
    expect(invoked.stderr).toContain(code);
    expect(invoked.stderr).toContain(namespace);
    expect(invoked.stderr).not.toContain("optional dependencies");
    expect(invoked.stderr).not.toContain("no binary found");
    expect(existsSync(namespace)).toBe(false);
  });

  test("package runner ignores a stale local executable and preserves read-only package sources", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-readonly-package-")));
    const { packageBin, platformRoot, server, broker } = createPackageRunnerFixture(fixtureRoot);
    writeExecutable(join(packageBin, "wolfpack"), "#!/bin/sh\nprintf 'STALE LOCAL BINARY\\n'\n");
    const sourceBytes = [readFileSync(server), readFileSync(broker)];
    chmodSync(server, 0o444);
    chmodSync(broker, 0o444);
    chmodSync(platformRoot, 0o555);
    try {
      for (const attempt of [1, 2]) {
        const invoked = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
          cwd: fixtureRoot,
          encoding: "utf-8",
          env: packageFixtureEnvironment(fixtureRoot),
          timeout: 2500,
        });
        expect(invoked.status, `attempt ${attempt}: ${invoked.stderr}`).toBe(0);
        expect(invoked.stdout).toBe("wolfpack --version\n");
        expect([readFileSync(server), readFileSync(broker)]).toEqual(sourceBytes);
        expect([statSync(server).mode & 0o777, statSync(broker).mode & 0o777]).toEqual([0o444, 0o444]);
      }
    } finally {
      chmodSync(platformRoot, 0o755);
    }
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
    expect(invoked.stdout).toBe("");
    expect(existsSync(join(fixtureRoot, "cache", "wolfpack-bridge"))).toBe(false);
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

  test("macOS command-boundary fixture prepares staged copies once and preserves package sources", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-package-runner-macos-")));
    const { packageBin, platformRoot, server, broker } = createPackageRunnerFixture(fixtureRoot, { target: "darwin-arm64" });
    const commandBin = join(fixtureRoot, "command-bin");
    const commandLog = join(fixtureRoot, "commands.log");
    mkdirSync(commandBin, { recursive: true });
    const sourceBytes = [readFileSync(server), readFileSync(broker)];
    const sourceModes = [statSync(server).mode, statSync(broker).mode];
    const receiptWriter = join(commandBin, "record-command.cjs");
    writeFileSync(receiptWriter, `
      const { appendFileSync } = require("node:fs");
      const [tool, ...argv] = process.argv.slice(2);
      if (!tool || !process.env.PACKAGE_RUNNER_TEST_LOG) process.exit(1);
      appendFileSync(process.env.PACKAGE_RUNNER_TEST_LOG, JSON.stringify({ tool, argv }) + "\\n");
    `);
    writeExecutable(join(commandBin, "xattr"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(receiptWriter)} xattr "$@"\n`);
    writeExecutable(join(commandBin, "codesign"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(receiptWriter)} codesign "$@"\n`);
    writeFileSync(commandLog, "");

    const nodeRuntime = Bun.which("node");
    if (!nodeRuntime) throw new Error("missing Node for the macOS command-boundary fixture");
    const runner = ["-e", `
      const Module = require("node:module");
      const os = require("node:os");
      const load = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === "node:os") return { ...os, platform: () => "darwin", arch: () => "arm64" };
        return load.call(this, request, parent, isMain);
      };
      const platformLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        const loaded = platformLoad.call(this, request, parent, isMain);
        if (request !== "node:fs" || process.env.PACKAGE_RUNNER_TEST_FORBID_COPY !== "true") return loaded;
        return { ...loaded, copyFileSync() { throw new Error("warm launch attempted a payload copy"); } };
      };
      require(process.argv[1]);
    `, join(packageBin, "run.cjs"), "--version"];
    const environment = packageFixtureEnvironment(fixtureRoot, {
      PATH: `${commandBin}:/usr/bin:/bin`,
      PACKAGE_RUNNER_TEST_LOG: commandLog,
    });
    const result = spawnSync(realpathSync(nodeRuntime), runner, {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: environment,
      timeout: 2500,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("wolfpack --version\n");
    expect([readFileSync(server), readFileSync(broker)]).toEqual(sourceBytes);
    expect([statSync(server).mode, statSync(broker).mode]).toEqual(sourceModes);
    const stagedRoot = join(fixtureRoot, "cache", "wolfpack-bridge", "platform-pairs");
    const generation = readdirSync(stagedRoot).find((entry) => !entry.startsWith("."));
    expect(generation).toBeDefined();
    const publishedPair = join(stagedRoot, generation!);
    const receipts = readFileSync(commandLog, "utf-8").trim().split("\n").map((line) => {
      const receipt: unknown = JSON.parse(line);
      if (
        !receipt || typeof receipt !== "object"
        || typeof (receipt as { tool?: unknown }).tool !== "string"
        || !Array.isArray((receipt as { argv?: unknown }).argv)
        || !(receipt as { argv: unknown[] }).argv.every((argument) => typeof argument === "string")
      ) throw new Error(`invalid command receipt: ${line}`);
      return receipt as { readonly tool: string; readonly argv: readonly string[] };
    });
    const stagedServer = receipts[0]?.argv[1];
    if (!stagedServer) throw new Error("missing staged server command receipt");
    expect(stagedServer).toBe(join(publishedPair, "wolfpack"));
    expect(receipts).toEqual([
      { tool: "xattr", argv: ["-cr", stagedServer] },
      { tool: "codesign", argv: ["--sign", "-", "--force", stagedServer] },
      { tool: "xattr", argv: ["-cr", join(dirname(stagedServer), "wolfpack-broker")] },
      { tool: "codesign", argv: ["--sign", "-", "--force", join(dirname(stagedServer), "wolfpack-broker")] },
    ]);
    expect(dirname(stagedServer)).toBe(publishedPair);

    const warm = spawnSync(realpathSync(nodeRuntime), runner, {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: { ...environment, PACKAGE_RUNNER_TEST_FORBID_COPY: "true" },
      timeout: 2500,
    });
    expect(warm.status).toBe(0);
    expect(readFileSync(commandLog, "utf-8").trim().split("\n").map((line) => JSON.parse(line))).toEqual(receipts);
    // This is a shell-stub command boundary, not native macOS signing/Gatekeeper evidence.
    expect(platformRoot).toContain("wolfpack-bridge-darwin-arm64");
  }, 6000);

  test.each(["prepare", "publish"] as const)("staging preserves an incomplete generation after %s failure without executing it", (failure) => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-incomplete-stage-")));
    const { packageBin, server, broker } = createPackageRunnerFixture(fixtureRoot, { target: "darwin-arm64" });
    const stagedRoot = join(fixtureRoot, "cache", "wolfpack-bridge", "platform-pairs");
    const receiptPath = join(fixtureRoot, "failure.json");
    const nodeRuntime = Bun.which("node");
    if (!nodeRuntime) throw new Error("missing Node for the failure boundary fixture");
    const sourceBytes = [readFileSync(server), readFileSync(broker)];
    const boundary = `
      const Module = require("node:module");
      const fs = require("node:fs");
      const path = require("node:path");
      const load = Module._load;
      const root = ${JSON.stringify(stagedRoot)};
      const failure = ${JSON.stringify(failure)};
      const record = (operation, target) => fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ operation, target }));
      Module._load = function(request, parent, isMain) {
        const loaded = load.call(this, request, parent, isMain);
        if (request === "node:os") return { ...loaded, platform: () => "darwin", arch: () => "arm64" };
        if (request === "node:child_process") return { ...loaded, execFileSync(command, args, options) {
          if (command !== "xattr" && command !== "codesign") return loaded.execFileSync(command, args, options);
          const target = args[args.length - 1];
          if (!target.startsWith(root + path.sep)) throw new Error("preparation escaped fixture");
          if (failure === "prepare") {
            record("prepare", target);
            throw Object.assign(new Error("fixture preparation refused"), { status: 17 });
          }
          return null;
        }};
        if (request === "node:fs") return { ...loaded, renameSync(source, target) {
          if (failure === "publish" && target.startsWith(root + path.sep) && source === path.join(path.dirname(target), ".pair.json")) {
            record("publish", target);
            throw Object.assign(new Error("fixture publication refused"), { code: "EROFS", path: target });
          }
          return loaded.renameSync(source, target);
        }};
        return loaded;
      };
      require(process.argv[1]);
    `;
    const invoked = spawnSync(realpathSync(nodeRuntime), ["--eval", boundary, join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot),
      timeout: 2500,
    });
    const generations = readdirSync(stagedRoot);
    expect(generations).toHaveLength(1);
    const generation = join(stagedRoot, generations[0]!);
    const target = join(generation, failure === "prepare" ? "wolfpack" : "pair.json");
    expect(JSON.parse(readFileSync(receiptPath, "utf-8"))).toEqual({ operation: failure, target });
    expect(invoked.status).toBe(1);
    expect(invoked.stdout).toBe("");
    expect(invoked.stderr).toContain(failure === "prepare" ? "could not prepare staged binary" : "EROFS");
    expect(invoked.stderr).not.toContain("optional dependencies enabled");
    expect(existsSync(join(generation, "pair.json"))).toBe(false);
    expect([readFileSync(server), readFileSync(broker)]).toEqual(sourceBytes);
    const inode = statSync(generation).ino;
    const retained = readdirSync(generation).sort();
    const retry = spawnSync(realpathSync(nodeRuntime), ["--eval", boundary, join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot),
      timeout: 10_000,
    });
    expect(retry.status).toBe(1);
    expect(retry.stdout).toBe("");
    expect(retry.stderr).toContain("A writer may still be active");
    expect(retry.stderr).toContain("only after confirming no launcher is using it");
    expect(statSync(generation).ino).toBe(inode);
    expect(readdirSync(generation).sort()).toEqual(retained);
  }, 20_000);

  test("retained legacy installer clears macOS provenance and signs both binaries", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-package-postinstall-")));
    const packageRoot = join(fixtureRoot, "node_modules", "wolfpack-bridge");
    const packageBin = join(packageRoot, "bin");
    const platformRoot = join(fixtureRoot, "node_modules", "wolfpack-bridge-darwin-arm64");
    const commandBin = join(fixtureRoot, "command-bin");
    const commandLog = join(fixtureRoot, "commands.log");
    mkdirSync(packageBin, { recursive: true });
    mkdirSync(platformRoot, { recursive: true });
    mkdirSync(commandBin, { recursive: true });
    writeFileSync(join(packageBin, "install.cjs"), readFileSync(join(process.cwd(), "bin", "install.cjs")));
    writeFileSync(join(platformRoot, "package.json"), JSON.stringify({ name: "wolfpack-bridge-darwin-arm64", version: "test" }));
    writeFileSync(join(platformRoot, "wolfpack"), "server\n");
    writeFileSync(join(platformRoot, "wolfpack-broker"), "broker\n");
    writeExecutable(join(commandBin, "xattr"), "#!/bin/sh\nprintf 'xattr %s\\n' \"$*\" >> \"$POSTINSTALL_TEST_LOG\"\n");
    writeExecutable(join(commandBin, "codesign"), "#!/bin/sh\nprintf 'codesign %s\\n' \"$*\" >> \"$POSTINSTALL_TEST_LOG\"\n");
    writeFileSync(commandLog, "");

    const result = spawnSync("node", ["-e", `
      const Module = require("node:module");
      const os = require("node:os");
      const load = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === "node:os") return { ...os, platform: () => "darwin", arch: () => "arm64" };
        return load.call(this, request, parent, isMain);
      };
      require(process.argv[1]);
    `, join(packageBin, "install.cjs")], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${commandBin}:${process.env.PATH}`,
        POSTINSTALL_TEST_LOG: commandLog,
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(commandLog, "utf-8")).toBe([
      `xattr -cr ${join(packageBin, "wolfpack")}`,
      `codesign --sign - --force ${join(packageBin, "wolfpack")}`,
      `xattr -cr ${join(packageBin, "wolfpack-broker")}`,
      `codesign --sign - --force ${join(packageBin, "wolfpack-broker")}`,
      "",
    ].join("\n"));
  });
});

describe("install.sh release binary staging", () => {
  test("Linux pseudo-tty invocation keeps spaced repository paths out of the shell command", () => {
    const repositoryCwd = "/tmp/wolfpack checkout with spaces";
    const invocation = scriptInvocation("linux", repositoryCwd);

    expect(invocation.cwd).toBe(repositoryCwd);
    expect(invocation.args).toEqual(["-q", "-e", "-c", "bash install.sh", "/dev/null"]);
  });

  test("normal completion hands setup to the newly installed managed binary", () => {
    const fixture = prepareFixture();
    const result = runInstallerWithSetup(fixture);

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.commandLog, "utf-8")).toBe("setup\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("new server\n");
    const retainedStagingDirectories = installerStagingDirectories(fixture.installDir);
    expect(retainedStagingDirectories).toHaveLength(1);
    expect(readdirSync(join(
      fixture.installDir,
      retainedStagingDirectories[0] ?? "missing-staging-directory",
    ))).toEqual(["checksums-sha256.txt"]);
  });

  test("a normal upgrade completes managed setup before restarting the service", () => {
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
    expect(readFileSync(fixture.commandLog, "utf-8").trim().split("\n")).toEqual([
      "setup --defer-service-restart",
      "service restart --server-only",
    ]);
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
    expect(readFileSync(fixture.commandLog, "utf-8")).toBe("");
  });

  test("does not restart an upgrade when setup fails", () => {
    const fixture = prepareFixture();
    const serviceDir = join(fixture.home, ".config", "systemd", "user");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "wolfpack.service"), "installed\n");
    writeFileSync(join(fixture.home, ".wolfpack", "config.json"), JSON.stringify({
      devDir: join(fixture.home, "Dev"),
      port: 18790,
    }));

    const result = runInstallerWithSetup(fixture, { INSTALL_TEST_FAIL_SETUP: "1" });

    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.commandLog, "utf-8").trim()).toBe("setup --defer-service-restart");
  });

  test("exits nonzero when the final server-only restart fails", () => {
    const fixture = prepareFixture();
    const serviceDir = join(fixture.home, ".config", "systemd", "user");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "wolfpack.service"), "installed\n");
    writeFileSync(join(fixture.home, ".wolfpack", "config.json"), JSON.stringify({
      devDir: join(fixture.home, "Dev"),
      port: 18790,
    }));

    const result = runInstallerWithSetup(fixture, { INSTALL_TEST_FAIL_RESTART: "1" });

    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.commandLog, "utf-8").trim().split("\n")).toEqual([
      "setup --defer-service-restart",
      "service restart --server-only",
    ]);
  });

  test("a skip-setup upgrade still restarts through the managed binary", () => {
    const fixture = prepareFixture();
    const serviceDir = join(fixture.home, ".config", "systemd", "user");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "wolfpack.service"), "installed\n");
    writeFileSync(join(fixture.home, ".wolfpack", "config.json"), "{}\n");

    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.commandLog, "utf-8").trim()).toBe("service restart --server-only");
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
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("new server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("new broker\n");
    expect(statSync(join(fixture.installDir, "wolfpack")).mode & 0o111).not.toBe(0);
    expect(statSync(join(fixture.installDir, "wolfpack-broker")).mode & 0o111).not.toBe(0);
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
