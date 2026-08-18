import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fixtureRoot = "";

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function prepareFixture(): { readonly root: string; readonly bin: string; readonly log: string } {
  fixtureRoot = mkdtempSync(join(tmpdir(), "wolfpack-build-script-"));
  const bin = join(fixtureRoot, "test-bin");
  const log = join(fixtureRoot, "commands.log");
  mkdirSync(join(fixtureRoot, "scripts"), { recursive: true });
  mkdirSync(join(fixtureRoot, "src", "cli"), { recursive: true });
  mkdirSync(join(fixtureRoot, "bin"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  cpSync(join(process.cwd(), "scripts", "build.ts"), join(fixtureRoot, "scripts", "build.ts"));
  writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({ version: "1.0.0" }));
  writeFileSync(join(fixtureRoot, "THIRD_PARTY_NOTICES"), "notices\n");
  writeFileSync(join(fixtureRoot, "src", "cli", "index.ts"), "console.log('fixture');\n");
  writeFileSync(log, "");

  writeExecutable(join(bin, "bun"), `#!/bin/sh
printf 'bun %s\\n' "$*" >> "$BUILD_TEST_LOG"
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
printf 'broker\\n' > "$PWD/broker/target/release/wolfpack-broker"
chmod +x "$PWD/broker/target/release/wolfpack-broker"
`);
  return { root: fixtureRoot, bin, log };
}

function runBuild(fixture: { readonly root: string; readonly bin: string; readonly log: string }, serverOnly: boolean): string {
  execFileSync(process.execPath, [join(fixture.root, "scripts", "build.ts")], {
    cwd: fixture.root,
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      BUILD_TEST_LOG: fixture.log,
      WOLFPACK_BUILD_SERVER_ONLY: serverOnly ? "1" : "0",
    },
    stdio: "pipe",
  });
  return readFileSync(fixture.log, "utf-8");
}

describe("scripts/build.ts modes", () => {
  test("server-only mode compiles the cli without broker staging or platform packages", () => {
    const fixture = prepareFixture();

    const commands = runBuild(fixture, true);

    expect(commands).not.toContain("cargo ");
    expect(existsSync(join(fixture.root, "dist", "broker"))).toBe(false);
    expect(existsSync(join(fixture.root, "dist", "npm"))).toBe(false);
    expect(existsSync(join(fixture.root, "bin", "wolfpack"))).toBe(true);
  });

  test("normal mode stages the broker and generates platform packages", () => {
    const fixture = prepareFixture();

    const commands = runBuild(fixture, false);

    expect(commands).toContain("cargo build --release --manifest-path broker/Cargo.toml --bin wolfpack-broker");
    expect(existsSync(join(fixture.root, "dist", "wolfpack-broker"))).toBe(true);
    expect(existsSync(join(fixture.root, "dist", "npm", "wolfpack-bridge-darwin-arm64", "wolfpack-broker"))).toBe(true);
  });
});
