import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arch, platform, tmpdir } from "node:os";
import {
  BROKER_TARGETS,
  createBrokerArtifactMetadata,
  readSourceRevision,
  writeBrokerArtifactMetadata,
  type BrokerTarget,
} from "../../scripts/broker-artifacts";

let fixtureRoot = "";

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function brokerBinary(target: BrokerTarget): Buffer {
  const binary = Buffer.alloc(64);
  if (BROKER_TARGETS[target].binaryFormat === "elf") {
    binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    binary.writeUInt16LE(BROKER_TARGETS[target].architecture === "x64" ? 62 : 183, 18);
  } else {
    binary.set([0xcf, 0xfa, 0xed, 0xfe]);
    binary.writeUInt32LE(BROKER_TARGETS[target].architecture === "x64" ? 0x01000007 : 0x0100000c, 4);
  }
  return binary;
}

function hostTarget(): BrokerTarget {
  const target = `bun-${platform()}-${arch()}`;
  if (!Object.hasOwn(BROKER_TARGETS, target)) throw new Error(`unsupported test host: ${target}`);
  return target as BrokerTarget;
}

function prepareFixture(): { readonly root: string; readonly bin: string; readonly log: string; readonly hostBroker: string } {
  fixtureRoot = mkdtempSync(join(tmpdir(), "wolfpack-build-script-"));
  const bin = join(fixtureRoot, "test-bin");
  const log = join(fixtureRoot, "commands.log");
  const hostBroker = join(fixtureRoot, "host-broker");
  mkdirSync(join(fixtureRoot, "scripts"), { recursive: true });
  mkdirSync(join(fixtureRoot, "src", "cli"), { recursive: true });
  mkdirSync(join(fixtureRoot, "broker"), { recursive: true });
  mkdirSync(join(fixtureRoot, "bin"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  cpSync(join(process.cwd(), "scripts", "build.ts"), join(fixtureRoot, "scripts", "build.ts"));
  cpSync(join(process.cwd(), "scripts", "broker-artifacts.ts"), join(fixtureRoot, "scripts", "broker-artifacts.ts"));
  cpSync(join(process.cwd(), "scripts", "release-version-policy.ts"), join(fixtureRoot, "scripts", "release-version-policy.ts"));
  writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({
    version: "1.0.0",
    optionalDependencies: Object.fromEntries(
      Object.values(BROKER_TARGETS).map(target => [target.packageName, "1.0.0"]),
    ),
  }));
  writeFileSync(join(fixtureRoot, "broker", "Cargo.toml"), "[package]\nname = \"wolfpack-broker\"\nversion = \"1.0.0\"\n");
  writeFileSync(join(fixtureRoot, "THIRD_PARTY_NOTICES"), "notices\n");
  writeFileSync(join(fixtureRoot, "src", "cli", "index.ts"), "console.log('fixture');\n");
  writeFileSync(hostBroker, brokerBinary(hostTarget()));
  execFileSync("git", ["init", "-q"], { cwd: fixtureRoot });
  execFileSync("git", ["add", "."], { cwd: fixtureRoot });
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: fixtureRoot });
  writeFileSync(log, "");

  writeExecutable(join(bin, "bun"), `#!/bin/sh
printf 'bun %s\\n' "$*" >> "$BUILD_TEST_LOG"
if [ "\${BUILD_TEST_DIRTY_ASSETS:-}" = '1' ] && [ "$1" = 'run' ] && [ "$2" = 'scripts/gen-assets.ts' ]; then
  printf '// generated drift\\n' >> "$PWD/src/cli/index.ts"
fi
outfile=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--outfile' ]; then
    shift
    outfile="$1"
    break
  fi
  shift
done
if [ -n "$outfile" ]; then
  mkdir -p "$(dirname "$outfile")"
  printf 'binary\\n' > "$outfile"
  chmod +x "$outfile"
fi
`);
  writeExecutable(join(bin, "cargo"), `#!/bin/sh
printf 'cargo %s\\n' "$*" >> "$BUILD_TEST_LOG"
mkdir -p "$PWD/broker/target/release"
cp "$BUILD_TEST_HOST_BROKER" "$PWD/broker/target/release/wolfpack-broker"
chmod +x "$PWD/broker/target/release/wolfpack-broker"
`);
  return { root: fixtureRoot, bin, log, hostBroker };
}

function runBuild(
  fixture: { readonly root: string; readonly bin: string; readonly log: string; readonly hostBroker: string },
  mode: "server-only" | "local" | "package-all" | "unspecified",
  extraEnvironment: Readonly<Record<string, string>> = {},
): string {
  execFileSync(process.execPath, [join(fixture.root, "scripts", "build.ts")], {
    cwd: fixture.root,
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      BUILD_TEST_LOG: fixture.log,
      BUILD_TEST_HOST_BROKER: fixture.hostBroker,
      WOLFPACK_BUILD_MODE: mode === "server-only" || mode === "unspecified" ? "" : mode,
      WOLFPACK_BUILD_SERVER_ONLY: mode === "server-only" ? "1" : "0",
      ...extraEnvironment,
    },
    stdio: "pipe",
  });
  return readFileSync(fixture.log, "utf-8");
}

