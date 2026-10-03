import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type InstalledMutation = "none" | "broker-bytes" | "broker-mode" | "manifest-version" | "main-shebang" | "alias-mode";

interface SmokeFixture {
  readonly root: string;
  readonly target: string;
  readonly codesignLog: string;
  readonly npmLog: string;
  readonly payloadLog: string;
  readonly mutation: InstalledMutation;
  readonly packOutput: "json" | "reverse" | "invalid" | "missing" | "duplicate" | "wrong-version" | "unsafe-path" | "same-file";
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
  const mainBin = join(root, "bin", "run.cjs");
  copyFileSync(join(process.cwd(), "bin", "run.cjs"), mainBin);
  if (mutation === "main-shebang") {
    writeFileSync(mainBin, readFileSync(mainBin, "utf8").replace(/^#![^\n]*/, "#!/definitely-missing-wolfpack-node"));
  }
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
if [ "$1" = pack ]; then
  case "\${SMOKE_PACK_OUTPUT:-json}" in
    invalid) printf '{\\n'; exit 0 ;;
    missing) printf '[]\\n'; exit 0 ;;
    duplicate) printf '%s\\n' '[{"name":"${platformPackage}","version":"1.2.3","filename":"platform.tgz"},{"name":"${platformPackage}","version":"1.2.3","filename":"other.tgz"}]'; exit 0 ;;
    wrong-version) printf '%s\\n' '[{"name":"${platformPackage}","version":"1.2.3","filename":"platform.tgz"},{"name":"wolfpack-bridge","version":"9.9.9","filename":"main.tgz"}]'; exit 0 ;;
    unsafe-path) printf '%s\\n' '[{"name":"${platformPackage}","version":"1.2.3","filename":"../platform.tgz"},{"name":"wolfpack-bridge","version":"1.2.3","filename":"main.tgz"}]'; exit 0 ;;
    same-file) printf '%s\\n' '[{"name":"${platformPackage}","version":"1.2.3","filename":"same.tgz"},{"name":"wolfpack-bridge","version":"1.2.3","filename":"same.tgz"}]'; exit 0 ;;
    reverse)
      output=$("$SMOKE_REAL_NPM" "$@")
      printf '%s\\n' "$output" | node -e 'const fs=require("node:fs"); console.log(JSON.stringify(JSON.parse(fs.readFileSync(0,"utf8")).reverse()));'
      exit 0 ;;
  esac
fi
"$SMOKE_REAL_NPM" "$@"
if [ "$1" = install ]; then
  package="$PWD/node_modules/${platformPackage}"
  case "$SMOKE_INSTALLED_MUTATION" in
    broker-bytes) printf 'corrupt\\n' >> "$package/wolfpack-broker" ;;
    broker-mode) chmod 644 "$package/wolfpack-broker" ;;
    manifest-version) node -e 'const fs=require("node:fs"); const p=process.argv[1]; const m=JSON.parse(fs.readFileSync(p,"utf8")); m.version="9.9.9"; fs.writeFileSync(p, JSON.stringify(m));' "$package/package.json" ;;
    alias-mode) chmod 644 "$PWD/node_modules/wolfpack-bridge/bin/run.cjs" ;;
    main-shebang|none) ;;
    *) exit 64 ;;
  esac
