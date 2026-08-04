import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fixtureRoot = "";

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
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
  const serverAsset = "#!/bin/sh\n[ -z \"$INSTALL_TEST_COMMAND_LOG\" ] || printf \"%s\\n\" \"$*\" >> \"$INSTALL_TEST_COMMAND_LOG\"\nprintf \"new server\\n\"\n";
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
    printf '#!/bin/sh\\n[ -z "$INSTALL_TEST_COMMAND_LOG" ] || printf "%%s\\\\n" "$*" >> "$INSTALL_TEST_COMMAND_LOG"\\nprintf "new server\\\\n"\\n' > "$output"
    ;;
  *) exit 22 ;;
esac
`);

  return { home, bin, systemBin, log, commandLog, installDir, checksums };
}

function runInstaller(
  fixture: ReturnType<typeof prepareFixture>,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [join(process.cwd(), "install.sh")], {
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: fixture.home,
      OSTYPE: "linux-gnu",
      PATH: `${fixture.installDir}:${fixture.bin}:/usr/bin:/bin`,
      INSTALL_TEST_LOG: fixture.log,
      INSTALL_TEST_COMMAND_LOG: fixture.commandLog,
      INSTALL_TEST_CHECKSUMS: fixture.checksums,
      INSTALL_TEST_CORRUPT_CHECKSUM: "0",
      WOLFPACK_SYMLINK_DIR: fixture.systemBin,
      WOLFPACK_INSTALL_SKIP_SETUP: "1",
      ...extraEnv,
    },
  });
}

function installedOutput(path: string): string {
  return spawnSync(path, [], { encoding: "utf-8" }).stdout;
}

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

  test("package runner prepares both binaries when Bun blocks postinstall", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-package-runner-")));
    const packageRoot = join(fixtureRoot, "node_modules", "wolfpack-bridge");
    const packageBin = join(packageRoot, "bin");
    const platformPackage = `wolfpack-bridge-${process.platform}-${process.arch}`;
    const platformRoot = join(fixtureRoot, "node_modules", platformPackage);
    mkdirSync(packageBin, { recursive: true });
    mkdirSync(platformRoot, { recursive: true });
    writeFileSync(join(packageBin, "run.cjs"), readFileSync(join(process.cwd(), "bin", "run.cjs")));
    writeFileSync(join(platformRoot, "package.json"), JSON.stringify({ name: platformPackage, version: "test" }));
    writeFileSync(join(platformRoot, "wolfpack"), "#!/bin/sh\nprintf 'wolfpack %s\\n' \"$*\"\n");
    writeFileSync(join(platformRoot, "wolfpack-broker"), "#!/bin/sh\nprintf 'broker\\n'\n");

    const result = spawnSync(process.execPath, [join(packageBin, "run.cjs"), "--version"], { encoding: "utf-8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("wolfpack --version\n");
    expect(statSync(join(platformRoot, "wolfpack")).mode & 0o111).not.toBe(0);
    expect(statSync(join(platformRoot, "wolfpack-broker")).mode & 0o111).not.toBe(0);
  });

  test("package runner clears macOS provenance and signs binaries when Bun blocks postinstall", () => {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-package-runner-macos-")));
    const packageRoot = join(fixtureRoot, "node_modules", "wolfpack-bridge");
    const packageBin = join(packageRoot, "bin");
    const platformRoot = join(fixtureRoot, "node_modules", "wolfpack-bridge-darwin-arm64");
    const commandBin = join(fixtureRoot, "command-bin");
    const commandLog = join(fixtureRoot, "commands.log");
    mkdirSync(packageBin, { recursive: true });
    mkdirSync(platformRoot, { recursive: true });
    mkdirSync(commandBin, { recursive: true });
    writeFileSync(join(packageBin, "run.cjs"), readFileSync(join(process.cwd(), "bin", "run.cjs")));
    writeFileSync(join(platformRoot, "package.json"), JSON.stringify({ name: "wolfpack-bridge-darwin-arm64", version: "test" }));
    writeExecutable(join(platformRoot, "wolfpack"), "#!/bin/sh\nprintf 'wolfpack %s\\n' \"$*\"\n");
    writeExecutable(join(platformRoot, "wolfpack-broker"), "#!/bin/sh\nprintf 'broker\\n'\n");
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
    `, join(packageBin, "run.cjs"), "--version"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${commandBin}:${process.env.PATH}`,
        POSTINSTALL_TEST_LOG: commandLog,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("wolfpack --version\n");
    expect(readFileSync(commandLog, "utf-8")).toBe([
      `xattr -cr ${join(platformRoot, "wolfpack")}`,
      `codesign --sign - --force ${join(platformRoot, "wolfpack")}`,
      `xattr -cr ${join(platformRoot, "wolfpack-broker")}`,
      `codesign --sign - --force ${join(platformRoot, "wolfpack-broker")}`,
      "",
    ].join("\n"));
  });

  test("package postinstall clears macOS provenance and signs both binaries", () => {
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
  test("an upgrade restarts only the server service", () => {
    const fixture = prepareFixture();
    const serviceDir = join(fixture.home, ".config", "systemd", "user");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "wolfpack.service"), "installed\n");
    writeFileSync(join(fixture.home, ".wolfpack", "config.json"), "{}\n");

    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.commandLog, "utf-8").trim()).toBe("service restart");
  });

  test("downloads and installs the matching wolfpack and broker assets", () => {
    const fixture = prepareFixture();
    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.log, "utf-8")).toContain(
      "/releases/latest/download/wolfpack-linux-x64",
    );
    expect(readFileSync(fixture.log, "utf-8")).toContain(
      "/releases/latest/download/wolfpack-broker-linux-x64",
    );
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("new server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("new broker\n");
    expect(statSync(join(fixture.installDir, "wolfpack")).mode & 0o111).not.toBe(0);
    expect(statSync(join(fixture.installDir, "wolfpack-broker")).mode & 0o111).not.toBe(0);
  });

  test("rejects a checksum mismatch before either binary is replaced", () => {
    const fixture = prepareFixture();
    const result = runInstaller(fixture, { INSTALL_TEST_CORRUPT_CHECKSUM: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Checksum verification failed");
    expect(installedOutput(join(fixture.installDir, "wolfpack"))).toBe("old server\n");
    expect(installedOutput(join(fixture.installDir, "wolfpack-broker"))).toBe("old broker\n");
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
