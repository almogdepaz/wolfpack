import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  readonly serverAsset: string;
  readonly brokerAsset: string;
  readonly serviceLog: string;
  readonly serviceState: string;
  readonly ttyStdout: string;
  readonly descriptorRemoved: string;
} {
  fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-install-")));
  const home = join(fixtureRoot, "home");
  const bin = join(fixtureRoot, "bin");
  const systemBin = join(fixtureRoot, "system-bin");
  const log = join(fixtureRoot, "downloads.log");
  const commandLog = join(fixtureRoot, "commands.log");
  const installDir = join(home, ".wolfpack", "bin");
  const checksums = join(fixtureRoot, "checksums-sha256.txt");
  const serverAsset = join(fixtureRoot, "wolfpack-linux-x64");
  const brokerAsset = join(fixtureRoot, "wolfpack-broker-linux-x64");
  const serviceLog = join(fixtureRoot, "service.log");
  const serviceState = join(fixtureRoot, "service-state");
  const ttyStdout = join(fixtureRoot, "tty-stdout.log");
  const descriptorRemoved = join(fixtureRoot, "descriptor-removed");
  mkdirSync(installDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(systemBin, { recursive: true });
  writeFileSync(log, "");
  writeFileSync(commandLog, "");
  writeFileSync(serviceLog, "");
  writeFileSync(ttyStdout, "");
  const serverAssetContent = "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf '%s\\n' \"$INSTALL_TEST_RELEASE_VERSION\"; exit 0; fi\n[ -z \"$INSTALL_TEST_COMMAND_LOG\" ] || printf \"%s\\n\" \"$*\" >> \"$INSTALL_TEST_COMMAND_LOG\"\nif [ \"$INSTALL_TEST_REQUIRE_SETUP_STDOUT_TTY\" = \"1\" ] && [ \"$1\" = \"setup\" ] && [ ! -t 1 ]; then exit 48; fi\nif [ \"$INSTALL_TEST_FAIL_SETUP\" = \"1\" ] && [ \"$1\" = \"setup\" ]; then exit 42; fi\nif [ \"$INSTALL_TEST_FAIL_ACTIVATION\" = \"1\" ] && [ \"$1\" = \"service\" ] && [ \"$2\" = \"install\" ]; then exit 43; fi\nif [ \"$1\" = \"service\" ] && [ \"$2\" = \"install\" ]; then printf active > \"${INSTALL_TEST_SERVICE_STATE}.server\"; printf active > \"${INSTALL_TEST_SERVICE_STATE}.broker\"; fi\nprintf \"new server\\n\"\n";
  const brokerAssetContent = "#!/bin/sh\nprintf \"new broker\\n\"\n";
  writeFileSync(serverAsset, serverAssetContent);
  writeFileSync(brokerAsset, brokerAssetContent);
  const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");
  writeFileSync(checksums, `${sha256(serverAssetContent)}  wolfpack-linux-x64\n${sha256(brokerAssetContent)}  wolfpack-broker-linux-x64\n`);

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
if [ "$INSTALL_TEST_STALL_TTY" = "1" ]; then sleep 30; fi
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
    if [ "$INSTALL_TEST_DIRECTORY_BROKER" = "1" ]; then mkdir "$output"; exit 0; fi
    if [ "$INSTALL_TEST_EMPTY_BROKER" != "1" ]; then cat "$INSTALL_TEST_BROKER_ASSET" > "$output"; fi
    ;;
  *wolfpack-linux-x64)
    cat "$INSTALL_TEST_SERVER_ASSET" > "$output"
    ;;
  *) exit 22 ;;
