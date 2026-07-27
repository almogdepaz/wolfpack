import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ZIG_VERSION = "0.16.0";
const ZIG_SLUG = "x86_64-linux";
const PINNED_LINUX_X64_SHA256 = "70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00";

function makeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function createFakeZigArchive(workDir: string): string {
  const sourceDir = join(workDir, `zig-${ZIG_SLUG}-${ZIG_VERSION}`);
  mkdirSync(sourceDir, { recursive: true });
  makeExecutable(join(sourceDir, "zig"), "#!/usr/bin/env bash\necho 0.16.0\n");
  const archive = join(workDir, `zig-${ZIG_SLUG}-${ZIG_VERSION}.tar.xz`);
  execFileSync("tar", ["-cJf", archive, `zig-${ZIG_SLUG}-${ZIG_VERSION}`], { cwd: workDir });
  return archive;
}

function writeMockCommand(path: string, body: string): void {
  makeExecutable(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
}

type SetupZigPaths = {
  readonly tempDir: string;
  readonly cacheDir: string;
  readonly logDir: string;
};

function runSetupZig(setup: (paths: SetupZigPaths) => void, verify: (paths: SetupZigPaths) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), "setup-zig-cache-test-"));
  try {
    const cacheDir = join(tempDir, `zig-${ZIG_VERSION}`);
    const binDir = join(tempDir, "bin");
    const logDir = join(tempDir, "logs");
    const paths = { tempDir, cacheDir, logDir };
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    writeMockCommand(join(binDir, "uname"), `
if [[ "$1" == "-s" ]]; then
  echo Linux
elif [[ "$1" == "-m" ]]; then
  echo x86_64
else
  exit 64
fi
`);
    writeMockCommand(join(binDir, "shasum"), `
echo "$@" >> "${logDir}/shasum.log"
printf '${PINNED_LINUX_X64_SHA256}  %s\n' "${cacheDir}/zig-${ZIG_SLUG}-${ZIG_VERSION}.tar.xz"
`);
    writeMockCommand(join(binDir, "curl"), `
output=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
[[ -n "$output" ]]
cp "${logDir}/authenticated-zig.tar.xz" "$output"
echo "$output" >> "${logDir}/curl.log"
`);
    setup(paths);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: tempDir,
      GITHUB_PATH: join(tempDir, "github-path"),
    };

    execFileSync("bash", ["scripts/setup-zig-0.16.0.sh"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      stdio: "pipe",
    });
    verify(paths);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("pinned Zig setup cache provenance", () => {
  test("ignores a poisoned shared cache and installs only from a private authenticated archive", () => {
    runSetupZig(
      ({ cacheDir, logDir }) => {
        const archive = createFakeZigArchive(cacheDir);
        copyFileSync(archive, join(logDir, "authenticated-zig.tar.xz"));
        copyFileSync(archive, join(cacheDir, `zig-${ZIG_SLUG}-${ZIG_VERSION}.tar.xz`));
        const poisonedInstall = join(cacheDir, `zig-${ZIG_SLUG}-${ZIG_VERSION}`);
        rmSync(poisonedInstall, { recursive: true, force: true });
        mkdirSync(poisonedInstall, { recursive: true });
        makeExecutable(join(poisonedInstall, "zig"), "#!/usr/bin/env bash\necho poisoned-zig\n");
        makeExecutable(join(poisonedInstall, "cc"), "#!/usr/bin/env bash\necho poisoned-cc\n");
      },
      ({ cacheDir, logDir, tempDir }) => {
        const installDir = readFileSync(join(tempDir, "github-path"), "utf8").trim();
        expect(installDir.startsWith(`${cacheDir}/`)).toBe(false);
        expect(statSync(join(installDir, "..")).mode & 0o777).toBe(0o700);
        expect(readFileSync(join(installDir, "zig"), "utf8")).toContain("echo 0.16.0");
        expect(readFileSync(join(cacheDir, `zig-${ZIG_SLUG}-${ZIG_VERSION}`, "zig"), "utf8")).toContain(
          "poisoned-zig",
        );
        expect(readFileSync(join(logDir, "curl.log"), "utf8")).toContain("wolfpack-zig-");
        expect(readFileSync(join(logDir, "shasum.log"), "utf8")).toContain("wolfpack-zig-");
      },
    );
  });

  test("setup script keeps download, verification, extraction, and execution in a private directory", () => {
    const source = readFileSync(join(process.cwd(), "scripts", "setup-zig-0.16.0.sh"), "utf8");
    expect(source).toContain("mktemp -d");
    expect(source).toContain("chmod 700");
    expect(source).toContain("verify_archive");
    expect(source).toContain('curl -fL --retry 3 -o "${archive}"');
    expect(source).toContain('tar -xJf "${archive}" -C "${private_dir}"');
    expect(source).not.toContain('cache_dir="${RUNNER_TEMP:-/tmp}/zig-${version}"');
    expect(source).not.toContain(".stamp");
  });
});
