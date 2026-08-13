import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

// These tests exercise the full deploy shell script repeatedly. Parallel CI load can
// push otherwise healthy 2–5 second cases beyond Bun's 5 second default.
setDefaultTimeout(15_000);
import { execFileSync, type ExecFileSyncOptions, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  const serverFixture = `#!/bin/sh
echo "wolfpack $*" >> "$DEPLOY_TEST_LOG"
if [ "$*" = "session open --help" ]; then
  echo "Usage: wolfpack session open <project>"
  exit 0
fi
exit 1
`;
  writeExecutable(join(repo, "dist", "wolfpack-darwin-arm64"), serverFixture);
  writeExecutable(join(repo, "dist", "wolfpack-darwin-x64"), serverFixture);
  writeFileSync(join(repo, "dist", "wolfpack-broker"), "broker\n");
  writeFileSync(join(repo, "public", "app.bundle.js"), "fresh-app-bundle\n");
  writeFileSync(join(home, ".wolfpack", "bin", "wolfpack-broker"), "installed-broker\n");
  writeFileSync(join(home, ".wolfpack", "config.json"), JSON.stringify({ port: 18790 }));
  writeFileSync(log, "");

  writeExecutable(join(bin, "uname"), `#!/bin/sh
case "$1" in
  -s) printf '%s\\n' "\${DEPLOY_TEST_OS:-Darwin}" ;;
  -m) printf 'arm64\\n' ;;
esac
`);
  writeExecutable(join(bin, "bun"), "#!/bin/sh\necho \"bun $* build-server-only=${WOLFPACK_BUILD_SERVER_ONLY:-}\" >> \"$DEPLOY_TEST_LOG\"\nexit 0\n");
  writeExecutable(join(bin, "codesign"), "#!/bin/sh\necho \"codesign $*\" >> \"$DEPLOY_TEST_LOG\"\nexit 0\n");
  writeExecutable(join(bin, "mv"), `#!/bin/sh
echo "mv $*" >> "$DEPLOY_TEST_LOG"
/bin/mv "$@"
for destination do :; done
if [ "$DEPLOY_TEST_CORRUPT_INSTALL" = "1" ] && [ "$destination" = "$HOME/.wolfpack/bin/wolfpack" ]; then
  printf 'corrupt\n' >> "$destination"
fi
`);
  writeExecutable(join(bin, "launchctl"), `#!/bin/sh
echo "launchctl $*" >> "$DEPLOY_TEST_LOG"
STATE_DIR="$DEPLOY_TEST_STATE_DIR"
mkdir -p "$STATE_DIR"
case "$*" in
  "list")
    SERVER_PID="$DEPLOY_TEST_SERVER_OLD_PID"
    if { [ -f "$STATE_DIR/server-kicked" ] || [ -f "$STATE_DIR/server-bootstrapped" ]; } && [ "$DEPLOY_TEST_SERVER_PID_STAYS" != "1" ]; then
      SERVER_PID="$DEPLOY_TEST_SERVER_NEW_PID"
      if [ -n "$DEPLOY_TEST_SERVER_REPLACEMENT_PID" ]; then
        if [ -f "$STATE_DIR/server-first-pid-reported" ]; then
          SERVER_PID="$DEPLOY_TEST_SERVER_REPLACEMENT_PID"
        else
          touch "$STATE_DIR/server-first-pid-reported"
        fi
      fi
    fi
    BROKER_PID="$DEPLOY_TEST_BROKER_OLD_PID"
    if { [ -f "$STATE_DIR/broker-kicked" ] || [ -f "$STATE_DIR/broker-bootstrapped" ]; } && [ "$DEPLOY_TEST_BROKER_PID_STAYS" != "1" ]; then BROKER_PID="$DEPLOY_TEST_BROKER_NEW_PID"; fi
    if [ -f "$STATE_DIR/server-kicked" ] && [ "$DEPLOY_TEST_BROKER_PID_CHANGES_ON_SERVER_RESTART" = "1" ]; then BROKER_PID="$DEPLOY_TEST_BROKER_NEW_PID"; fi
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
  *"bootout"*"com.wolfpack.broker"*)
    rm -f "$STATE_DIR/broker-kicked" "$STATE_DIR/broker-bootstrapped"
    touch "$STATE_DIR/broker-bootout-pending"
    ;;
  *"bootout"*"com.wolfpack.server"*)
    rm -f "$STATE_DIR/server-kicked" "$STATE_DIR/server-bootstrapped"
    touch "$STATE_DIR/server-bootout-pending"
    ;;
  *"print"*"com.wolfpack.broker"*)
    if [ -f "$STATE_DIR/broker-bootout-pending" ]; then
      if [ ! -f "$STATE_DIR/broker-bootout-observed" ]; then
        touch "$STATE_DIR/broker-bootout-observed"
        exit 0
      fi
      rm -f "$STATE_DIR/broker-bootout-pending"
      exit 1
    fi
    ;;
  *"print"*"com.wolfpack.server"*)
    if [ -f "$STATE_DIR/server-bootout-pending" ]; then
      if [ ! -f "$STATE_DIR/server-bootout-observed" ]; then
        touch "$STATE_DIR/server-bootout-observed"
        exit 0
      fi
      rm -f "$STATE_DIR/server-bootout-pending"
      exit 1
    fi
    ;;
  *"bootstrap"*"com.wolfpack.broker.plist"*)
    if [ -f "$STATE_DIR/broker-bootout-pending" ]; then exit 37; fi
    touch "$STATE_DIR/broker-bootstrapped"
    ;;
  *"bootstrap"*"com.wolfpack.server.plist"*)
    if [ -f "$STATE_DIR/server-bootout-pending" ]; then exit 37; fi
    touch "$STATE_DIR/server-bootstrapped"
    ;;
esac
exit 0
`);
  writeExecutable(join(bin, "curl"), `#!/bin/sh
echo "curl $*" >> "$DEPLOY_TEST_LOG"
case "$*" in
  *"/app.bundle.js"*)
    if [ "$DEPLOY_TEST_STALE_ASSET" = "1" ]; then
      printf 'stale-app-bundle\n'
    else
      cat "$DEPLOY_TEST_REPO/public/app.bundle.js"
    fi
    ;;
  *"/api/info"*)
    printf '{"name":"test-host","version":"1.2.3"}\n'
    ;;
  *"/api/sessions"*)
    if [ "$DEPLOY_TEST_DROP_SESSION" = "1" ] && [ -f "$DEPLOY_TEST_STATE_DIR/server-kicked" ]; then
      printf '{"sessions":[{"name":"alpha","identity":{"wolfpackSessionId":"id-alpha"}}]}\n'
    else
      printf '{"sessions":[{"name":"alpha","identity":{"wolfpackSessionId":"id-alpha"}},{"name":"beta","identity":{"wolfpackSessionId":"id-beta"}}]}\n'
    fi
    ;;
  *)
    echo "unexpected curl request" >&2
    exit 1
    ;;
esac
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
    DEPLOY_TEST_DROP_SESSION: "0",
    DEPLOY_TEST_STALE_ASSET: "0",
    DEPLOY_TEST_BROKER_PID_STAYS: "0",
    DEPLOY_TEST_SERVER_PID_STAYS: "0",
    DEPLOY_TEST_SERVER_REPLACEMENT_PID: "",
    DEPLOY_TEST_BROKER_KICKSTART_FAIL: "0",
    DEPLOY_TEST_SERVER_KICKSTART_FAIL: "0",
    DEPLOY_TEST_BROKER_PID_CHANGES_ON_SERVER_RESTART: "0",
    DEPLOY_TEST_CORRUPT_INSTALL: "0",
    DEPLOY_TEST_OS: "Darwin",
    DEPLOY_VERIFY_TIMEOUT_SECS: "1",
    WOLFPACK_DEPLOY_ALLOW_NONINTERACTIVE: "1",
    WOLFPACK_SESSION_NAME: "",
    WOLFPACK_AGENT_KIND: "",
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

function runDeploy(
  fixture: { readonly repo: string; readonly home: string; readonly log: string; readonly bin: string },
  broker: "yes" | "no" | undefined,
  env: Record<string, string> = {},
): string {
  const args = broker === undefined ? [] : [`--broker=${broker}`];
  return execFileSync("/bin/bash", [join(fixture.repo, "scripts", "deploy-local.sh"), ...args], deployOptions(fixture, env));
}

beforeEach(() => {
  tmpDir = "";
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("scripts/deploy-local.sh", () => {
  test("requires an explicit broker deployment mode before mutation", () => {
    const fixture = prepareFixture();

    expect(() => runDeploy(fixture, undefined)).toThrow();
    expect(readFileSync(fixture.log, "utf-8")).toBe("");
  });

  test("rejects invalid broker deployment modes before mutation", () => {
    const fixture = prepareFixture();

    expect(() => execFileSync(
      "/bin/bash",
      [join(fixture.repo, "scripts", "deploy-local.sh"), "--broker=auto"],
      deployOptions(fixture),
    )).toThrow();
    expect(readFileSync(fixture.log, "utf-8")).toBe("");
  });

  test("rejects non-macos hosts before mutation", () => {
    const fixture = prepareFixture();

    expect(() => runDeploy(fixture, "no", { DEPLOY_TEST_OS: "Linux" })).toThrow();
    expect(readFileSync(fixture.log, "utf-8")).toBe("");
  });

  test("rejects broker replacement from a broker-owned session before mutation", () => {
    const fixture = prepareFixture();

    expect(() => runDeploy(fixture, "yes", {
      WOLFPACK_SESSION_NAME: "dev08-qa",
      WOLFPACK_AGENT_KIND: "pi",
    })).toThrow();
    expect(readFileSync(fixture.log, "utf-8")).toBe("");
  });

  test("rejects noninteractive broker replacement without explicit override before mutation", () => {
    const fixture = prepareFixture();

    expect(() => runDeploy(fixture, "yes", {
      WOLFPACK_DEPLOY_ALLOW_NONINTERACTIVE: "0",
    })).toThrow();
    expect(readFileSync(fixture.log, "utf-8")).toBe("");
  });

  test("rejects concurrent deploys before mutation", () => {
    const fixture = prepareFixture();
    mkdirSync(join(fixture.home, ".wolfpack", "deploy.lock"));

    expect(() => runDeploy(fixture, "no")).toThrow();
    expect(readFileSync(fixture.log, "utf-8")).toBe("");
  });

  test("preserves the installed broker and broker service in broker=no mode", () => {
    const fixture = prepareFixture();

    const output = runDeploy(fixture, "no");
    const commands = readFileSync(fixture.log, "utf-8");

    expect(readFileSync(join(fixture.home, ".wolfpack", "bin", "wolfpack-broker"), "utf-8")).toBe("installed-broker\n");
    expect(commands).toContain("build-server-only=1");
    expect(commands).not.toContain("com.wolfpack.broker");
    expect(output).toContain("\"brokerDeployed\":false");
  });

  test("fails before service restart when the installed artifact hash changes", () => {
    const fixture = prepareFixture();

    expect(() => runDeploy(fixture, "no", { DEPLOY_TEST_CORRUPT_INSTALL: "1" })).toThrow();

    const commands = readFileSync(fixture.log, "utf-8");
    expect(commands).not.toContain("launchctl kickstart");
  });

  test("fails broker=no deployment when the broker pid changes", () => {
    const fixture = prepareFixture();

    expect(() => runDeploy(fixture, "no", { DEPLOY_TEST_BROKER_PID_CHANGES_ON_SERVER_RESTART: "1" })).toThrow();
  });

  test("fails broker=no deployment when a pre-existing session identity disappears", () => {
    const fixture = prepareFixture();

    expect(() => runDeploy(fixture, "no", { DEPLOY_TEST_DROP_SESSION: "1" })).toThrow();
  });

  test("verifies installed artifact, API health, CLI help, and preserved sessions", () => {
    const fixture = prepareFixture();

    const output = runDeploy(fixture, "no");
    const commands = readFileSync(fixture.log, "utf-8");

    expect(commands).toContain("/api/info");
    expect(commands).toContain("/api/sessions");
    expect(commands).toContain("wolfpack session open --help");
    expect(commands).toMatch(/codesign -f -s - .*wolfpack\.new\./);
    expect(output).toContain("\"preservedSessions\":2");
    expect(output).toContain("\"serverVersion\":\"1.2.3\"");
    expect(output).toMatch(/\"serverHash\":\"[0-9a-f]{64}\"/);
  });

  test("restarts broker before restarting server when broker binary is deployed", () => {
    const fixture = prepareFixture();
    const output = runDeploy(fixture, "yes");
    const commands = readFileSync(fixture.log, "utf-8");

    expect(commands).toContain("build-server-only=");
    expect(commands).not.toContain("build-server-only=1");
    expect(readFileSync(join(fixture.home, ".wolfpack", "bin", "wolfpack-broker"), "utf-8")).toBe("broker\n");
    expect(output).toContain("broker restarted");
    expect(output).toContain("server restarted");
    expect(output).toMatch(/\"brokerHash\":\"[0-9a-f]{64}\"/);
    expect(output).toContain("\"preservedSessions\":null");
    expect(commands.indexOf("com.wolfpack.broker")).toBeGreaterThan(-1);
    expect(commands.indexOf("com.wolfpack.server")).toBeGreaterThan(-1);
    expect(commands.indexOf("com.wolfpack.broker")).toBeLessThan(commands.indexOf("com.wolfpack.server"));
  });

  test("reloads an installed broker to refresh launch constraints", () => {
    const fixture = prepareFixture();
    const launchAgents = join(fixture.home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(join(launchAgents, "com.wolfpack.broker.plist"), "plist\n");

    const output = runDeploy(fixture, "yes");
    const commands = readFileSync(fixture.log, "utf-8");

    expect(output).toContain("broker reloaded");
    expect(commands).toContain("launchctl bootout");
    expect(commands).toContain("launchctl bootstrap");
    expect(commands).not.toMatch(/launchctl kickstart -k .*com\.wolfpack\.broker/);
    expect(commands).toContain("com.wolfpack.broker.plist");
  });

  test("fails verification when broker service cannot restart or bootstrap", () => {
    const fixture = prepareFixture();

    expect(() => runDeploy(fixture, "yes", { DEPLOY_TEST_BROKER_KICKSTART_FAIL: "1" })).toThrow();

    const commands = readFileSync(fixture.log, "utf-8");
    expect(commands).not.toContain("launchctl bootstrap");
    expect(commands).not.toContain("com.wolfpack.server");
  });

  test("fails when server kickstart leaves the old pid running", () => {
    const fixture = prepareFixture();

    expect(() => execFileSync(
      "/bin/bash",
      [join(fixture.repo, "scripts", "deploy-local.sh"), "--broker=yes"],
      deployOptions(fixture, { DEPLOY_TEST_SERVER_PID_STAYS: "1" }),
    )).toThrow();

    const commands = readFileSync(fixture.log, "utf-8");
    expect(commands).toContain("launchctl kickstart -k");
    expect(commands).toContain("launchctl list");
  });

  test("keeps the deploy lock after a failed mutating broker deployment", () => {
    const fixture = prepareFixture();
    const lockPath = join(fixture.home, ".wolfpack", "deploy.lock");

    expect(() => runDeploy(fixture, "yes", { DEPLOY_TEST_SERVER_PID_STAYS: "1" })).toThrow();
    expect(existsSync(lockPath)).toBe(true);

    writeFileSync(fixture.log, "");
    expect(() => runDeploy(fixture, "yes")).toThrow();
    expect(readFileSync(fixture.log, "utf-8")).toBe("");
  });

  test("fails when the first replacement server dies before verification completes", () => {
    const fixture = prepareFixture();

    expect(() => runDeploy(fixture, "no", {
      DEPLOY_TEST_SERVER_REPLACEMENT_PID: "555",
    })).toThrow();
  });

  test("fails when restarted server still serves stale app bundle", () => {
    const fixture = prepareFixture();

    expect(() => execFileSync(
      "/bin/bash",
      [join(fixture.repo, "scripts", "deploy-local.sh"), "--broker=yes"],
      deployOptions(fixture, { DEPLOY_TEST_STALE_ASSET: "1" }),
    )).toThrow();

    const commands = readFileSync(fixture.log, "utf-8");
    expect(commands).toContain("curl --connect-timeout 1 --max-time 2 --fail --silent --show-error http://127.0.0.1:18790/app.bundle.js");
  });

  test("bounds each served-bundle verification request", () => {
    const fixture = prepareFixture();
    runDeploy(fixture, "yes");

    const commands = readFileSync(fixture.log, "utf-8");
    expect(commands).toContain("curl --connect-timeout 1 --max-time 2 --fail --silent --show-error http://127.0.0.1:18790/app.bundle.js");
  });

  test("reloads an installed server before verifying fresh assets", () => {
    const fixture = prepareFixture();
    const launchAgents = join(fixture.home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(join(launchAgents, "com.wolfpack.server.plist"), "plist\n");

    const output = runDeploy(fixture, "yes");
    const commands = readFileSync(fixture.log, "utf-8");

    expect(output).toContain("server reloaded");
    expect(commands).toContain("launchctl bootout");
    expect(commands).toContain("launchctl bootstrap");
    expect(commands).not.toMatch(/launchctl kickstart -k .*com\.wolfpack\.server/);
    expect(commands).toContain("com.wolfpack.server.plist");
    expect(commands).toContain("curl --connect-timeout 1 --max-time 2 --fail --silent --show-error http://127.0.0.1:18790/app.bundle.js");
  });
});