esac
`);

  writeExecutable(join(bin, "systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$INSTALL_TEST_SERVICE_LOG"
case "$*" in
  "--user is-active wolfpack") [ -f "\${INSTALL_TEST_SERVICE_STATE}.server" ] && printf 'active\\n' || exit 3 ;;
  "--user is-active wolfpack-broker") [ -f "\${INSTALL_TEST_SERVICE_STATE}.broker" ] && printf 'active\\n' || exit 3 ;;
  "--user stop wolfpack") [ "$INSTALL_TEST_FAIL_SERVER_STOP" = "1" ] && exit 44; rm -f "\${INSTALL_TEST_SERVICE_STATE}.server" ;;
  "--user stop wolfpack-broker") [ "$INSTALL_TEST_FAIL_BROKER_STOP" = "1" ] && exit 45; rm -f "\${INSTALL_TEST_SERVICE_STATE}.broker" ;;
esac
`);
  writeExecutable(join(bin, "rm"), `#!/bin/sh
for path in "$@"; do
  case "$path" in
    *wolfpack.service|*wolfpack-broker.service)
      [ "$INSTALL_TEST_FAIL_DESCRIPTOR_REMOVE" = "1" ] && exit 46
      touch "$INSTALL_TEST_DESCRIPTOR_REMOVED" ;;
    */.wolfpack/bin/wolfpack|*/.wolfpack/bin/wolfpack-broker)
      [ "$INSTALL_TEST_REQUIRE_DESCRIPTOR_BEFORE_BINARY" = "1" ] && [ ! -f "$INSTALL_TEST_DESCRIPTOR_REMOVED" ] && exit 47 ;;
  esac
done
exec /bin/rm "$@"
`);

  return { home, bin, systemBin, log, commandLog, installDir, checksums, serverAsset, brokerAsset, serviceLog, serviceState, ttyStdout, descriptorRemoved };
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
    INSTALL_TEST_FAIL_ACTIVATION: "0",
    INSTALL_TEST_FAIL_SERVER_STOP: "0",
    INSTALL_TEST_FAIL_BROKER_STOP: "0",
    INSTALL_TEST_FAIL_DESCRIPTOR_REMOVE: "0",
    INSTALL_TEST_DIRECTORY_BROKER: "0",
    INSTALL_TEST_SERVER_ASSET: fixture.serverAsset,
    INSTALL_TEST_BROKER_ASSET: fixture.brokerAsset,
    INSTALL_TEST_SERVICE_LOG: fixture.serviceLog,
    INSTALL_TEST_SERVICE_STATE: fixture.serviceState,
    INSTALL_TEST_TTY_STDOUT: fixture.ttyStdout,
    INSTALL_TEST_DESCRIPTOR_REMOVED: fixture.descriptorRemoved,
    INSTALL_TEST_REQUIRE_DESCRIPTOR_BEFORE_BINARY: "0",
    INSTALL_TEST_STALL_TTY: "0",
    INSTALL_TEST_REQUIRE_SETUP_STDOUT_TTY: "0",
    INSTALL_TEST_RELEASE_VERSION: "1.6.20",
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
  if (setsidPath) {
    return spawnSync(setsidPath, ["--wait", "bash", join(process.cwd(), "install.sh")], {
      encoding: "utf-8",
      env: installerEnvironment(fixture, extraEnv),
    });
  }
  const python = Bun.which("python3");
  if (!python) throw new Error("missing Python required for the detached installer fixture");
  return spawnSync(python, ["-c", "import os, sys; os.setsid(); os.execvp('bash', ['bash', sys.argv[1]])", join(process.cwd(), "install.sh")], {
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

function runPipedInstallerWithTty(
  fixture: ReturnType<typeof prepareFixture>,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  const python = Bun.which("python3");
  if (!python) throw new Error("missing Python required for the controlling-TTY fixture");
  const harness = String.raw`
import errno, os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.chdir(sys.argv[1])
    os.execvp("bash", ["bash", "-c", "printf 'installer\\n' | bash install.sh > \"$INSTALL_TEST_TTY_STDOUT\""])
output = b""
pty_open = True
normalize_post_consent_eof = False

def reap_until(deadline):
    while time.monotonic() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done: return status
        time.sleep(0.01)
    return None

def terminate_and_reap():
    try: os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    status = reap_until(time.monotonic() + 1)
    if status is not None: return status
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    _, status = os.waitpid(pid, 0)
    return status

def finalize(status, *, exit_code=None, read_error=None):
    sys.stdout.buffer.write(output)
    if read_error is not None:
        print(f"controlling TTY read failed: {read_error}", file=sys.stderr)
        raise read_error
    if exit_code is not None:
        print("controlling TTY fixture timed out", file=sys.stderr)
        raise SystemExit(exit_code)
    raise SystemExit(os.waitstatus_to_exitcode(status))

def read_pty():
    global output
    try:
        chunk = os.read(fd, 4096)
        if not chunk and normalize_post_consent_eof:
            raise OSError(errno.EIO, "normalized PTY EOF")
    except OSError as error:
        if error.errno == errno.EIO: return False
        raise
    if not chunk: return False
    output += chunk
    return True

def capture_ready(timeout):
    global pty_open
    if not pty_open: return False
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready: return False
    pty_open = read_pty()
    return True

def drain_after_exit(status):
    try:
        while pty_open and time.monotonic() < deadline and capture_ready(0): pass
    except OSError as error:
        finalize(status, read_error=error)
    if pty_open and time.monotonic() >= deadline:
        finalize(status, exit_code=124)
    finalize(status)

def timeout():
    finalize(terminate_and_reap(), exit_code=124)

def fail_read(error):
    finalize(terminate_and_reap(), read_error=error)

deadline = time.monotonic() + 3
while b"Continue with session loss? [y/N]" not in output:
    if time.monotonic() >= deadline: timeout()
    try: capture_ready(0.1)
    except OSError as error: fail_read(error)
    done, status = os.waitpid(pid, os.WNOHANG)
    if done: drain_after_exit(status)
os.write(fd, b"y\r")
deadline = time.monotonic() + 3
normalize_post_consent_eof = os.environ.get("INSTALL_TEST_NORMALIZE_PTY_EOF") == "1"
while True:
    if time.monotonic() >= deadline: timeout()
    try: capture_ready(0.1)
    except OSError as error: fail_read(error)
    done, status = os.waitpid(pid, os.WNOHANG)
    if done: drain_after_exit(status)
`;
  return spawnSync(python, ["-c", harness, process.cwd()], {
    encoding: "utf-8",
    env: installerEnvironment(fixture, extraEnv),
  });
}

function installedOutput(path: string): string {
  return spawnSync(path, [], { encoding: "utf-8" }).stdout;
}

function installerStagingDirectories(installDir: string): readonly string[] {
  return readdirSync(installDir).filter((entry) => entry.startsWith(".install."));
}

function prepareInstalledServices(fixture: ReturnType<typeof prepareFixture>): void {
  const serviceDir = join(fixture.home, ".config", "systemd", "user");
  mkdirSync(serviceDir, { recursive: true });
  writeFileSync(join(serviceDir, "wolfpack.service"), "server\n");
  writeFileSync(join(serviceDir, "wolfpack-broker.service"), "broker\n");
  writeFileSync(join(fixture.home, ".wolfpack", "config.json"), JSON.stringify({
    devDir: join(fixture.home, "Dev"),
    port: 18790,
  }));
  writeFileSync(`${fixture.serviceState}.server`, "active\n");
  writeFileSync(`${fixture.serviceState}.broker`, "active\n");
}

function prepareMatchingMacOsCliActivation(fixture: ReturnType<typeof prepareFixture>): string {
  const macServiceLog = join(fixtureRoot, "mac-service.log");
  const macServerState = join(fixtureRoot, "mac-server-active");
  const macBrokerState = join(fixtureRoot, "mac-broker-active");
  const preload = join(fixtureRoot, "mac-service-preload.ts");
  const launchctl = join(fixture.bin, "launchctl");
  const server = `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' "$INSTALL_TEST_RELEASE_VERSION"; exit 0; fi
exec ${JSON.stringify(process.execPath)} --preload ${JSON.stringify(preload)} ${JSON.stringify(join(process.cwd(), "src", "cli", "index.ts"))} "$@"
`;
  const broker = "#!/bin/sh\nexit 0\n";
  const checksum = (content: string): string => createHash("sha256").update(content).digest("hex");
  writeFileSync(macServiceLog, "");
  writeFileSync(macBrokerState, "active\n");
  writeExecutable(launchctl, `#!/bin/sh
printf '%s\\n' "$*" >> "$INSTALL_TEST_MAC_SERVICE_LOG"
case "$1" in
  print)
    case "$2" in
      *com.wolfpack.server) state="$INSTALL_TEST_MAC_SERVER_STATE" ;;
      *com.wolfpack.broker) state="$INSTALL_TEST_MAC_BROKER_STATE" ;;
    esac
    [ -f "$state" ] && printf 'pid = 123\\n' || exit 113
    ;;
  bootout)
    case "$2" in
      *com.wolfpack.server) rm -f "$INSTALL_TEST_MAC_SERVER_STATE" ;;
      *com.wolfpack.broker) rm -f "$INSTALL_TEST_MAC_BROKER_STATE" ;;
    esac
    ;;
  kickstart)
    case "$2" in
      *com.wolfpack.server) [ "$INSTALL_TEST_MAC_SKIP_SERVER_START" = "1" ] || { touch "$INSTALL_TEST_MAC_SERVER_STATE"; touch "\${INSTALL_TEST_SERVICE_STATE}.server"; } ;;
      *com.wolfpack.broker) touch "$INSTALL_TEST_MAC_BROKER_STATE" ;;
    esac
    ;;
esac
`);
  writeFileSync(preload, `
    import { mock } from "bun:test";
    import { join } from "node:path";
    const config = await import(${JSON.stringify(join(process.cwd(), "src", "cli", "config.ts"))});
    await mock.module(${JSON.stringify(join(process.cwd(), "src", "cli", "config.ts"))}, () => ({
      ...config,
      WOLFPACK_DIR: join(process.env.HOME!, ".wolfpack"),
      IS_MACOS: true,
      IS_LINUX: false,
      isPortInUse: () => false,
      waitForPortFree: () => undefined,
    }));
  `);
  writeExecutable(fixture.serverAsset, server);
  writeExecutable(fixture.brokerAsset, broker);
  writeExecutable(join(fixture.installDir, "wolfpack"), server);
  writeExecutable(join(fixture.installDir, "wolfpack-broker"), broker);
  writeFileSync(fixture.checksums, `${checksum(server)}  wolfpack-linux-x64\n${checksum(broker)}  wolfpack-broker-linux-x64\n`);
  return macServiceLog;
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

  test("package runner directly executes an exact immutable executable pair with its colocated broker", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-direct-package-runner-")));
    const { packageBin, platformRoot, server, broker } = createPackageRunnerFixture(fixtureRoot);
    writeExecutable(server, "#!/bin/sh\n\"$(dirname \"$0\")/wolfpack-broker\" --version\nprintf 'wolfpack %s\\n' \"$*\"\n");
    writeExecutable(broker, "#!/bin/sh\nprintf 'broker %s\\n' \"$*\"\n");
    writeExecutable(join(packageBin, "wolfpack"), "#!/bin/sh\nprintf 'STALE LOCAL BINARY\\n'\n");
    const sourceBytes = [readFileSync(server), readFileSync(broker)];
    const sourceModes = [statSync(server).mode & 0o777, statSync(broker).mode & 0o777];

    const invoked = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: packageFixtureEnvironment(fixtureRoot),
      timeout: 2500,
    });

    expect(invoked.status, invoked.stderr).toBe(0);
    expect(invoked.stdout).toBe("broker --version\nwolfpack --version\n");
    expect(existsSync(join(fixtureRoot, "cache", "wolfpack-bridge"))).toBe(false);
    expect([readFileSync(server), readFileSync(broker)]).toEqual(sourceBytes);
    expect([statSync(server).mode & 0o777, statSync(broker).mode & 0o777]).toEqual(sourceModes);
    expect(platformRoot).toContain("wolfpack-bridge-");
  });

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
    rmSync(join(fixture.installDir, "wolfpack"));
    rmSync(join(fixture.installDir, "wolfpack-broker"));

    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    expect(String(result.stdout).toLowerCase()).not.toContain("tmux");
    expect(readFileSync(fixture.serviceLog, "utf-8")).not.toContain("--user stop");
    expect(readFileSync(fixture.commandLog, "utf-8")).not.toContain("service install");
    expect(existsSync(`${fixture.serviceState}.server`)).toBe(false);
    expect(existsSync(`${fixture.serviceState}.broker`)).toBe(false);
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("new server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("new broker\n");
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

  test("a normal upgrade activates the replacement pair once after deferred setup", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);
    rmSync(`${fixture.serviceState}.broker`);

    const result = runInstallerWithSetup(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(fixture.commandLog, "utf-8").trim().split("\n")).toEqual([
      "setup --defer-service-restart",
      "service install --preserve-running-broker",
    ]);
    expect(installerStagingDirectories(fixture.installDir)).toEqual([]);
  });

  test("a matching pair runs setup without implicit restart deferral", () => {
    const fixture = prepareFixture();
    const initial = runInstaller(fixture);
    expect(initial.status).toBe(0);
    prepareInstalledServices(fixture);
    writeFileSync(join(fixture.home, ".wolfpack", "config.json"), JSON.stringify({
      devDir: join(fixture.home, "Changed-Dev"),
      port: 24444,
    }));
    writeFileSync(fixture.commandLog, "");
    writeFileSync(fixture.serviceLog, "");

    const result = runInstallerWithSetup(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(fixture.commandLog, "utf-8")).toBe("setup\n");
    expect(readFileSync(fixture.serviceLog, "utf-8")).not.toMatch(/--user (stop|start|restart)/);
  }, 10_000);

  test("does not replace managed state before setup fails without a controlling tty", () => {
    const fixture = prepareFixture();
    const serviceDir = join(fixture.home, ".config", "systemd", "user");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "wolfpack.service"), "installed\n");
    writeFileSync(join(fixture.home, ".wolfpack", "config.json"), JSON.stringify({
      devDir: join(fixture.home, "Dev"),
      port: 18790,
    }));

    const result = runInstaller(fixture, { WOLFPACK_INSTALL_SKIP_SETUP: "0" });

    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.log, "utf-8")).toContain("wolfpack-linux-x64");
    expect(readFileSync(fixture.commandLog, "utf-8")).toBe("");
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("old server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("old broker\n");
    expect(existsSync(join(serviceDir, "wolfpack.service"))).toBe(true);
  });

  test("does not restart the replacement pair when deferred setup fails", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);
    rmSync(`${fixture.serviceState}.broker`);

    const result = runInstallerWithSetup(fixture, {
      INSTALL_TEST_FAIL_SETUP: "1",
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.commandLog, "utf-8").trim().split("\n")).toEqual([
      "setup --defer-service-restart",
    ]);
  });

  test("exits nonzero when managed service activation fails", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);
    rmSync(`${fixture.serviceState}.broker`);

    const result = runInstallerWithSetup(fixture, {
      INSTALL_TEST_FAIL_ACTIVATION: "1",
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.commandLog, "utf-8").trim().split("\n")).toEqual([
      "setup --defer-service-restart",
      "service install --preserve-running-broker",
    ]);
  });

  test("retries failed activation against a stopped matching pair", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);

    const initial = runInstaller(fixture, {
      WOLFPACK_INSTALL_ALLOW_SESSION_LOSS: "1",
      INSTALL_TEST_FAIL_ACTIVATION: "1",
    });

    expect(initial.status).not.toBe(0);
    expect(String(initial.stdout)).toContain("WOLFPACK_INSTALL_SKIP_SETUP=\"1\"");
    expect(String(initial.stdout)).toContain("WOLFPACK_INSTALL_RETRY_ACTIVATION=\"1\"");
    writeFileSync(fixture.commandLog, "");
    writeFileSync(fixture.serviceLog, "");

    const retry = runInstaller(fixture, { WOLFPACK_INSTALL_RETRY_ACTIVATION: "1" });

    expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
    expect(readFileSync(fixture.commandLog, "utf-8").trim()).toBe("service install --preserve-running-broker");
    expect(existsSync(`${fixture.serviceState}.server`)).toBe(true);
    expect(existsSync(`${fixture.serviceState}.broker`)).toBe(true);
    expect(readFileSync(fixture.serviceLog, "utf-8")).not.toContain("--user stop");
  });

  test("curl activation retry preserves a live macOS broker through the real CLI service boundary", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);
    const macServiceLog = prepareMatchingMacOsCliActivation(fixture);
    rmSync(`${fixture.serviceState}.server`);

    const retry = runInstaller(fixture, {
      WOLFPACK_INSTALL_RETRY_ACTIVATION: "1",
      INSTALL_TEST_MAC_SERVICE_LOG: macServiceLog,
      INSTALL_TEST_MAC_SERVER_STATE: join(fixtureRoot, "mac-server-active"),
      INSTALL_TEST_MAC_BROKER_STATE: join(fixtureRoot, "mac-broker-active"),
    });

    const userId = process.getuid?.();
    if (userId === undefined) throw new Error("macOS launchctl fixture requires process.getuid()");

    expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
    expect(readFileSync(macServiceLog, "utf-8")).not.toContain(`bootout gui/${userId}/com.wolfpack.broker`);
    expect(existsSync(join(fixtureRoot, "mac-broker-active"))).toBe(true);
    expect(existsSync(join(fixtureRoot, "mac-server-active"))).toBe(true);

    rmSync(join(fixtureRoot, "mac-server-active"));
    rmSync(`${fixture.serviceState}.server`);
    const failedActivation = runInstaller(fixture, {
      WOLFPACK_INSTALL_RETRY_ACTIVATION: "1",
      INSTALL_TEST_MAC_SERVICE_LOG: macServiceLog,
      INSTALL_TEST_MAC_SERVER_STATE: join(fixtureRoot, "mac-server-active"),
      INSTALL_TEST_MAC_BROKER_STATE: join(fixtureRoot, "mac-broker-active"),
      INSTALL_TEST_MAC_SKIP_SERVER_START: "1",
    });

    expect(failedActivation.status).not.toBe(0);
    expect(String(failedActivation.stdout)).toContain("WOLFPACK_INSTALL_RETRY_ACTIVATION=\"1\"");
  });

  test("a skip-setup upgrade activates both replacement services through the managed binary", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);

    const result = runInstaller(fixture, { WOLFPACK_INSTALL_ALLOW_SESSION_LOSS: "1" });

    expect(result.status).toBe(0);
    expect(String(result.stdout).match(/Warning: broker-owned sessions will end/g)).toHaveLength(1);
    expect(readFileSync(fixture.commandLog, "utf-8").trim()).toBe("service install --preserve-running-broker");
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

  test.each([
    "release 3.4.5",
    "decorated\n3.4.5",
  ])("rejects decorated staged machine-readable version output %p before mutation", (version) => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);

    const result = runInstaller(fixture, {
      WOLFPACK_INSTALL_ALLOW_SESSION_LOSS: "1",
      INSTALL_TEST_RELEASE_VERSION: version,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("did not report a valid machine-readable version");
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("old server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("old broker\n");
    expect(readFileSync(fixture.serviceLog, "utf-8")).not.toContain("--user stop");
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

  test("a broker download failure preserves both existing binaries before service stop", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);
    const result = runInstaller(fixture, { INSTALL_TEST_FAIL_BROKER: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("wolfpack-broker-linux-x64");
    expect(readFileSync(fixture.serviceLog, "utf-8")).not.toContain("--user stop");
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

  test("rejects a non-regular broker candidate before service stop or installed-state mutation", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);
    const result = runInstaller(fixture, { INSTALL_TEST_DIRECTORY_BROKER: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Downloaded artifact is not a regular file");
    expect(readFileSync(fixture.serviceLog, "utf-8")).not.toContain("--user stop");
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("old server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("old broker\n");
  });

  test("preflights redirected setup stdout before managed mutation with a controlling TTY", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);

    const result = runPipedInstallerWithTty(fixture, {
      WOLFPACK_INSTALL_SKIP_SETUP: "0",
      INSTALL_TEST_REQUIRE_SETUP_STDOUT_TTY: "1",
    });

    expect(result.status).not.toBe(0);
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("old server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("old broker\n");
    expect(readFileSync(fixture.serviceLog, "utf-8")).not.toContain("--user stop");
  });

  test("confirms session loss through the controlling TTY for a curl pipeline", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);

    const result = runPipedInstallerWithTty(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Continue with session loss?");
    expect(readFileSync(fixture.ttyStdout, "utf-8").match(/Warning: broker-owned sessions will end/g)).toHaveLength(1);
    expect(readFileSync(fixture.commandLog, "utf-8")).toContain("service install");
  });

  test("preserves controlling-TTY output and activation failure after normalized PTY EOF", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);

    const result = runPipedInstallerWithTty(fixture, {
      INSTALL_TEST_FAIL_ACTIVATION: "1",
      INSTALL_TEST_NORMALIZE_PTY_EOF: "1",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout, String(result.stderr)).toContain("Continue with session loss?");
    expect(readFileSync(fixture.ttyStdout, "utf-8").match(/Warning: broker-owned sessions will end/g)).toHaveLength(1);
    expect(readFileSync(fixture.commandLog, "utf-8")).toContain("service install");
  });

  test("bounds a stalled controlling-TTY installer and reaps its process", () => {
    const fixture = prepareFixture();
    const startedAt = performance.now();

    const result = runPipedInstallerWithTty(fixture, { INSTALL_TEST_STALL_TTY: "1" });

    expect(result.status).toBe(124);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(result.stderr).toContain("controlling TTY fixture timed out");
  }, 10_000);

  test("requires the unattended session-loss override before replacing a running broker", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("broker-owned sessions will end");
    expect(readFileSync(fixture.serviceLog, "utf-8")).not.toContain("--user stop");
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("old server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("old broker\n");
  });

  test("requires consent before replacing a broker with no descriptor or managed pair", () => {
    const fixture = prepareFixture();
    rmSync(join(fixture.installDir, "wolfpack"));
    rmSync(join(fixture.installDir, "wolfpack-broker"));
    writeFileSync(`${fixture.serviceState}.broker`, "active\n");

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("broker-owned sessions will end");
    expect(readFileSync(fixture.serviceLog, "utf-8")).not.toContain("--user stop");
    expect(existsSync(join(fixture.installDir, "wolfpack"))).toBe(false);
    expect(existsSync(join(fixture.installDir, "wolfpack-broker"))).toBe(false);
  });

  test("recreates and health-checks descriptor-less running managed services after replacement", () => {
    const fixture = prepareFixture();
    rmSync(join(fixture.installDir, "wolfpack"));
    rmSync(join(fixture.installDir, "wolfpack-broker"));
    writeFileSync(`${fixture.serviceState}.server`, "active\n");
    writeFileSync(`${fixture.serviceState}.broker`, "active\n");

    const result = runInstaller(fixture, { WOLFPACK_INSTALL_ALLOW_SESSION_LOSS: "1" });

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.serviceLog, "utf-8")).toContain("--user stop wolfpack");
    expect(readFileSync(fixture.serviceLog, "utf-8")).toContain("--user stop wolfpack-broker");
    expect(readFileSync(fixture.commandLog, "utf-8")).toContain("service install");
    expect(existsSync(`${fixture.serviceState}.server`)).toBe(true);
    expect(existsSync(`${fixture.serviceState}.broker`)).toBe(true);
  }, 10_000);

  test("refuses destructive replacement when either managed service remains active after stopping", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);
    const serviceDir = join(fixture.home, ".config", "systemd", "user");

    const result = runInstaller(fixture, {
      WOLFPACK_INSTALL_ALLOW_SESSION_LOSS: "1",
      INSTALL_TEST_FAIL_BROKER_STOP: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Managed services are still active");
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("old server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("old broker\n");
    expect(existsSync(join(serviceDir, "wolfpack.service"))).toBe(true);
    expect(existsSync(join(serviceDir, "wolfpack-broker.service"))).toBe(true);
  });

  test("removes stopped managed descriptors before replacing either binary", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);
    rmSync(`${fixture.serviceState}.server`);
    rmSync(`${fixture.serviceState}.broker`);

    const result = runInstaller(fixture, {
      WOLFPACK_INSTALL_ALLOW_SESSION_LOSS: "1",
      INSTALL_TEST_REQUIRE_DESCRIPTOR_BEFORE_BINARY: "1",
    });

    expect(result.status).toBe(0);
    expect(existsSync(fixture.descriptorRemoved)).toBe(true);
    expect(existsSync(join(fixture.home, ".config", "systemd", "user", "wolfpack.service"))).toBe(false);
    expect(existsSync(join(fixture.home, ".config", "systemd", "user", "wolfpack-broker.service"))).toBe(false);
  });

  test("aborts before binary deletion when managed descriptor removal fails", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);

    const result = runInstaller(fixture, {
      WOLFPACK_INSTALL_ALLOW_SESSION_LOSS: "1",
      INSTALL_TEST_FAIL_DESCRIPTOR_REMOVE: "1",
    });

    expect(result.status).not.toBe(0);
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("old server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("old broker\n");
  });

  test("replaces the managed pair destructively, preserves unrelated state, and delegates activation", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);
    const config = join(fixture.home, ".wolfpack", "config.json");
    const auth = join(fixture.home, ".wolfpack", "service-auth.json");
    const unrelated = join(fixture.home, ".wolfpack", "receipts", "receipt.json");
    const configContent = readFileSync(config, "utf-8");
    const authContent = '{"WOLFPACK_JWT_SECRET":"preserve-me"}\n';
    mkdirSync(join(fixture.home, ".wolfpack", "receipts"), { recursive: true });
    writeFileSync(auth, authContent);
    writeFileSync(unrelated, "keep me\n");

    const result = runInstaller(fixture, {
      WOLFPACK_INSTALL_ALLOW_SESSION_LOSS: "1",
      INSTALL_TEST_REQUIRE_DESCRIPTOR_BEFORE_BINARY: "1",
    });

    expect(result.status, String(result.stderr)).toBe(0);
    const serviceCommands = readFileSync(fixture.serviceLog, "utf-8").trim().split("\n");
    expect(serviceCommands.indexOf("--user stop wolfpack")).toBeLessThan(serviceCommands.indexOf("--user stop wolfpack-broker"));
    expect(readFileSync(fixture.commandLog, "utf-8")).toContain("service install");
    expect(statSync(join(fixture.installDir, "wolfpack")).mode & 0o777).toBe(0o755);
    expect(statSync(join(fixture.installDir, "wolfpack-broker")).mode & 0o777).toBe(0o755);
    expect(readFileSync(config, "utf-8")).toBe(configContent);
    expect(readFileSync(auth, "utf-8")).toBe(authContent);
    expect(readFileSync(unrelated, "utf-8")).toBe("keep me\n");
    expect(existsSync(`${fixture.serviceState}.broker`)).toBe(true);
    expect(existsSync(`${fixture.serviceState}.server`)).toBe(true);
  });

  test("normalizes matching regular managed binaries to 0755 without service disruption", () => {
    const fixture = prepareFixture();
    const initial = runInstaller(fixture);
    expect(initial.status).toBe(0);
    prepareInstalledServices(fixture);
    chmodSync(join(fixture.installDir, "wolfpack"), 0o700);
    chmodSync(join(fixture.installDir, "wolfpack-broker"), 0o700);
    writeFileSync(fixture.serviceLog, "");
    writeFileSync(fixture.commandLog, "");

    const result = runInstaller(fixture);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(statSync(join(fixture.installDir, "wolfpack")).mode & 0o777).toBe(0o755);
    expect(statSync(join(fixture.installDir, "wolfpack-broker")).mode & 0o777).toBe(0o755);
    expect(readFileSync(fixture.serviceLog, "utf-8")).not.toContain("--user stop");
    expect(readFileSync(fixture.commandLog, "utf-8")).not.toContain("service install");
  });

  test("does not accept symlinked managed binaries as a matching pair", () => {
    const fixture = prepareFixture();
    const initial = runInstaller(fixture);
    expect(initial.status).toBe(0);
    const server = join(fixture.installDir, "wolfpack");
    const broker = join(fixture.installDir, "wolfpack-broker");
    const serverTarget = join(fixtureRoot, "matching-server");
    const brokerTarget = join(fixtureRoot, "matching-broker");
    copyFileSync(server, serverTarget);
    copyFileSync(broker, brokerTarget);
    rmSync(server);
    rmSync(broker);
    symlinkSync(serverTarget, server);
    symlinkSync(brokerTarget, broker);
    prepareInstalledServices(fixture);

    const result = runInstaller(fixture, { WOLFPACK_INSTALL_ALLOW_SESSION_LOSS: "1" });

    expect(result.status, String(result.stderr)).toBe(0);
    expect(lstatSync(server).isSymbolicLink()).toBe(false);
    expect(lstatSync(broker).isSymbolicLink()).toBe(false);
    expect(readFileSync(fixture.serviceLog, "utf-8")).toContain("--user stop wolfpack");
    expect(readFileSync(fixture.serviceLog, "utf-8")).toContain("--user stop wolfpack-broker");
  });

  test("does not stop or recreate services when the installed pair already matches", () => {
    const fixture = prepareFixture();
    const initial = runInstaller(fixture);
    expect(initial.status).toBe(0);
    prepareInstalledServices(fixture);
    writeFileSync(fixture.serviceLog, "");
    writeFileSync(fixture.commandLog, "");

    const result = runInstaller(fixture);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(readFileSync(fixture.serviceLog, "utf-8")).not.toContain("--user stop");
    expect(readFileSync(fixture.commandLog, "utf-8")).not.toContain("service install");
  });

  test("pins the default activation retry to the staged executable version", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);

    const result = runInstaller(fixture, {
      WOLFPACK_INSTALL_ALLOW_SESSION_LOSS: "1",
      INSTALL_TEST_FAIL_ACTIVATION: "1",
      INSTALL_TEST_RELEASE_VERSION: "3.4.5",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("WOLFPACK_RELEASE_TAG=\"v3.4.5\"");
    expect(result.stdout).toContain("raw.githubusercontent.com/almogdepaz/wolfpack/v3.4.5/install.sh");
    expect(result.stdout).not.toContain("wolfpack/main/install.sh");
  });

  test("reports the exact selected release reinstall command when activation fails", () => {
    const fixture = prepareFixture();
    prepareInstalledServices(fixture);

    const result = runInstaller(fixture, {
      WOLFPACK_INSTALL_ALLOW_SESSION_LOSS: "1",
      WOLFPACK_RELEASE_TAG: "v1.6.20-rc.1",
      INSTALL_TEST_FAIL_ACTIVATION: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("WOLFPACK_RELEASE_TAG=\"v1.6.20-rc.1\"");
    expect(result.stdout).toContain("raw.githubusercontent.com/almogdepaz/wolfpack/v1.6.20-rc.1/install.sh");
    expect(installerStagingDirectories(fixture.installDir)).toEqual([]);
  });
});
