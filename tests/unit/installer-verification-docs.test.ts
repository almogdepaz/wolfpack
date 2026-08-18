import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALLATION_PATH = "docs/installation.md";
const INSTALLER_PATH = "install.sh";
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
const WHAT_INSTALLER_DOES_HEADING = "## What the installer does";
const MANUAL_INSTALL_HEADING = "## Manual/audited install";

type ManualPlatform = "linux" | "macos";
type ChecksumFixture =
  | "exact"
  | "missing-server"
  | "missing-broker"
  | "malformed-hash"
  | "extra-field"
  | "duplicate-server"
  | "duplicate-broker"
  | "server-mismatch"
  | "broker-mismatch";

interface ManualInstallRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly trace: string;
  readonly actions: string;
  readonly fenceDispatches: readonly string[];
  readonly serverAsset: string;
  readonly brokerAsset: string;
  readonly serverBytes: string;
  readonly brokerBytes: string;
  readonly installedServerBytes: string | null;
  readonly installedBrokerBytes: string | null;
}

const CHECKSUM_FAILURE_CASES: readonly [ChecksumFixture, string][] = [
  ["missing-server", "a missing server entry"],
  ["missing-broker", "a missing broker entry"],
  ["malformed-hash", "a malformed hash entry"],
  ["extra-field", "a malformed field entry"],
  ["duplicate-server", "a duplicate server entry"],
  ["duplicate-broker", "a duplicate broker entry"],
  ["server-mismatch", "a server checksum mismatch"],
  ["broker-mismatch", "a broker checksum mismatch"],
];

function readRepositoryFile(path: string): string {
  return readFileSync(path, "utf8");
}

function h2Section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`${heading}\n`);
  expect(start).toBeGreaterThan(-1);
  const contentStart = start + heading.length + 1;
  const nextHeading = markdown.indexOf("\n## ", contentStart);
  return markdown.slice(contentStart, nextHeading < 0 ? markdown.length : nextHeading);
}