describe("scripts/build.ts modes", () => {
  test("requires an explicit broker build mode", () => {
    const fixture = prepareFixture();

    expect(() => runBuild(fixture, "unspecified")).toThrow("WOLFPACK_BUILD_MODE");
  });

  test("rejects missing or mismatched platform dependencies without mutating package.json", () => {
    const fixture = prepareFixture();
    const packagePath = join(fixture.root, "package.json");

    const missing = JSON.stringify({ version: "1.0.0" });
    writeFileSync(packagePath, missing);
    expect(() => runBuild(fixture, "server-only")).toThrow("optionalDependencies");
    expect(readFileSync(packagePath, "utf8")).toBe(missing);

    const mismatched = JSON.stringify({
      version: "1.0.0",
      optionalDependencies: Object.fromEntries(
        Object.values(BROKER_TARGETS).map(target => [target.packageName, target.cpu === "x64" ? "0.9.0" : "1.0.0"]),
      ),
    });
    writeFileSync(packagePath, mismatched);
    expect(() => runBuild(fixture, "server-only")).toThrow("0.9.0");
    expect(readFileSync(packagePath, "utf8")).toBe(mismatched);
  });

  test("server-only mode compiles the cli without broker staging or platform packages", () => {
    const fixture = prepareFixture();

    const commands = runBuild(fixture, "server-only");

    expect(commands).not.toContain("cargo ");
    expect(existsSync(join(fixture.root, "dist", "broker"))).toBe(false);
    expect(existsSync(join(fixture.root, "dist", "npm"))).toBe(false);
    expect(existsSync(join(fixture.root, "bin", "wolfpack"))).toBe(true);
  });

  test("local mode ignores stale release staging and emits only the fresh host broker", () => {
    const fixture = prepareFixture();
    mkdirSync(join(fixture.root, "dist", "broker", "bun-darwin-x64"), { recursive: true });
    mkdirSync(join(fixture.root, "dist", "npm", "wolfpack-bridge-darwin-x64"), { recursive: true });
    writeFileSync(join(fixture.root, "dist", "broker", "bun-darwin-x64", "wolfpack-broker"), "stale\n");
    writeFileSync(join(fixture.root, "dist", "npm", "wolfpack-bridge-darwin-x64", "wolfpack-broker"), "stale\n");
    appendFileSync(join(fixture.root, "broker", "Cargo.toml"), "# local tracked change\n");

    const commands = runBuild(fixture, "local");
    const localBroker = join(fixture.root, "dist", "local", hostTarget(), "wolfpack-broker");

    expect(commands).toContain("cargo build --release --manifest-path broker/Cargo.toml --bin wolfpack-broker");
    expect(existsSync(join(fixture.root, "dist", "broker"))).toBe(false);
    expect(existsSync(join(fixture.root, "dist", "npm"))).toBe(false);
    expect(readFileSync(localBroker).equals(brokerBinary(hostTarget()))).toBe(true);
    expect(existsSync(join(fixture.root, "dist", "local", hostTarget(), "broker-artifact.json"))).toBe(true);
  });

  test("package-all mode rejects tracked source changes before packaging", () => {
    const fixture = prepareFixture();
    appendFileSync(join(fixture.root, "broker", "Cargo.toml"), "# dirty broker source\n");

    expect(() => runBuild(fixture, "package-all")).toThrow("tracked source");
    expect(existsSync(join(fixture.root, "dist", "npm"))).toBe(false);
  });

  test("package-all mode rejects tracked drift produced during asset generation", () => {
    const fixture = prepareFixture();

    expect(() => runBuild(fixture, "package-all", { BUILD_TEST_DIRTY_ASSETS: "1" })).toThrow("tracked source");
    expect(existsSync(join(fixture.root, "dist", "npm"))).toBe(false);
  });

  test("package-all mode fails closed when staged provenance is incomplete", () => {
    const fixture = prepareFixture();
    const targetDir = join(fixture.root, "dist", "broker", "bun-darwin-arm64");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "wolfpack-broker"), brokerBinary("bun-darwin-arm64"));

    expect(() => runBuild(fixture, "package-all")).toThrow();
    expect(existsSync(join(fixture.root, "dist", "npm"))).toBe(false);
  });

  test("package-all mode requires proven target artifacts and skips the host cargo build", () => {
    const fixture = prepareFixture();
    const revision = readSourceRevision(fixture.root);
    for (const target of Object.keys(BROKER_TARGETS) as BrokerTarget[]) {
      const targetDir = join(fixture.root, "dist", "broker", target);
      const binary = join(targetDir, "wolfpack-broker");
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(binary, brokerBinary(target));
      writeBrokerArtifactMetadata(
        join(targetDir, "broker-artifact.json"),
        createBrokerArtifactMetadata({
          binaryPath: binary,
          mode: "release",
          target,
          brokerVersion: "1.0.0",
          sourceRevision: revision,
        }),
      );
    }

    const commands = runBuild(fixture, "package-all");

    expect(commands).not.toContain("cargo ");
    expect(existsSync(join(fixture.root, "dist", "npm", "wolfpack-bridge-darwin-arm64", "wolfpack-broker"))).toBe(true);
    expect(existsSync(join(fixture.root, "dist", "npm", "wolfpack-bridge-darwin-arm64", "broker-artifact.json"))).toBe(true);
    expect(existsSync(join(fixture.root, "dist", "local"))).toBe(false);
  });
});
