import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_INTEGRATION_PACKAGES,
  acceptsPiIntegrationInstall,
  installPiIntegration,
  piIntegrationDisclosureLines,
  planPiIntegrationSetup,
} from "../../src/cli/pi-integration.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "wolfpack-pi-integration-"));
  tempDirs.push(directory);
  return directory;
}

function fakePi(): { readonly pathValue: string; readonly callLog: string } {
  const directory = tempDir();
  const executable = join(directory, "pi");
  const callLog = join(directory, "calls.log");
  writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
if [ "\${FAIL_SOURCE:-}" = "$2" ]; then
  exit 42
fi
`);
  chmodSync(executable, 0o755);
  return { pathValue: directory, callLog };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Pi integration setup", () => {
  test("hides the integration for users without Pi", () => {
    expect(planPiIntegrationSetup(tempDir(), true)).toBe("hidden");
    expect(planPiIntegrationSetup(undefined, false)).toBe("hidden");
  });

  test("prompts interactive Pi users and only prints guidance without a TTY", () => {
    const pi = fakePi();

    expect(planPiIntegrationSetup(pi.pathValue, true)).toBe("prompt");
    expect(planPiIntegrationSetup(pi.pathValue, false)).toBe("guidance");
  });

  test("installs only Pi Tasks and directs Wolfpack skill installation to the repository", () => {
    const disclosure = piIntegrationDisclosureLines().join("\n");

    expect(disclosure).toContain("pi install npm:@sgtbeatdown/pi-tasks");
    expect(disclosure).not.toContain("npm:wolfpack-bridge");
    expect(disclosure).toContain("Install wolfpack-tailnet-control manually");
    expect(disclosure).toContain("user permissions");
    expect(disclosure).toContain("Review");
  });

  test("keeps the integration default-no", () => {
    expect(acceptsPiIntegrationInstall("y")).toBe(true);
    expect(acceptsPiIntegrationInstall("Y")).toBe(true);
    expect(acceptsPiIntegrationInstall("")).toBe(false);
    expect(acceptsPiIntegrationInstall("n")).toBe(false);
    expect(acceptsPiIntegrationInstall("yes")).toBe(false);
  });

  test("installs only the Pi Tasks extension", () => {
    const pi = fakePi();
    const result = installPiIntegration({
      pathValue: pi.pathValue,
      env: { CALL_LOG: pi.callLog },
    });

    expect(result).toEqual({
      status: "installed",
      installedSources: PI_INTEGRATION_PACKAGES,
    });
    expect(readFileSync(pi.callLog, "utf8")).toBe("install npm:@sgtbeatdown/pi-tasks\n");
  });

  test("reports a retry command when Pi Tasks installation fails", () => {
    const pi = fakePi();
    const result = installPiIntegration({
      pathValue: pi.pathValue,
      env: {
        CALL_LOG: pi.callLog,
        FAIL_SOURCE: "npm:@sgtbeatdown/pi-tasks",
      },
    });

    expect(result).toEqual({
      status: "failed",
      installedSources: [],
      failedSource: "npm:@sgtbeatdown/pi-tasks",
      retryCommand: "pi install npm:@sgtbeatdown/pi-tasks",
    });
    expect(readFileSync(pi.callLog, "utf8")).toBe("install npm:@sgtbeatdown/pi-tasks\n");
  });
});