function shellBlocks(markdown: string): readonly string[] {
  const blocks: string[] = [];
  Bun.markdown.render(markdown, {
    code: (children, metadata) => {
      if (["bash", "sh", "shell"].includes(metadata?.language ?? "")) {
        blocks.push(children);
      }
      return children;
    },
  });
  return blocks;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function checksumFixture(
  fixture: ChecksumFixture,
  serverAsset: string,
  brokerAsset: string,
  serverBytes: string,
  brokerBytes: string,
): string {
  const serverLine = `${sha256(serverBytes)}  ${serverAsset}`;
  const brokerLine = `${sha256(brokerBytes)}  ${brokerAsset}`;
  const wrongHash = sha256("different release bytes");
  switch (fixture) {
    case "exact": return `${serverLine}\n${brokerLine}\n`;
    case "missing-server": return `${brokerLine}\n`;
    case "missing-broker": return `${serverLine}\n`;
    case "malformed-hash": return `not-a-sha256  ${serverAsset}\n${brokerLine}\n`;
    case "extra-field": return `${serverLine} unexpected\n${brokerLine}\n`;
    case "duplicate-server": return `${serverLine}\n${serverLine}\n${brokerLine}\n`;
    case "duplicate-broker": return `${serverLine}\n${brokerLine}\n${brokerLine}\n`;
    case "server-mismatch": return `${wrongHash}  ${serverAsset}\n${brokerLine}\n`;
    case "broker-mismatch": return `${serverLine}\n${wrongHash}  ${brokerAsset}\n`;
  }
}

function runManualInstallFixture(
  platform: ManualPlatform,
  checksumCase: ChecksumFixture,
): ManualInstallRun {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-manual-install-"));
  try {
    const home = join(root, "home");
    const controlledTmp = join(root, "tmp");
    const stubs = join(root, "stubs");
    const sources = join(root, "sources");
    mkdirSync(home, { recursive: true });
    mkdirSync(controlledTmp, { recursive: true });
    mkdirSync(stubs, { recursive: true });
    mkdirSync(sources, { recursive: true });

    const os = platform === "macos" ? "darwin" : "linux";
    const arch = platform === "macos" ? "arm64" : "x64";
    const serverAsset = `wolfpack-${os}-${arch}`;
    const brokerAsset = `wolfpack-broker-${os}-${arch}`;
    const serverBytes = "#!/bin/sh\nprintf 'setup:%s\\n' \"$*\" >> \"$ACTION_LOG\"\n";
    const brokerBytes = "#!/bin/sh\nexit 0\n";
    const serverSource = join(sources, serverAsset);
    const brokerSource = join(sources, brokerAsset);
    const checksumsSource = join(sources, "checksums-sha256.txt");
    const installerSource = join(sources, "install.sh");
    const workflowSource = join(sources, "release.yml");
    const actionLog = join(root, "actions.log");
    const fenceDispatchLog = join(root, "fence-dispatch.log");
    writeFileSync(serverSource, serverBytes);
    writeFileSync(brokerSource, brokerBytes);
    writeFileSync(checksumsSource, checksumFixture(
      checksumCase,
      serverAsset,
      brokerAsset,
      serverBytes,
      brokerBytes,
    ));
    writeFileSync(installerSource, "#!/bin/sh\n");
    writeFileSync(workflowSource, "name: controlled fixture\n");

    writeExecutable(join(stubs, "uname"), `#!/bin/sh
case "$1" in
  -s) printf '%s\\n' "$TEST_UNAME_SYSTEM" ;;
  -m) printf '%s\\n' "$TEST_UNAME_MACHINE" ;;
  *) exit 1 ;;
esac
`);
    writeExecutable(join(stubs, "curl"), `#!/bin/sh
output=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) shift; output="$1" ;;
    http*) url="$1" ;;
  esac
  shift
done
printf 'curl:%s\\n' "$url" >> "$ACTION_LOG"
case "$url" in
  */checksums-sha256.txt) cp "$CHECKSUM_SOURCE" "$output" ;;
  */wolfpack-broker-*) cp "$BROKER_SOURCE" "$output" ;;
  */wolfpack-*) cp "$SERVER_SOURCE" "$output" ;;
  */install.sh) cp "$INSTALLER_SOURCE" "$output" ;;
  */release.yml) cp "$WORKFLOW_SOURCE" "$output" ;;
  *) exit 22 ;;
esac
`);
    for (const command of ["xattr", "codesign", "gh"] as const) {
      writeExecutable(join(stubs, command), `#!/bin/sh
printf '${command}:%s\\n' "$*" >> "$ACTION_LOG"
`);
    }

    const manual = h2Section(
      readRepositoryFile(INSTALLATION_PATH),
      MANUAL_INSTALL_HEADING,
    );
    let versionSubstitutions = 0;
    const fencePaths = shellBlocks(manual).map((fence, index) => {
      const placeholder = "VERSION='vX.Y.Z'";
      const executableFence = fence.includes(placeholder)
        ? fence.replace(placeholder, "VERSION='v1.2.3'")
        : fence;
      if (executableFence !== fence) versionSubstitutions++;
      const fencePath = join(root, `manual-install-fence-${index + 1}.sh`);
      writeFileSync(fencePath, executableFence);
      return fencePath;
    });
    if (versionSubstitutions !== 1) {
      throw new Error(`expected one documented VERSION placeholder, found ${versionSubstitutions}`);
    }
    const driverPath = join(root, "manual-install-driver.sh");
    writeFileSync(driverPath, `#!/bin/sh
harness_fence_index=0
for harness_fence_path do
  harness_fence_index=$((harness_fence_index + 1))
  printf 'FENCE_START:%s\\n' "$harness_fence_index" >> "$FENCE_DISPATCH_LOG"
  . "$harness_fence_path"
  printf 'FENCE_END:%s\\n' "$harness_fence_index" >> "$FENCE_DISPATCH_LOG"
done
`);

    const execution = spawnSync("/bin/sh", ["-x", driverPath, ...fencePaths], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ACTION_LOG: actionLog,
        BROKER_SOURCE: brokerSource,
        CHECKSUM_SOURCE: checksumsSource,
        FENCE_DISPATCH_LOG: fenceDispatchLog,
        HOME: home,
        INSTALLER_SOURCE: installerSource,
        PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`,
        SERVER_SOURCE: serverSource,
        TEST_UNAME_MACHINE: platform === "macos" ? "arm64" : "x86_64",
        TEST_UNAME_SYSTEM: platform === "macos" ? "Darwin" : "Linux",
        TMPDIR: controlledTmp,
        WORKFLOW_SOURCE: workflowSource,
      },
    });
    const installedServer = join(home, ".wolfpack", "bin", "wolfpack");
    const installedBroker = join(home, ".wolfpack", "bin", "wolfpack-broker");
    return {
      status: execution.status,
      stdout: execution.stdout,
      trace: execution.stderr,
      actions: existsSync(actionLog) ? readFileSync(actionLog, "utf8") : "",
      fenceDispatches: existsSync(fenceDispatchLog)
        ? readFileSync(fenceDispatchLog, "utf8").trim().split("\n")
        : [],
      serverAsset,
      brokerAsset,
      serverBytes,
      brokerBytes,
      installedServerBytes: existsSync(installedServer)
        ? readFileSync(installedServer, "utf8")
        : null,
      installedBrokerBytes: existsSync(installedBroker)
        ? readFileSync(installedBroker, "utf8")
        : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function attestationLines(lines: readonly string[]): readonly string[] {
  return lines.filter(line => line.includes("attestation verify"));
}

describe("installer verification and provenance guidance", () => {
  test("places installer actions and the audited path beside the curl choice", () => {
    const installation = readRepositoryFile(INSTALLATION_PATH);
    const curlPath = installation.indexOf("### curl installer: persistent CLI");
    const installerActions = installation.indexOf(WHAT_INSTALLER_DOES_HEADING);
    const manualPath = installation.indexOf(MANUAL_INSTALL_HEADING);
    const setupChoices = installation.indexOf("## setup choices");

    expect(curlPath).toBeGreaterThan(-1);
    expect(installerActions).toBeGreaterThan(curlPath);
    expect(manualPath).toBeGreaterThan(installerActions);
    expect(manualPath).toBeLessThan(setupChoices);
  });

  test("describes the real installer and release workflow trust boundaries", () => {
    const installation = readRepositoryFile(INSTALLATION_PATH);
    const installer = readRepositoryFile(INSTALLER_PATH);
    const releaseWorkflow = readRepositoryFile(RELEASE_WORKFLOW_PATH);
    const actions = h2Section(installation, WHAT_INSTALLER_DOES_HEADING);

    for (const sourceFact of [
      'RELEASE_BASE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download"',
      'STAGING_DIR=$(mktemp -d "${INSTALL_DIR}/.install.XXXXXX")',
      'verify_checksum "$STAGED_WOLFPACK" "$TARGET" || exit 1',
      'verify_checksum "$STAGED_BROKER" "$BROKER_TARGET" || exit 1',
      'codesign --sign - --force "$artifact"',
      'exec "$MANAGED_BINARY" setup',
    ]) expect(installer).toContain(sourceFact);

    expect(releaseWorkflow).toContain("actions/attest-build-provenance@");
    expect(releaseWorkflow).toContain("dist/wolfpack-broker-darwin-arm64");
    expect(releaseWorkflow).toContain("dist/checksums-sha256.txt");

    for (const documentedFact of [
      "raw `main`",
      "latest GitHub Release",
      "~/.wolfpack/bin",
      "checksums-sha256.txt",
      "wolfpack-broker",
      "ad-hoc",
      "publisher identity",
      "`wolfpack service restart`",
      "broker",
    ]) expect(actions).toContain(documentedFact);
  });

  test("discloses the successful exec staging-retention boundary", () => {
    const installation = readRepositoryFile(INSTALLATION_PATH);
    const installer = readRepositoryFile(INSTALLER_PATH);
    const actions = h2Section(installation, WHAT_INSTALLER_DOES_HEADING);

    const trap = installer.indexOf("trap cleanup_staging EXIT");
    const serverMove = installer.indexOf('mv -f "$STAGED_WOLFPACK"');
    const brokerMove = installer.indexOf('mv -f "$STAGED_BROKER"');
    const setupExec = installer.indexOf('exec "$MANAGED_BINARY" setup');
    expect(trap).toBeGreaterThan(-1);
    expect(serverMove).toBeGreaterThan(trap);
    expect(brokerMove).toBeGreaterThan(serverMove);
    expect(setupExec).toBeGreaterThan(brokerMove);

    expect(actions).not.toContain("staging is removed on exit");
    for (const boundary of [
      "ordinary exits and failures",
      "replaces Bash",
      "private `.install.*`",
      "public release checksum list",
      "neither moved binary",
      "no installer is active",
    ]) expect(actions).toContain(boundary);
  });

  test("states the documented service and broker lifecycle boundaries", () => {
    const installation = readRepositoryFile(INSTALLATION_PATH);
    const readme = readRepositoryFile("README.md");

    for (const falseClaim of [
      "server restarts and upgrades do not kill your agents",
      "Upgrades restart only the server, preserving broker-owned sessions",
      "without intentionally restarting the broker",
      "neither path intentionally restarts the broker",
    ]) {
      expect(readme).not.toContain(falseClaim);
      expect(installation).not.toContain(falseClaim);
    }

    for (const boundary of [
      "file moves alone do not restart",
      "unqualified `wolfpack service restart`",
      "asks whether to restart the broker",
      "can terminate broker-owned sessions",
      "before the login-service choice",
      "re-register or start the broker service",
      "not guaranteed to preserve sessions",
      "especially on macOS",
      "external terminal",
      "decline broker restart",
      "decline service reinstallation",
      "verify sessions and service state afterward",
    ]) expect(installation).toContain(boundary);

    expect(readme).toContain("server-only restarts preserve them");
    expect(readme).toContain("decline the broker restart while active sessions matter");
    expect(readme).toContain("docs/installation.md#what-the-installer-does");
  });

  test("rejects duplicated server attestation evidence", () => {
    const server = "gh:attestation verify wolfpack-linux-x64 --repo almogdepaz/wolfpack";
    const broker = "gh:attestation verify wolfpack-broker-linux-x64 --repo almogdepaz/wolfpack";

    expect(attestationLines([server, server])).not.toEqual([server, broker]);
  });

  test("provides a fail-closed pinned command sequence for both exact binaries", () => {
    const manual = h2Section(
      readRepositoryFile(INSTALLATION_PATH),
      MANUAL_INSTALL_HEADING,
    );
    const fences = shellBlocks(manual);
    expect(fences).toHaveLength(3);
    const commands = fences.join("\n");
    for (const shell of ["sh", "bash"]) {
      const syntax = spawnSync(shell, ["-n"], {
        encoding: "utf8",
        input: commands,
      });
      expect(syntax.status, syntax.stderr).toBe(0);
    }
    expect(commands).toContain("VERSION='vX.Y.Z'");
    expect(commands).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
    expect(commands).toContain("releases/download/$VERSION");
    expect(commands).not.toContain("releases/latest");
    expect(commands).toContain('SERVER_ASSET="wolfpack-$TARGET"');
    expect(commands).toContain('BROKER_ASSET="wolfpack-broker-$TARGET"');
    expect(commands).toContain('CHECKSUM_FILE="checksums-sha256.txt"');
    expect(commands).toContain('shasum -a 256 --check "$SELECTED_CHECKSUMS"');
    expect(commands).toContain('sha256sum --check "$SELECTED_CHECKSUMS"');
    const documentedCommandLines = fences.flatMap(fence => fence.split("\n"));
    expect(attestationLines(documentedCommandLines)).toEqual([
      'gh attestation verify "$SERVER_ASSET" --repo almogdepaz/wolfpack',
      'gh attestation verify "$BROKER_ASSET" --repo almogdepaz/wolfpack',
    ]);

    const checksumSelection = commands.indexOf("selected-checksums-sha256.txt");
    const macVerification = commands.indexOf("shasum -a 256 --check");
    const linuxVerification = commands.indexOf("sha256sum --check");
    const signing = commands.indexOf("codesign --sign - --force");
    const firstMove = commands.indexOf('mv -f "$SERVER_ASSET"');
    const setup = commands.indexOf('"$INSTALL_DIR/wolfpack" setup');
    expect(checksumSelection).toBeGreaterThan(-1);
    expect(macVerification).toBeGreaterThan(checksumSelection);
    expect(linuxVerification).toBeGreaterThan(checksumSelection);
    expect(signing).toBeGreaterThan(macVerification);
    expect(firstMove).toBeGreaterThan(signing);
    expect(setup).toBeGreaterThan(firstMove);
    expect(commands).not.toContain('./$SERVER_ASSET');
    expect(commands).not.toContain('./$BROKER_ASSET');
  });

  for (const platform of ["linux", "macos"] as const) {
    test(`executes exact manual install entries on ${platform}`, () => {
      const run = runManualInstallFixture(platform, "exact");

      expect(run.status, run.trace).toBe(0);
      expect(run.stdout).toContain(`${run.serverAsset}: OK`);
      expect(run.stdout).toContain(`${run.brokerAsset}: OK`);
      expect(run.installedServerBytes).toBe(run.serverBytes);
      expect(run.installedBrokerBytes).toBe(run.brokerBytes);
      expect(attestationLines(run.actions.split("\n"))).toEqual([
        `gh:attestation verify ${run.serverAsset} --repo almogdepaz/wolfpack`,
        `gh:attestation verify ${run.brokerAsset} --repo almogdepaz/wolfpack`,
      ]);
      expect(run.actions).toContain("setup:setup");
      expect(run.fenceDispatches).toEqual([
        "FENCE_START:1",
        "FENCE_END:1",
        "FENCE_START:2",
        "FENCE_END:2",
        "FENCE_START:3",
        "FENCE_END:3",
      ]);

      const verification = run.trace.indexOf(platform === "macos"
        ? "+ shasum -a 256 --check selected-checksums-sha256.txt"
        : "+ sha256sum --check selected-checksums-sha256.txt");
      const chmod = run.trace.indexOf("+ chmod +x ");
      const firstMove = run.trace.indexOf("+ mv -f ");
      const setup = run.trace.indexOf("/wolfpack setup");
      expect(verification).toBeGreaterThan(-1);
      expect(chmod).toBeGreaterThan(verification);
      expect(firstMove).toBeGreaterThan(chmod);
      expect(run.trace.match(/^\++ mv -f /gm) ?? []).toHaveLength(2);
      expect(setup).toBeGreaterThan(firstMove);

      if (platform === "macos") {
        const firstSign = run.trace.indexOf("+ codesign --sign - --force ");
        expect(firstSign).toBeGreaterThan(chmod);
        expect(firstMove).toBeGreaterThan(firstSign);
        expect(run.actions.match(/^xattr:/gm) ?? []).toHaveLength(2);
        expect(run.actions.match(/^codesign:/gm) ?? []).toHaveLength(2);
      } else {
        expect(run.trace).not.toContain("+ codesign ");
        expect(run.actions).not.toContain("codesign:");
      }
    });
  }

  for (const [checksumCase, label] of CHECKSUM_FAILURE_CASES) {
    test(`fails closed for ${label}`, () => {
      const run = runManualInstallFixture("linux", checksumCase);

      expect(run.status).not.toBe(0);
      expect(run.installedServerBytes).toBeNull();
      expect(run.installedBrokerBytes).toBeNull();
      expect(run.fenceDispatches).toEqual(["FENCE_START:1"]);
      expect(run.trace).not.toMatch(/^\++ chmod /m);
      expect(run.trace).not.toMatch(/^\++ codesign /m);
      expect(run.trace).not.toMatch(/^\++ mv -f /m);
      expect(run.trace).not.toMatch(/^\++ .*\/wolfpack setup$/m);
      for (const action of ["gh:", "xattr:", "codesign:", "setup:"]) {
        expect(run.actions).not.toContain(action);
      }
      expect(run.actions.trim().split("\n").every(action => action.startsWith("curl:"))).toBe(true);
    });
  }

  test("links provenance authorities without duplicating the audited path", () => {
    const installation = readRepositoryFile(INSTALLATION_PATH);
    const readme = readRepositoryFile("README.md");
    const router = readRepositoryFile("docs/README.md");

    for (const url of [
      "https://github.com/almogdepaz/wolfpack/releases",
      "https://github.com/almogdepaz/wolfpack/releases/latest/download/checksums-sha256.txt",
      "https://github.com/almogdepaz/wolfpack/blob/main/install.sh",
      "https://github.com/almogdepaz/wolfpack/blob/main/.github/workflows/release.yml",
      "https://cli.github.com/manual/gh_attestation_verify",
    ]) expect(installation).toContain(url);

    expect(readme).not.toContain(WHAT_INSTALLER_DOES_HEADING);
    expect(readme).not.toContain(MANUAL_INSTALL_HEADING);
    expect(router).not.toContain(WHAT_INSTALLER_DOES_HEADING);
    expect(router).not.toContain(MANUAL_INSTALL_HEADING);
    expect(readme).toContain("docs/installation.md");
    expect(router).toContain("installation.md");
  });
});
