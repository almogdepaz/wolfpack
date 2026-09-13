import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type InstalledMutation = "none" | "broker-bytes" | "broker-mode" | "manifest-version";

interface SmokeFixture {
  readonly root: string;
  readonly target: string;
  readonly codesignLog: string;
  readonly npmLog: string;
  readonly payloadLog: string;
  readonly mutation: InstalledMutation;
  readonly packOutput: "json" | "invalid";
}

let fixtureRoot = "";

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function prepareFixture(
  mutation: InstalledMutation = "none",
  packOutput: SmokeFixture["packOutput"] = "json",
): SmokeFixture {
  fixtureRoot = mkdtempSync(join(tmpdir(), "wolfpack-smoke-release-"));
  const root = fixtureRoot;
  const target = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  const platformPackage = `wolfpack-bridge-${target}`;
  const scripts = join(root, "scripts");
  const dist = join(root, "dist");
  const platform = join(dist, "npm", platformPackage);
  const tools = join(root, "tools");
  const home = join(root, "home");
  const npmCache = join(root, "npm-cache");
  const npmrc = join(root, "npmrc");
  const npmGlobalrc = join(root, "npm-globalrc");
  const codesignLog = join(root, "codesign.log");
  const npmLog = join(root, "npm.log");
  const payloadLog = join(root, "payload.log");
  mkdirSync(join(dist, "broker", `bun-${target}`), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(platform, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  mkdirSync(tools, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(npmCache, { recursive: true });
  writeFileSync(codesignLog, "");
  writeFileSync(npmLog, "");
  writeFileSync(payloadLog, "");
  writeFileSync(npmGlobalrc, "");
  writeFileSync(npmrc, [
    "offline=true",
    "audit=false",
    "fund=false",
    "ignore-scripts=true",
    `cache=${npmCache}`,
    `globalconfig=${npmGlobalrc}`,
    "",
  ].join("\n"));
  copyFileSync(join(process.cwd(), "scripts", "smoke-release-artifacts.ts"), join(scripts, "smoke-release-artifacts.ts"));
  copyFileSync(join(process.cwd(), "scripts", "release-version-policy.ts"), join(scripts, "release-version-policy.ts"));
  copyFileSync(join(process.cwd(), "scripts", "broker-artifacts.ts"), join(scripts, "broker-artifacts.ts"));
  // Publication provenance is a precondition of this focused smoke boundary.
  // Its own production contract is covered by publish-policy tests.
  writeFileSync(join(scripts, "publish-policy.ts"), 'export function validatePublicationArtifacts() { return { productVersion: "1.2.3", brokerVersion: "4.5.6" }; }\n');
  copyFileSync(join(process.cwd(), "bin", "run.cjs"), join(root, "bin", "run.cjs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "wolfpack-bridge",
    version: "1.2.3",
    bin: { wolfpack: "./bin/run.cjs" },
    files: ["bin/run.cjs"],
    optionalDependencies: { [platformPackage]: "1.2.3" },
  }));
  writeExecutable(join(dist, `wolfpack-${target}`), "#!/bin/sh\ncase \"$1\" in --version) printf '1.2.3\\n' ;; --help) printf 'Usage: fixture\\n' ;; esac\n");
  writeExecutable(join(dist, "broker", `bun-${target}`, "wolfpack-broker"), "#!/bin/sh\nprintf 'wolfpack-broker 4.5.6\\n'\n");
  writeExecutable(join(platform, "wolfpack"), "#!/bin/sh\nprintf 'server %s\\n' \"$*\" >> \"$SMOKE_PAYLOAD_LOG\"\ncase \"$1\" in --version) printf '1.2.3\\n' ;; --help) printf 'Usage: fixture\\n' ;; esac\n");
  writeExecutable(join(platform, "wolfpack-broker"), "#!/bin/sh\nprintf 'broker %s\\n' \"$*\" >> \"$SMOKE_PAYLOAD_LOG\"\nprintf 'wolfpack-broker 4.5.6\\n'\n");
  writeFileSync(join(platform, "package.json"), JSON.stringify({
    name: platformPackage,
    version: "1.2.3",
    os: [process.platform === "darwin" ? "darwin" : "linux"],
    cpu: [process.arch === "arm64" ? "arm64" : "x64"],
  }));
  writeExecutable(join(tools, "codesign"), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$SMOKE_CODESIGN_LOG"
if [ "\${SMOKE_CODESIGN_FAIL:-}" = "1" ]; then exit 19; fi
`);
  const npm = Bun.which("npm");
  if (!npm) throw new Error("npm is required for the owned smoke fixture");
  writeExecutable(join(tools, "npm"), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$SMOKE_NPM_LOG"
if [ "\${SMOKE_PACK_OUTPUT:-json}" = invalid ] && [ "$1" = pack ]; then printf '{\\n'; exit 0; fi
"$SMOKE_REAL_NPM" "$@"
if [ "$1" = install ]; then
  package="$PWD/node_modules/${platformPackage}"
  case "$SMOKE_INSTALLED_MUTATION" in
    broker-bytes) printf 'corrupt\\n' >> "$package/wolfpack-broker" ;;
    broker-mode) chmod 644 "$package/wolfpack-broker" ;;
    manifest-version) node -e 'const fs=require("node:fs"); const p=process.argv[1]; const m=JSON.parse(fs.readFileSync(p,"utf8")); m.version="9.9.9"; fs.writeFileSync(p, JSON.stringify(m));' "$package/package.json" ;;
    none) ;;
    *) exit 64 ;;
  esac
fi
`);
  return { root, target, codesignLog, npmLog, payloadLog, mutation, packOutput };
}

function runSmoke(fixture: SmokeFixture, codesignFails = false): Bun.ReadableSyncSubprocess {
  const npmrc = join(fixture.root, "npmrc");
  const npmGlobalrc = join(fixture.root, "npm-globalrc");
  const npmCache = join(fixture.root, "npm-cache");
  const home = join(fixture.root, "home");
  return Bun.spawnSync([process.execPath, join(fixture.root, "scripts", "smoke-release-artifacts.ts"), fixture.target], {
    cwd: fixture.root,
    env: {
      HOME: home,
      PATH: `${join(fixture.root, "tools")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      TMPDIR: join(fixture.root, "tmp"),
      npm_config_cache: npmCache,
      npm_config_userconfig: npmrc,
      npm_config_globalconfig: npmGlobalrc,
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: "true",
      SMOKE_CODESIGN_FAIL: codesignFails ? "1" : "0",
      SMOKE_CODESIGN_LOG: fixture.codesignLog,
      SMOKE_INSTALLED_MUTATION: fixture.mutation,
      SMOKE_NPM_LOG: fixture.npmLog,
      SMOKE_PACK_OUTPUT: fixture.packOutput,
      SMOKE_PAYLOAD_LOG: fixture.payloadLog,
      SMOKE_REAL_NPM: Bun.which("npm") ?? "npm",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
});

describe("release artifact smoke", () => {
  test("packs and installs owned archives offline, then verifies the installed platform pair and public alias", () => {
    const fixture = prepareFixture();
    const result = runSmoke(fixture);

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const npmCalls = readFileSync(fixture.npmLog, "utf8");
    expect(npmCalls).toContain("pack");
    expect(npmCalls).toContain("--json");
    expect(npmCalls).toContain("install --ignore-scripts");
    expect(readFileSync(fixture.payloadLog, "utf8")).toEqual("server --version\nbroker --version\nserver --version\nserver --help\n");
    if (fixture.target.startsWith("darwin-")) {
      expect(readFileSync(fixture.codesignLog, "utf8").trim().split("\n")).toEqual([
        expect.stringMatching(new RegExp(`^--verify --strict .*/node_modules/wolfpack-bridge-${fixture.target}/wolfpack$`)),
        expect.stringMatching(new RegExp(`^--verify --strict .*/node_modules/wolfpack-bridge-${fixture.target}/wolfpack-broker$`)),
      ]);
    } else {
      expect(readFileSync(fixture.codesignLog, "utf8")).toBe("");
    }
  });

  test.each([
    ["broker byte divergence", "broker-bytes", "installed broker bytes differ after installation"],
    ["broker mode divergence", "broker-mode", "installed broker owner-executable mode differs after installation"],
    ["platform manifest mismatch", "manifest-version", "installed platform package"],
  ] as const)("fails before payload or alias execution on %s", (_name, mutation, diagnostic) => {
    const fixture = prepareFixture(mutation);
    const result = runSmoke(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(diagnostic);
    expect(readFileSync(fixture.payloadLog, "utf8")).toBe("");
  });

  test("rejects invalid structured npm pack output before installation", () => {
    const fixture = prepareFixture("none", "invalid");
    const result = runSmoke(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("platform package npm pack did not return JSON");
    expect(readFileSync(fixture.payloadLog, "utf8")).toBe("");
  });

  test.skipIf(process.platform !== "darwin")("stops before the public alias when installed signature verification rejects", () => {
    const fixture = prepareFixture();
    const result = runSmoke(fixture, true);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("codesign --verify --strict");
    expect(readFileSync(fixture.payloadLog, "utf8")).toEqual("server --version\nbroker --version\n");
  });
});
