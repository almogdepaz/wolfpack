import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function prepareFixture(): { readonly repo: string; readonly home: string; readonly log: string; readonly bin: string } {
  tmpDir = mkdtempSync(join(tmpdir(), "wolfpack-deploy-local-"));
  const repo = join(tmpDir, "repo");
  const home = join(tmpDir, "home");
  const bin = join(tmpDir, "bin");
  const log = join(tmpDir, "commands.log");

  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "dist"), { recursive: true });
  mkdirSync(join(home, ".wolfpack", "bin"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  cpSync(join(process.cwd(), "scripts", "deploy-local.sh"), join(repo, "scripts", "deploy-local.sh"));

  writeFileSync(join(repo, "dist", "wolfpack-darwin-arm64"), "server-arm64\n");
  writeFileSync(join(repo, "dist", "wolfpack-darwin-x64"), "server-x64\n");
  writeFileSync(join(repo, "dist", "wolfpack-broker"), "broker\n");
  writeFileSync(log, "");

  writeExecutable(join(bin, "bun"), "#!/bin/sh\necho \"bun $*\" >> \"$DEPLOY_TEST_LOG\"\nexit 0\n");
  writeExecutable(join(bin, "codesign"), "#!/bin/sh\necho \"codesign $*\" >> \"$DEPLOY_TEST_LOG\"\nexit 0\n");
  writeExecutable(join(bin, "launchctl"), `#!/bin/sh
echo "launchctl $*" >> "$DEPLOY_TEST_LOG"
case "$*" in
  *"kickstart -k"*"com.wolfpack.broker"*)
    if [ "$DEPLOY_TEST_BROKER_KICKSTART_FAIL" = "1" ]; then exit 1; fi
    ;;
  *"kickstart -k"*"com.wolfpack.server"*)
    if [ "$DEPLOY_TEST_SERVER_KICKSTART_FAIL" = "1" ]; then exit 1; fi
    ;;
esac
exit 0
`);

  return { repo, home, log, bin };
}

function runDeploy(fixture: { readonly repo: string; readonly home: string; readonly log: string; readonly bin: string }, env: Record<string, string> = {}): string {
  return execFileSync("bash", [join(fixture.repo, "scripts", "deploy-local.sh")], {
    cwd: fixture.repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      DEPLOY_TEST_LOG: fixture.log,
      ...env,
    },
  });
}

beforeEach(() => {
  tmpDir = "";
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("scripts/deploy-local.sh", () => {
  test("restarts broker before restarting server when broker binary is deployed", () => {
    const fixture = prepareFixture();
    const output = runDeploy(fixture);
    const commands = readFileSync(fixture.log, "utf-8");

    expect(readFileSync(join(fixture.home, ".wolfpack", "bin", "wolfpack-broker"), "utf-8")).toBe("broker\n");
    expect(output).toContain("broker restarted");
    expect(output).toContain("deployed and restarted");
    expect(commands.indexOf("com.wolfpack.broker")).toBeGreaterThan(-1);
    expect(commands.indexOf("com.wolfpack.server")).toBeGreaterThan(-1);
    expect(commands.indexOf("com.wolfpack.broker")).toBeLessThan(commands.indexOf("com.wolfpack.server"));
  });

  test("bootstraps broker when kickstart fails and broker plist exists", () => {
    const fixture = prepareFixture();
    const launchAgents = join(fixture.home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(join(launchAgents, "com.wolfpack.broker.plist"), "plist\n");

    const output = runDeploy(fixture, { DEPLOY_TEST_BROKER_KICKSTART_FAIL: "1" });
    const commands = readFileSync(fixture.log, "utf-8");

    expect(output).toContain("broker bootstrapped");
    expect(commands).toContain("launchctl kickstart -k");
    expect(commands).toContain("launchctl bootstrap");
    expect(commands).toContain("com.wolfpack.broker.plist");
  });

  test("prints service-install reminder when broker plist is missing", () => {
    const fixture = prepareFixture();
    const output = runDeploy(fixture, { DEPLOY_TEST_BROKER_KICKSTART_FAIL: "1" });
    const commands = readFileSync(fixture.log, "utf-8");

    expect(output).toContain("broker deployed — no broker plist found, run 'wolfpack service install' first");
    expect(commands).not.toContain("launchctl bootstrap");
    expect(output).toContain("deployed and restarted");
  });
});