fi
`);
  return { root, target, codesignLog, npmLog, payloadLog, mutation, packOutput };
}

function runSmoke(fixture: SmokeFixture, codesignFails = false, node = Bun.which("node")): Bun.ReadableSyncSubprocess {
  if (!node) throw new Error("release smoke fixture requires an existing Node.js executable");
  const npmrc = join(fixture.root, "npmrc");
  const npmGlobalrc = join(fixture.root, "npm-globalrc");
  const npmCache = join(fixture.root, "npm-cache");
  const home = join(fixture.root, "home");
  return Bun.spawnSync([process.execPath, join(fixture.root, "scripts", "smoke-release-artifacts.ts"), fixture.target], {
    cwd: fixture.root,
    env: {
      HOME: home,
      // The unit process can import src/server/index.ts, which replaces its
      // mutable PATH from the login shell. Bind the startup-resolved Node
      // directory for this owned fixture so the public alias's shebang sees
      // the intended real Node executable.
      PATH: `${join(fixture.root, "tools")}:${dirname(node)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
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
  test.each(["json", "reverse"] as const)("packs and installs owned archives offline, then verifies the installed platform pair and public alias (%s pack order)", (packOutput) => {
    const fixture = prepareFixture("none", packOutput);
    const result = runSmoke(fixture);

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const npmCalls = readFileSync(fixture.npmLog, "utf8");
    expect(npmCalls).toContain("pack");
    expect(npmCalls).toContain("--json");
    // Preserve two real archives but pay for only one npm pack process.
    expect(npmCalls.trim().split("\n").filter(line => line.startsWith("pack "))).toHaveLength(1);
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

  test.each(["cli-version", "broker-version", "cli-help"] as const)("rejects a failed initial %s probe before packing", (failure) => {
    const fixture = prepareFixture();
    if (failure === "broker-version") {
      writeExecutable(join(fixture.root, "dist", "broker", `bun-${fixture.target}`, "wolfpack-broker"), "#!/bin/sh\nexit 23\n");
    } else {
      const flag = failure === "cli-version" ? "--version" : "--help";
      writeExecutable(join(fixture.root, "dist", `wolfpack-${fixture.target}`), `#!/bin/sh
case "$1" in
  ${flag}) exit 23 ;;
  --version) printf '1.2.3\\n' ;;
  --help) printf 'Usage: fixture\\n' ;;
esac
`);
    }
    const result = runSmoke(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("failed:");
    expect(readFileSync(fixture.npmLog, "utf8")).toBe("");
    expect(readFileSync(fixture.payloadLog, "utf8")).toBe("");
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

  test.each([
    ["main package shebang", "main-shebang", "ENOENT"],
    ["installed alias target mode", "alias-mode", "EACCES"],
  ] as const)("rejects %s during direct public alias execution", (_name, mutation, diagnostic) => {
    const fixture = prepareFixture(mutation);
    const result = runSmoke(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(diagnostic);
    expect(readFileSync(fixture.payloadLog, "utf8")).toEqual("server --version\nbroker --version\n");
  });

  // An actual legacy Node is an optional local prerequisite, not a required
  // /usr/local installation on every supported host. Discover before spawning.
  const unsupportedNode = Bun.which("node", { PATH: "/usr/local/bin" });
  const unsupportedVersion = unsupportedNode
    ? Bun.spawnSync([unsupportedNode, "--version"], { stdout: "pipe", stderr: "pipe" })
    : undefined;
  test.if(unsupportedVersion?.exitCode === 0 && /^v(?:0|1?\d|2[01])\./.test(unsupportedVersion.stdout.toString()))("rejects an actual unsupported Node selected by the public shebang", () => {
    const fixture = prepareFixture();
    // This owned copy is the exact package bin source. Execute it through a
    // shell so PATH selection follows its env shebang rather than Bun's
    // startup-runtime command resolution; the Node floor runs before package
    // lookup, while the happy path above retains the full pack/install proof.
    const result = Bun.spawnSync(["/bin/sh", "-c", "exec \"$1\" --version", "sh", join(fixture.root, "bin", "run.cjs")], {
      env: { ...process.env, PATH: `${dirname(unsupportedNode!)}:${process.env.PATH ?? "/usr/bin:/bin"}` },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("npm/npx requires Node.js 22 or later");
  });

  test("rejects invalid structured npm pack output before installation", () => {
    const fixture = prepareFixture("none", "invalid");
    const result = runSmoke(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("release packages npm pack did not return JSON");
    expect(readFileSync(fixture.payloadLog, "utf8")).toBe("");
  });

  test.each([
    ["missing", "invalid result"],
    ["duplicate", "exactly one"],
    ["wrong-version", "exactly one"],
    ["unsafe-path", "invalid archive filename"],
    ["same-file", "duplicate archive filenames"],
  ] as const)("rejects %s multi-package pack metadata before installation", (packOutput, diagnostic) => {
    const fixture = prepareFixture("none", packOutput);
    const result = runSmoke(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(diagnostic);
    expect(readFileSync(fixture.npmLog, "utf8")).not.toContain("install ");
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
