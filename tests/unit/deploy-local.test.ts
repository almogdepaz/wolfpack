import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, type ExecFileSyncOptions, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
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
  mkdirSync(join(repo, "public"), { recursive: true });
  mkdirSync(join(home, ".wolfpack", "bin"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  cpSync(join(process.cwd(), "scripts", "deploy-local.sh"), join(repo, "scripts", "deploy-local.sh"));

  writeFileSync(join(repo, "dist", "wolfpack-darwin-arm64"), "server-arm64\n");
  writeFileSync(join(repo, "dist", "wolfpack-darwin-x64"), "server-x64\n");
  writeFileSync(join(repo, "dist", "wolfpack-broker"), "broker\n");
  writeFileSync(join(repo, "public", "app.bundle.js"), "fresh-app-bundle\n");
  writeFileSync(join(home, ".wolfpack", "config.json"), JSON.stringify({ port: 18790 }));
  writeFileSync(log, "");

  writeExecutable(join(bin, "bun"), "#!/bin/sh\necho \"bun $*\" >> \"$DEPLOY_TEST_LOG\"\nexit 0\n");
  writeExecutable(join(bin, "codesign"), "#!/bin/sh\necho \"codesign $*\" >> \"$DEPLOY_TEST_LOG\"\nexit 0\n");
  writeExecutable(join(bin, "launchctl"), `#!/bin/sh
echo "launchctl $*" >> "$DEPLOY_TEST_LOG"
STATE_DIR="$DEPLOY_TEST_STATE_DIR"
mkdir -p "$STATE_DIR"
case "$*" in
  "list")
    SERVER_PID="$DEPLOY_TEST_SERVER_OLD_PID"
    if [ -f "$STATE_DIR/server-kicked" ] && [ "$DEPLOY_TEST_SERVER_PID_STAYS" != "1" ]; then SERVER_PID="$DEPLOY_TEST_SERVER_NEW_PID"; fi
    BROKER_PID="$DEPLOY_TEST_BROKER_OLD_PID"
    if [ -f "$STATE_DIR/broker-kicked" ] && [ "$DEPLOY_TEST_BROKER_PID_STAYS" != "1" ]; then BROKER_PID="$DEPLOY_TEST_BROKER_NEW_PID"; fi
    echo "$BROKER_PID\t0\tcom.wolfpack.broker"
    echo "$SERVER_PID\t0\tcom.wolfpack.server"
    exit 0
    ;;
  *"kickstart -k"*"com.wolfpack.broker"*)
    if [ "$DEPLOY_TEST_BROKER_KICKSTART_FAIL" = "1" ]; then exit 1; fi
    touch "$STATE_DIR/broker-kicked"
    ;;
  *"kickstart -k"*"com.wolfpack.server"*)
    if [ "$DEPLOY_TEST_SERVER_KICKSTART_FAIL" = "1" ]; then exit 1; fi
    touch "$STATE_DIR/server-kicked"
    ;;
esac
exit 0
`);
  writeExecutable(join(bin, "curl"), `#!/bin/sh
echo "curl $*" >> "$DEPLOY_TEST_LOG"
if [ "$DEPLOY_TEST_STALE_ASSET" = "1" ]; then
  printf 'stale-app-bundle\n'
else
  cat "$DEPLOY_TEST_REPO/public/app.bundle.js"
fi
`);

  return { repo, home, log, bin };
}

function deployEnv(fixture: { readonly repo: string; readonly home: string; readonly log: string; readonly bin: string }, env: Record<string, string> = {}): ExecFileSyncOptions["env"] {
  return {
    ...process.env,
    HOME: fixture.home,
    PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
    DEPLOY_TEST_LOG: fixture.log,
    DEPLOY_TEST_REPO: fixture.repo,
    DEPLOY_TEST_STATE_DIR: join(tmpDir, "state"),
    DEPLOY_TEST_SERVER_OLD_PID: "111",
    DEPLOY_TEST_SERVER_NEW_PID: "222",
    DEPLOY_TEST_BROKER_OLD_PID: "333",
    DEPLOY_TEST_BROKER_NEW_PID: "444",
    DEPLOY_VERIFY_TIMEOUT_SECS: "1",
    ...env,
  };
}

function deployOptions(fixture: { readonly repo: string; readonly home: string; readonly log: string; readonly bin: string }, env: Record<string, string> = {}): ExecFileSyncOptionsWithStringEncoding {
  return {
    cwd: fixture.repo,
    encoding: "utf-8",
    env: deployEnv(fixture, env),
  };
}

function runDeploy(fixture: { readonly repo: string; readonly home: string; readonly log: string; readonly bin: string }, env: Record<string, string> = {}): string {
  return execFileSync("bash", [join(fixture.repo, "scripts", "deploy-local.sh")], deployOptions(fixture, env));
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

  test("fails when server kickstart leaves the old pid running", () => {
    const fixture = prepareFixture();

    expect(() => execFileSync(
      "bash",
      [join(fixture.repo, "scripts", "deploy-local.sh")],
      deployOptions(fixture, { DEPLOY_TEST_SERVER_PID_STAYS: "1" }),
    )).toThrow();

    const commands = readFileSync(fixture.log, "utf-8");
    expect(commands).toContain("launchctl kickstart -k");
    expect(commands).toContain("launchctl list");
  });

  test("fails when restarted server still serves stale app bundle", () => {
    const fixture = prepareFixture();

    expect(() => execFileSync(
      "bash",
      [join(fixture.repo, "scripts", "deploy-local.sh")],
      deployOptions(fixture, { DEPLOY_TEST_STALE_ASSET: "1" }),
    )).toThrow();

    const commands = readFileSync(fixture.log, "utf-8");
    expect(commands).toContain("curl --fail --silent --show-error http://127.0.0.1:18790/app.bundle.js");
  });
});
